/**
 * ProCut (CutCutPro) — GPT-first / Claude-verify cutting pipeline.
 *
 *   Phase 1  TRANSCRIBE with OpenAI whisper-1 (VERBATIM, word-timestamped) so
 *            every repeated take / stutter is present to be located. Falls back
 *            to local whisper.cpp when there's no OpenAI key, and reuses an
 *            existing transcript when the project already has one. + Silero VAD
 *            for pauses -> index-anchored TimestampMap.
 *   Phase 2  GPT FIRST PASS listens to the audio (gpt-audio) and proposes the
 *            cuts: remove repeated takes (KEEP ONLY THE LAST clean take),
 *            stutters, double-spoken words, and dead-air pauses. gpt-5 text
 *            fallback when audio can't be attached.
 *   Phase 3  Claude (claude-opus-4-8) SECOND PASS verifies + finalizes: re-scans
 *            the whole transcript for ANY surviving repeat, guarantees only the
 *            LAST take of each duplicate remains, and that the kept words still
 *            read as one coherent script.
 *   Phase 4  The final EDL resolves onto the EXISTING edit model (deleted words +
 *            silence regions -> computeKeepRanges); staged for REVIEW and applied
 *            when the user presses Execute cuts. Nothing else changes.
 *
 * Additive: separate module + button; the standard engines are untouched.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFile, unlink, mkdir, writeFile, stat } from 'fs/promises'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { randomUUID } from 'crypto'
import { FFMPEG } from './binaries'
import { transcribe } from './whisper'
import { transcribeOpenAI } from './openai-transcribe'
import { claudeAvailable, getAnthropic } from './claude'
import { openaiAvailable, getOpenAI } from './openai'
import {
  buildTimestampMap,
  buildAiPayload,
  validateEdl,
  refineEdl,
  edlToEdits,
  type Edl,
  type TimestampMap,
  type CutCutProDebug,
  type CutCutProResult
} from '../shared/cutcutpro'
import type { Transcript } from '../shared/types'

const execFileP = promisify(execFile)

// Claude verifies/finalizes (second pass). gpt-4o-audio-preview is retired
// (404s); try the current audio models in order, first the account has wins.
const CLAUDE_MODEL = 'claude-opus-4-8'
const OPENAI_AUDIO_MODELS = ['gpt-audio', 'gpt-audio-1.5', 'gpt-audio-mini', 'gpt-4o-audio-preview']
const OPENAI_TEXT_MODEL = 'gpt-5'
const MAX_AUDIO_BYTES = 18 * 1024 * 1024 // keep the base64 payload well under API limits

const EDL_SHAPE = `Reply with VALID JSON ONLY (no prose, no markdown fences), exactly:
{"word_cuts":[{"from":12,"to":18,"reason":"earlier take of this line; kept the later one"}],
 "pause_cuts":[{"pause_id":"p3","keep_ms":150,"reason":"dead air; keep a beat"}]}
word_cuts use INCLUSIVE word indices from the list. pause_cuts reference pause ids; keep_ms=0 removes the pause entirely, otherwise that many ms remain.`

const GPT_FIRST_SYSTEM = `You are the FIRST PASS of a two-pass professional video cutting pipeline. The pipeline's GOAL is a clean video with ZERO repeated content, where the words that remain still read as one coherent script. You are given an index-anchored VERBATIM transcript (word indices, exact pause markers, fillers and stutters flagged) and you can HEAR the attached audio.

Propose the cuts:
- REPEATED TAKES / RESTARTS: whenever the speaker says the same sentence or line more than once (retakes, false starts, "let me say that again"), CUT EVERY EARLIER ATTEMPT AND KEEP ONLY THE LAST take — opening words of the earlier takes included. Never leave two copies of the same line. The LAST occurrence in time ALWAYS survives: even when an earlier take sounds just as clean, cut the earlier one and keep the final one.
- PRODUCTION ARTIFACTS (not meant for the published video — cut them ALL):
  * slates / count-ins / take markers: "skip 10, hook one", "take three", clapper words, counting down;
  * the speaker talking ABOUT the recording instead of TO the audience: planning a take out loud ("Okay, I'm gonna walk in. I'm gonna say…"), directing someone off-camera ("can you focus"), reacting to a flubbed take ("ugh, again");
  * session wrap markers at the very start or end: "okay, that's it", "cut", "that's the take", "we're rolling".
  BUT keep audience-facing lines that merely sound similar: an outro spoken TO viewers ("that's it for today, thanks for watching") is content, not a wrap marker. Use the audio delivery to tell them apart.
- STUTTERS & DOUBLE-SPOKEN WORDS: cut the stuttered or duplicated words, leaving one clean instance.
- DEAD-AIR PAUSES: remove or hard-trim silent pauses; keep only natural sentence rhythm and deliberate dramatic beats.
HARD RULES:
- CUT WHOLE TAKES ONLY: a retake cut runs from the earlier take's FIRST word up to the word right before the surviving take begins. NEVER splice takes — never keep the first half of one take joined to the second half of another, and never start or end a cut in the middle of a sentence.
- THE ONLY COPY OF AN IDEA IS UNTOUCHABLE: verbal mistakes, awkward wording, hedges, filler words and small stumbles INSIDE the only take of a line stay in the video. You are not a line editor — if there is no later take of the same line, do not cut anything from it (a pure stutter duplicate like "the the" is the sole exception).
- Do NOT cut deliberate rhetorical repetition (emphasis). When in doubt, KEEP.

${EDL_SHAPE}`

const CLAUDE_VERIFY_SYSTEM = `You are the SECOND PASS (verification + finalization) of a professional video cutting pipeline. GOAL: after your cuts the kept transcript must contain ZERO repeated sentences/lines and read as one coherent script. You receive the index-anchored VERBATIM transcript map and the FIRST PASS's proposed EDL.

Finalize it:
- Re-scan the WHOLE transcript for any repeated take or line the first pass missed or only partially cut. For every group of duplicate takes, make sure ONLY THE LAST take survives — the last occurrence IN TIME, never an earlier one, even if the earlier take reads cleaner. Add or extend word_cuts to delete the earlier copies ENTIRELY (their opening words included).
- Remove any PRODUCTION ARTIFACTS the first pass missed: slates/count-ins/take markers ("skip 10, hook one", "take three"), the speaker talking ABOUT the recording instead of TO the audience (planning a take out loud, directing someone off-camera), and session wrap markers at the very start/end ("okay, that's it", "cut"). Audience-facing outros ("that's it for today, thanks for watching") are content — keep them.
- Remove any leftover stutters or double-spoken words.
- Never leave a broken or dangling half-sentence: the words that remain must flow as a script.
- CUT WHOLE TAKES ONLY: retake cuts run from the earlier take's first word to the word before the surviving take begins — never splice half of one take onto half of another; never start or end a cut mid-sentence. REMOVE any first-pass cut that violates this by EXTENDING it to the full take boundary.
- THE ONLY COPY of an idea is untouchable: verbal mistakes, hedges and filler words inside the only take of a line are NOT cuts — DELETE any first-pass cut whose reason is just "filler"/"cleaner delivery"/"incomplete thought" unless a later take of the same line survives.
- Keep the first pass's correct cuts; only add/adjust what's needed to reach zero repeats.
- If the proposed EDL is empty, perform the full analysis yourself.
Return the DEFINITIVE final EDL (same ids/indices; your reply FULLY REPLACES the proposal).

${EDL_SHAPE}`

async function extractMp3(path: string): Promise<string> {
  const out = join(tmpdir(), `ccp-${randomUUID()}.mp3`)
  await execFileP(FFMPEG, ['-y', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', out])
  return out
}

type Choices = { choices?: { message?: { content?: string | null } }[]; error?: { message?: string } }

/** Extract the message text, surfacing the API's own error instead of a
 *  cryptic `Cannot read properties of undefined` when a call comes back as an
 *  `{error}` body with no choices (seen with a shadowed/invalid API key). */
