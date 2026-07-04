/**
 * CutCutPro — orchestrator for the 4-phase premium cutting pipeline.
 *
 *   Phase 1: whisper.cpp (Silero VAD build) + Parakeet -> precise timestamp map
 *            (pauses, fillers, stutters, incomplete sentences).
 *   Phase 2: Claude (claude-opus-4-8) semantic first pass -> proposed EDL
 *            (CUT/KEEP as word indices + pause ids — no free timestamps).
 *   Phase 3: OpenAI second pass LISTENS to a compressed copy of the audio
 *            (gpt-4o-audio-preview) to check tone/pacing, resolves conflicts,
 *            finalizes the EDL. Text-only GPT fallback, then Claude-EDL
 *            fallback — the job never crashes on a missing provider.
 *   Phase 4: the EDL is resolved onto the EXISTING edit model (deleted words +
 *            silence regions -> computeKeepRanges), so preview/export/undo and
 *            every other engine stay untouched.
 *
 * Additive: separate module + separate button; standard engines unchanged.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFile, unlink, mkdir, writeFile, stat } from 'fs/promises'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { randomUUID } from 'crypto'
import { FFMPEG } from './binaries'
import { transcribe } from './whisper'
import { transcribeParakeet } from './parakeet'
import { detectSilence } from './ffmpeg'
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

const CLAUDE_MODEL = 'claude-opus-4-8'
// gpt-4o-audio-preview is retired (404s). Try the current audio models in
// order; the first one the account has wins.
const OPENAI_AUDIO_MODELS = ['gpt-audio', 'gpt-audio-1.5', 'gpt-audio-mini', 'gpt-4o-audio-preview']
const OPENAI_TEXT_MODEL = 'gpt-5'
const MAX_AUDIO_BYTES = 18 * 1024 * 1024 // keep the base64 payload well under API limits

const EDL_SHAPE = `Reply with VALID JSON ONLY (no prose, no markdown fences), exactly:
{"word_cuts":[{"from":12,"to":18,"reason":"failed take restarted at 19"}],
 "pause_cuts":[{"pause_id":"p3","keep_ms":150,"reason":"dead air; keep a beat"}]}
word_cuts use INCLUSIVE word indices from the list. pause_cuts reference pause ids; keep_ms=0 removes the pause entirely, otherwise that many ms remain.`

const CLAUDE_SYSTEM = `You are the FIRST PASS of a two-pass professional video cutting pipeline. You receive an index-anchored transcript with exact pause markers, vocal fillers, stutters and incomplete sentences flagged.

Perform a SEMANTIC analysis:
- distinguish deliberate repetition (emphasis, rhetoric) from accidental retakes/restarts — cut the abandoned earlier takes, keep the final clean take VERBATIM;
- map incomplete thoughts (sentences left hanging) — cut them when the speaker restarts the idea, keep them if they flow into the next line;
- cut vocal fillers and stutters UNLESS removing them would break the sentence;
- decide every listed pause: dead air => remove or trim hard; natural sentence rhythm or dramatic/emotional beats => keep or trim gently.
Be decisive but never cut content that is the only copy of an idea.

${EDL_SHAPE}`

const OPENAI_SYSTEM = `You are the SECOND PASS (verification) of a professional video cutting pipeline. You receive: the index-anchored transcript map, and the first pass's proposed EDL. ${'' /* audio attached when available */}Listen to the attached audio: evaluate the speaker's emotional tone, breathing and natural pacing. Cross-check every proposed cut against how it will SOUND:
- veto or adjust cuts that would feel jarring, clip a breath mid-flow, or kill an intentional emotional pause;
- tighten pauses the first pass was too shy about when the audio confirms dead air;
- keep deliberate pacing; the final result must feel fluent and natural, stripped of dead silences, fillers, retakes and broken sentences.
Return the DEFINITIVE final EDL (same ids/indices; your reply fully replaces the proposal).

${EDL_SHAPE}`

async function extractMp3(path: string): Promise<string> {
  const out = join(tmpdir(), `ccp-${randomUUID()}.mp3`)
  await execFileP(FFMPEG, ['-y', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', out])
  return out
}

/** Refine whisper word timestamps with Parakeet's (second recognizer): where the
 *  two agree on a word (monotonic match, <300ms apart), average the boundaries. */
function refineWithParakeet(base: Transcript, alt: Transcript): number {
  const normTok = (s: string): string => s.toLowerCase().replace(/[^a-z0-9']/g, '')
  let j = 0
  let refined = 0
  for (const w of base.words) {
    const n = normTok(w.text)
    if (!n) continue
    for (let k = j; k < Math.min(alt.words.length, j + 6); k++) {
      const a = alt.words[k]
      if (normTok(a.text) === n && Math.abs(a.start - w.start) < 0.3) {
        w.start = Number(((w.start + a.start) / 2).toFixed(3))
        w.end = Number(((w.end + a.end) / 2).toFixed(3))
        j = k + 1
        refined++
        break
      }
    }
  }
  return refined
}

async function claudePass(payload: string, onProgress?: (p: number, m?: string) => void): Promise<string> {
  onProgress?.(45, 'Cut Lord is thinking (2/4)…')
  const client = getAnthropic()
  // NOTE: no `temperature` — claude-opus-4-8 rejects it with a 400 ("deprecated
  // for this model"), which silently killed this whole pass. Determinism comes
  // from the structured, index-anchored contract instead.
  const res = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 8192,
    system: CLAUDE_SYSTEM,
    messages: [{ role: 'user', content: payload }]
  })
  const block = res.content.find((b) => b.type === 'text')
  return block && block.type === 'text' ? block.text : ''
}

async function openaiListenPass(
  payload: string,
  claudeEdl: Edl,
  audioPath: string,
  warnings: string[],
  phases: string[],
  onProgress?: (p: number, m?: string) => void
): Promise<string> {
  const openai = getOpenAI()
  const userText =
    `${payload}\nPROPOSED EDL (first pass):\n${JSON.stringify(claudeEdl)}\n\nVerify against the attached audio and return the final EDL.`
  // Listening pass: compressed mono copy of the audio, base64-attached.
  try {
    onProgress?.(65, 'Cut Lord is double-checking (3/4) — listening…')
    const mp3 = await extractMp3(audioPath)
    try {
      const size = (await stat(mp3)).size
      if (size > MAX_AUDIO_BYTES) throw new Error(`audio too large for the listening pass (${Math.round(size / 1e6)}MB)`)
      const b64 = (await readFile(mp3)).toString('base64')
      const messages = [
        { role: 'system', content: OPENAI_SYSTEM },
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
            phases.push(`listen(${model}${withParams ? '' : ', bare'})`)
            return (res as { choices: { message: { content: string | null } }[] }).choices[0]?.message?.content ?? ''
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
    warnings.push(`Listening pass unavailable (${(e as Error).message}) — text-only verification instead.`)
    onProgress?.(70, 'Cut Lord is double-checking (3/4)…')
    const res = await openai.chat.completions.create({
      model: OPENAI_TEXT_MODEL,
      reasoning_effort: 'low',
      messages: [
        { role: 'system', content: OPENAI_SYSTEM.replace('Listen to the attached audio: e', 'E') },
        { role: 'user', content: userText }
      ]
    } as never)
    return (res as { choices: { message: { content: string | null } }[] }).choices[0]?.message?.content ?? ''
  }
}

export async function cutCutPro(
  audioPath: string,
  existing: Transcript | null,
  modelName?: string,
  onProgress?: (pct: number, msg?: string) => void
): Promise<CutCutProResult> {
  const warnings: string[] = []
  const phases: string[] = []

  // ---- Phase 1: pre-processing & audio mapping -------------------------------
  onProgress?.(2, 'Cut Lord is listening (1/4)…')
  let transcript = existing
  if (!transcript) {
    transcript = await transcribe(audioPath, (p, m) => onProgress?.(2 + p * 0.2, 'Cut Lord is listening (1/4)…'), modelName)
  }
  phases.push('whisper')

  // Parakeet second recognizer (optional): tightens word boundaries.
  try {
    onProgress?.(24, 'Cut Lord is listening (1/4) — refining timing…')
    const alt = await transcribeParakeet(audioPath, () => undefined)
    const refined = refineWithParakeet(transcript, alt)
    phases.push(`parakeet(${refined} words refined)`)
  } catch (e) {
    warnings.push(`Parakeet unavailable (${(e as Error).message.split('\n')[0]}) — whisper timestamps used as-is.`)
  }

  // Silero VAD: corroborates pauses / catches non-speech noise floors.
  let vad: { start: number; end: number }[] = []
  try {
    onProgress?.(32, 'Cut Lord is listening (1/4) — mapping pauses…')
    vad = (await detectSilence(audioPath, { mode: 'vad', noiseDb: -35, minDuration: 0.25 })).map((r) => ({ start: r.start, end: r.end }))
    phases.push(`vad(${vad.length} regions)`)
  } catch (e) {
    warnings.push(`VAD unavailable (${(e as Error).message.split('\n')[0]}) — pauses from word gaps only.`)
  }

  const map: TimestampMap = buildTimestampMap(transcript.words, vad)
  const payload = buildAiPayload(map)

  // ---- Phase 2: Claude semantic first pass -----------------------------------
  let claudeEdl: Edl | null = null
  if (claudeAvailable()) {
    try {
      const raw = await claudePass(payload, onProgress)
      const v = validateEdl(raw, map)
      if (v.ok) {
        claudeEdl = v.edl
        phases.push('claude')
      } else warnings.push('Claude returned an unusable EDL — verification pass runs solo.')
    } catch (e) {
      warnings.push(`Claude pass failed (${(e as Error).message}).`)
    }
  } else {
    warnings.push('No ANTHROPIC_API_KEY — skipping the Claude first pass.')
  }

  // ---- Phase 3: OpenAI listening verification --------------------------------
  let openaiEdl: Edl | null = null
  if (openaiAvailable()) {
    try {
      const raw = await openaiListenPass(payload, claudeEdl ?? { word_cuts: [], pause_cuts: [] }, audioPath, warnings, phases, onProgress)
      const v = validateEdl(raw, map)
      if (v.ok) {
        openaiEdl = v.edl
        phases.push('openai')
      } else warnings.push('OpenAI returned an unusable EDL — using the first-pass EDL.')
    } catch (e) {
      warnings.push(`OpenAI pass failed (${(e as Error).message}).`)
    }
  } else {
    warnings.push('No OPENAI_API_KEY — skipping the listening verification pass.')
  }

  let finalEdl: Edl = openaiEdl ?? claudeEdl ?? { word_cuts: [], pause_cuts: [] }
  if (!openaiEdl && !claudeEdl) warnings.push('No AI provider produced an EDL — nothing was cut. Configure ANTHROPIC_API_KEY / OPENAI_API_KEY.')

  // ---- Phase 4: deterministic guards + resolve + debug ------------------------
  onProgress?.(88, 'Cut Lord is cutting (4/4)…')
  // Guard pass over the AI's judgment: extend cuts back over duplicated
  // openings and sweep dangling incomplete clauses (screenshot bugs).
  const refined = refineEdl(finalEdl, map)
  finalEdl = refined.edl
  const edits = edlToEdits(finalEdl, map, transcript.words)

  const debug: CutCutProDebug = {
    mode: 'cutcutpro',
    phases_run: phases,
    timestamp_map: map,
    claude_edl: claudeEdl,
    openai_edl: openaiEdl,
    final_edl: finalEdl,
    refine_notes: refined.notes,
    deleted_words: edits.deleteWordIds.length,
    pause_edits: edits.silenceAdds.length,
    warnings
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
    summary: `CutCutPro: ${edits.deleteWordIds.length} word(s) cut, ${edits.silenceAdds.length} pause edit(s) [${phases.join(' → ')}]`
  }
}