function contentOf(res: unknown, label: string): string {
  const r = res as Choices
  if (!r?.choices?.length) {
    const why = r?.error?.message ? `: ${r.error.message}` : ''
    throw new Error(`${label} returned no choices${why}`)
  }
  return r.choices[0]?.message?.content ?? ''
}

/**
 * GPT FIRST pass: LISTEN to a compressed copy of the audio + read the indexed
 * transcript, and propose the EDL. Text-only gpt-5 fallback when the audio can't
 * be attached, so the pass never silently vanishes on a picky/absent audio model.
 */
async function gptFirstPass(
  payload: string,
  audioPath: string,
  warnings: string[],
  phases: string[],
  onProgress?: (p: number, m?: string) => void
): Promise<string> {
  const openai = getOpenAI()
  const userText = `${payload}\nListen to the attached audio and return the first-pass EDL (remove repeated takes keeping the LAST, production artifacts like slates/take-planning/wrap markers, stutters, double words, dead-air pauses).`
  try {
    onProgress?.(45, 'Cut Lord is listening & cutting (2/4)…')
    const mp3 = await extractMp3(audioPath)
    try {
      const size = (await stat(mp3)).size
      if (size > MAX_AUDIO_BYTES) throw new Error(`audio too large for the listening pass (${Math.round(size / 1e6)}MB)`)
      const b64 = (await readFile(mp3)).toString('base64')
      const messages = [
        { role: 'system', content: GPT_FIRST_SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'text', text: userText },
            { type: 'input_audio', input_audio: { data: b64, format: 'mp3' } }
          ]
        }
      ]
      // Try each audio model; on a param rejection retry the SAME model without
      // temperature/seed before moving on, so a picky model never skips the pass.
      let lastErr: Error | null = null
      for (const model of OPENAI_AUDIO_MODELS) {
        for (const withParams of [true, false]) {
          try {
            const req: Record<string, unknown> = { model, modalities: ['text'], messages }
            if (withParams) {
              req.temperature = 0 // deterministic: repeat runs must agree
              req.seed = 7
            }
            const res = await openai.chat.completions.create(req as never)
            const content = contentOf(res, model)
            phases.push(`gpt-listen(${model}${withParams ? '' : ', bare'})`)
            return content
          } catch (e) {
            lastErr = e as Error
            const msg = lastErr.message || ''
            const paramProblem = /temperature|seed|unsupported.*(parameter|value)/i.test(msg)
            const modelProblem = /does not exist|do not have access|model_not_found|404/i.test(msg)
            if (paramProblem && withParams) continue // retry same model, bare params
            if (modelProblem) break // next model in the chain
            throw lastErr // real failure (rate limit, network, audio) -> text fallback
          }
        }
      }
      throw lastErr ?? new Error('no audio-capable model available')
    } finally {
      await unlink(mp3).catch(() => undefined)
    }
  } catch (e) {
    warnings.push(`GPT listening pass unavailable (${(e as Error).message}) — text-only first pass instead.`)
    onProgress?.(52, 'Cut Lord is cutting (2/4)…')
    const res = await openai.chat.completions.create({
      model: OPENAI_TEXT_MODEL,
      reasoning_effort: 'low',
      messages: [
        { role: 'system', content: GPT_FIRST_SYSTEM.replace('you can HEAR the attached audio', 'work from the transcript') },
        { role: 'user', content: userText }
      ]
    } as never)
    const content = contentOf(res, OPENAI_TEXT_MODEL)
    phases.push('gpt-text')
    return content
  }
}

/**
 * Claude SECOND pass: verify + finalize the first pass's EDL — re-scan for any
 * surviving repeat, guarantee only the LAST take of each duplicate remains, keep
 * the script coherent. No `temperature` (claude-opus-4-8 rejects it with a 400,
 * which silently killed the pass); determinism comes from the index-anchored
 * contract instead.
 */
async function claudeVerifyPass(
  payload: string,
  proposal: Edl,
  onProgress?: (p: number, m?: string) => void
): Promise<string> {
  onProgress?.(72, 'Cut Lord is finalizing (3/4)…')
  const client = getAnthropic()
  const userText =
    `${payload}\nFIRST-PASS PROPOSED EDL:\n${JSON.stringify(proposal)}\n\nVerify it, guarantee ZERO repeats remain (keep the LAST take of every duplicate), keep the kept script coherent, and return the final EDL.`
  const res = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    system: CLAUDE_VERIFY_SYSTEM,
    messages: [{ role: 'user', content: userText }]
  })
  const block = res.content.find((b) => b.type === 'text')
  return block && block.type === 'text' ? block.text : ''
}

export async function cutCutPro(
  audioPath: string,
  existing: Transcript | null,
  modelName?: string,
  /** the creator's INTENDED script: ground truth for what belongs in the final
   *  video. Both passes keep the delivery that matches it and cut deviations. */
  script?: string,
  onProgress?: (pct: number, msg?: string) => void
): Promise<CutCutProResult> {
  const warnings: string[] = []
  const phases: string[] = []
  let rawGpt = ''
  let rawClaude = ''

  // ---- Phase 1: transcription (whisper-1, verbatim) + pause mapping -----------
  onProgress?.(2, 'Cut Lord is transcribing (1/4)…')
  let transcript = existing
  if (transcript) {
    phases.push('transcript(reused)')
  } else if (openaiAvailable()) {
    try {
      transcript = await transcribeOpenAI(audioPath, (p) => onProgress?.(2 + p * 0.28, 'Cut Lord is transcribing (1/4)…'))
      phases.push('whisper-1')
    } catch (e) {
      warnings.push(`OpenAI transcription failed (${(e as Error).message.split('\n')[0]}) — using local whisper.`)
    }
  }
  if (!transcript) {
    transcript = await transcribe(audioPath, (p) => onProgress?.(2 + p * 0.28, 'Cut Lord is transcribing (1/4)…'), modelName)
    phases.push('whisper.cpp')
  }

  // NO VAD pause map — every silence engine was removed from this branch.
  const vad: { start: number; end: number }[] = []

  const map: TimestampMap = buildTimestampMap(transcript.words, vad)
  let payload = buildAiPayload(map)
  if (script?.trim()) {
    payload += `\n\nCREATOR'S INTENDED SCRIPT (ground truth — this is what the final video should say):\n"""\n${script.trim()}\n"""\nUse it to decide the cuts: among repeated takes KEEP THE LAST take that matches the script; speech that deviates from the script (flubbed lines, asides, production talk, abandoned tangents) is cut material. Do NOT cut a line merely because the wording differs slightly — natural delivery beats verbatim — but content with no counterpart in the script does not belong in the final video.`
    phases.push('script-guided')
  }

  // ---- Phase 2: GPT first pass (listens, proposes cuts) ----------------------
  let gptEdl: Edl | null = null
  if (openaiAvailable()) {
    try {
      const raw = await gptFirstPass(payload, audioPath, warnings, phases, onProgress)
      rawGpt = raw.slice(0, 4000)
      const v = validateEdl(raw, map)
      if (v.ok) {
        gptEdl = v.edl
        phases.push('gpt')
      } else warnings.push('GPT first pass returned an unusable EDL — Claude runs solo.')
    } catch (e) {
      warnings.push(`GPT first pass failed (${(e as Error).message}).`)
    }
  } else {
    warnings.push('No OPENAI_API_KEY — skipping the GPT first pass.')
  }

  // ---- Phase 3: Claude verification / finalization ---------------------------
  let claudeEdl: Edl | null = null
  if (claudeAvailable()) {
    try {
      const raw = await claudeVerifyPass(payload, gptEdl ?? { word_cuts: [], pause_cuts: [] }, onProgress)
      rawClaude = raw.slice(0, 4000)
      const v = validateEdl(raw, map)
      if (v.ok) {
        claudeEdl = v.edl
        phases.push('claude')
      } else warnings.push('Claude verification returned an unusable EDL — using the first-pass EDL.')
    } catch (e) {
      warnings.push(`Claude verification failed (${(e as Error).message}).`)
    }
  } else {
    warnings.push('No ANTHROPIC_API_KEY — skipping the Claude verification pass.')
  }

  // Claude's verified EDL wins; fall back to the GPT proposal, then nothing.
  let finalEdl: Edl = claudeEdl ?? gptEdl ?? { word_cuts: [], pause_cuts: [] }
  if (!claudeEdl && !gptEdl) warnings.push('No AI provider produced an EDL — nothing was cut. Configure OPENAI_API_KEY / ANTHROPIC_API_KEY.')

  // ---- Phase 4: deterministic guards + resolve + debug ------------------------
  onProgress?.(88, 'Cut Lord is cutting (4/4)…')
  // Guard pass over the AI's judgment: extend cuts back over duplicated openings
  // and sweep dangling incomplete clauses.
  const refined = refineEdl(finalEdl, map)
  finalEdl = refined.edl
  const edits = edlToEdits(finalEdl, map, transcript.words)

  const debug: CutCutProDebug = {
    mode: 'cutcutpro',
    phases_run: phases,
    timestamp_map: map,
    // claude_edl = the finalized second pass; openai_edl = the GPT first-pass proposal.
    claude_edl: claudeEdl,
    openai_edl: gptEdl,
    final_edl: finalEdl,
    refine_notes: refined.notes,
    deleted_words: edits.deleteWordIds.length,
    pause_edits: edits.silenceAdds.length,
    warnings,
    // raw model replies (truncated) — diagnose WHY a pass was rejected
    openai_raw: rawGpt,
    claude_raw: rawClaude
  }
  let debugPath = ''
  try {
    const dir = join(homedir(), '.easecutpro', 'cutcutpro')
    await mkdir(dir, { recursive: true })
    debugPath = join(dir, `debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    await writeFile(debugPath, JSON.stringify(debug, null, 2), 'utf8')
  } catch {
    debugPath = ''
  }

  onProgress?.(100, 'Cut Lord finished')
  return {
    transcript: existing ? null : transcript,
    deleteWordIds: edits.deleteWordIds,
    silenceAdds: edits.silenceAdds,
    debugPath,
    warnings,
    summary: `ProCut: ${edits.deleteWordIds.length} word(s) cut, ${edits.silenceAdds.length} pause edit(s) [${phases.join(' → ')}]`
  }
}
