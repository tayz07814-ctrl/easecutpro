// Cloud build — Retake-Aware Cut Beta for the browser (no PC server).
//
// WORD CUTS are LLM-first, "ProCut style": the FULL index-anchored transcript
// (shared/cutcutpro buildAiPayload) goes to the judge (the `ultracut-judge`
// edge fn, empty first pass) which scans everything and returns the cut EDL.
//
// NO SILENCE: every silence-cutting engine was removed from this branch
// (Smart Silence transcript-gap, FSMN VAD, Silero VAD). The judge cuts words
// only; silenceRegions is always empty.
//
// The result shape (RetakeAwareResult) and the store's review-first contract are
// identical, so the transcript/highlight/Execute UX is unchanged. Debug JSON is
// uploaded best-effort to the private `retake-aware-debugs` bucket.

import type { RetakeAwareResult, CutSpan } from '@shared/retakeaware/types'
import type { Transcript, SilenceRegion } from '@shared/types'
import type { ProcutJudgeReq, ProcutJudgeRes } from '@shared/cloud'
import {
  buildTimestampMap,
  buildAiPayload,
  validateEdl,
  type Edl,
  type TimestampMap
} from '@shared/cutcutpro'
import { toAppTranscript, type ProgressFn } from '@shared/retakeaware/engine'
import { spansToWordIds } from '@shared/retakeaware/analyze'
import { detectArtifacts } from '@shared/retakeaware/artifacts'
import { getSupabase, invokeEdge } from './supabase'
import { extractSttAudio } from './audio'
import { cachedTranscribe, getCachedTranscript, setCachedTranscript } from './transcriptCache'
import { transcribeVerbatimCloud } from './stt'

/** Opus EDL (inclusive word-index cuts) -> Retake β time-based CutSpans. The
 *  silence engine + spansToWordIds both work in time, so this is the only bridge
 *  needed between ProCut's index EDL and Retake β's span pipeline. */
function edlToRetakeCutSpans(edl: Edl, map: TimestampMap): CutSpan[] {
  const spans: CutSpan[] = []
  for (const c of edl.word_cuts) {
    const from = map.words[c.from]
    const to = map.words[c.to]
    if (!from || !to) continue
    spans.push({
      start: from.start,
      end: to.end,
      type: 'failed_retake',
      source: 'retake_aware_beta',
      reason: c.reason || 'earlier/duplicate take or production chatter'
    })
  }
  return spans
}

/** Persist every run's debug JSON (transcription + Opus payload/reply + the cuts
 *  and silence it produced) to the private `retake-aware-debugs` bucket so
 *  detection mistakes can be reviewed against real data. Best-effort: a failed
 *  upload logs and returns null; it never fails the run. */
async function saveRetakeDebug(debug: Record<string, unknown>): Promise<string | null> {
  try {
    const sb = getSupabase()
    const { data } = await sb.auth.getUser()
    const uid = data.user?.id ?? 'anon'
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const path = `${uid}/${stamp}-opus.json`
    const { error } = await sb.storage
      .from('retake-aware-debugs')
      .upload(path, new Blob([JSON.stringify({ mode: 'retake_aware_beta_opus', ...debug }, null, 2)], { type: 'application/json' }), {
        contentType: 'application/json',
        upsert: false
      })
    if (error) {
      console.warn('[retake-aware-beta] debug upload failed:', error.message)
      return null
    }
    console.log('[retake-aware-beta] debug saved to storage:', path)
    return path
  } catch (e) {
    console.warn('[retake-aware-beta] debug upload error:', (e as Error).message)
    return null
  }
}

export async function retakeAwareCutCloud(
  mediaId: string,
  onProgress?: (pct: number, msg?: string) => void
): Promise<RetakeAwareResult> {
  const warnings: string[] = []
  const op: ProgressFn = (pct, msg) => onProgress?.(pct, msg)
  console.log('[retake-aware-beta] cloud job start (GPT-5.6 Luna + sharp judge):', mediaId)

  // 1. audio — decoded ONCE; the transcription reads from this single decode.
  op(3, 'Getting your audio ready…')
  const audio = await extractSttAudio(mediaId, (p) => op(3 + Math.round(p * 0.04)))

  // 2. verbatim transcription (AssemblyAI -> Deepgram); emits 8..49. Cached by
  //    mediaId — a re-run reuses the transcript and skips the STT round-trip.
  const { vt, warnings: tw } = await cachedTranscribe(mediaId, audio, op)
  warnings.push(...tw)

  // NO SILENCE STAGES: every silence-cutting engine was removed from this
  // branch. The judge below sees no pause markers and cuts words only.
  const vadSil: { start: number; end: number }[] = []

  // 3. WORD-CUT BRAIN — 0.01 Retake Beta judge over the FULL transcript:
  //    OpenAI GPT-5.6 Luna via OpenRouter (ultracut-judge edge fn) on the 'sharp'
  //    word-list prompt, reasoning effort 'medium'. It replaces Gemma 4 31B, whose
  //    shared free provider was rate-limiting (HTTP 429) and returning empty
  //    completions often enough to fail the judge outright.
  //
  //    The model MUST also be in the edge function's MODEL_WHITELIST — resolveModel
  //    silently falls back to the default for anything unlisted. 0.01 ONLY.
  op(72, 'Cut Lord is judging your takes…')
  // buildTimestampMap wants app Words (id/text); the pre-artifact transcript is
  // 1:1 with vt.words, so EDL word indices resolve to the right times. The FINAL
  // transcript (from repaired words) is rebuilt after the judge pass below.
  const map = buildTimestampMap(toAppTranscript(vt).words, vadSil)
  const payload = buildAiPayload(map)
  let baseCutSpans: CutSpan[] = []
  let claudeRaw: string | null = null
  try {
    const res = await invokeEdge<ProcutJudgeRes>('ultracut-judge', {
      payload,
      proposal: { word_cuts: [], pause_cuts: [] },
      model: 'openai/gpt-5.6-luna',
      promptVariant: 'sharp',
      reasoning: 'medium'
    } satisfies ProcutJudgeReq)
    claudeRaw = res.raw
    if (res.judge === 'none') {
      warnings.push('Retake β couldn’t analyze this clip — please try again.')
    } else if (res.raw == null) {
      warnings.push('Retake β couldn’t analyze this clip — no takes were cut.')
    } else {
      const v = validateEdl(res.raw, map)
      if (!v.ok) {
        warnings.push('Retake β couldn’t read the result — no takes were cut.')
      } else {
        // Apply ONLY the LLM's word_cuts — no deterministic refineEdl passes
        // (backward dedupe extension + incomplete-fragment sweep). Those were
        // over-cutting (e.g. swallowing a valid opening flagged as an
        // "incomplete sentence"). validateEdl still clamps/guards the LLM's own
        // cuts; we just don't add anything the model didn't ask for.
        baseCutSpans = edlToRetakeCutSpans(v.edl, map)
      }
    }
  } catch {
    warnings.push('Retake β couldn’t finish — please try again.')
  }

  // 4. ASR-artifact repair (stretched-word clamp) so the transcript timings are
  //    truthful. Transcript-only (no VAD scan on this branch).
  op(90, 'Finishing up…')
  const artifacts = detectArtifacts(vt.words, baseCutSpans, vadSil)
  const transcript = toAppTranscript({ ...vt, words: artifacts.repairedWords })
  // Only the LLM's cuts drive the retake removals — drop the artifact
  // orphan-cut cleanup too (repairedWords still fixes ASR word timings for the
  // transcript; it just no longer adds cuts the model didn't propose).
  const cutSpans = [...baseCutSpans].sort((a, b) => a.start - b.start)
  const deleteWordIds = spansToWordIds(cutSpans, transcript)

  // NO SILENCE on this branch — the engines are gone, nothing stages pauses.
  const silenceRegions: SilenceRegion[] = []
  const silenceDebug = { source: 'none — silence engines removed from this branch' }

  // 5. debug JSON (best-effort, private bucket).
  const debugPath = await saveRetakeDebug({
    provider: vt.provider,
    ai_payload: payload,
    claude_raw: claudeRaw,
    cut_spans: cutSpans,
    delete_word_ids_count: deleteWordIds.length,
    silence: silenceDebug,
    warnings
  })

  op(100, 'Cut Lord finished')
  return {
    cut_mode: 'retake_aware_beta',
    provider: vt.provider,
    verbatim: vt,
    transcript,
    deleteWordIds,
    cutSpans,
    silenceRegions,
    // Opus judges the whole transcript holistically — there are no per-group
    // rule structures to surface (the store's review UX reads only the flags).
    retakeGroups: [],
    fillerDecisions: [],
    debugPath,
    warnings,
    summary: `Retake β: ${deleteWordIds.length} word(s) flagged`
  }
}

/** Ultracut (Beta) — a SEPARATE experimental engine, structurally like the retake
 *  cloud path but whose judge is the `ultracut-judge` edge fn running an OpenRouter
 *  TEST model (GLM 5.2). It shares NOTHING with Retake Beta's Opus judge
 *  (procut-judge) — its own edge function, its own request, its own
 *  debug stream — so the two can be A/B'd in-app. The result shape
 *  (RetakeAwareResult) is identical, so the review-first contract, the
 *  transcript/highlight UX and Execute all reuse the exact beta path. Cloud-only. */
// 0.01 Ultracut judge. DeepSeek-V4-flash via OPENROUTER (the 'deepseek/' slug routes
// through OpenRouter on the user's OpenRouter key/credit; the edge fn sends NO
// provider preference, so routing follows the account's own enabled providers) WITH
// reasoning:'medium'. Reverted from the DeepSeek first-party route (api.deepseek.com,
// bare id) per request: that account ran out of balance, so OpenRouter v4-flash is
// the single model for this button now. Paired with promptVariant:'sharp' (word-list
// SYSTEM + Rules A/B). Scoped to the Ultracut Beta button only.
const ULTRACUT_MODEL = 'deepseek/deepseek-v4-flash'
export async function ultracutCutCloud(
  mediaId: string,
  onProgress?: (pct: number, msg?: string) => void
): Promise<RetakeAwareResult> {
  const warnings: string[] = []
  const op: ProgressFn = (pct, msg) => onProgress?.(pct, msg)
  console.log('[ultracut] cloud job start (DeepSeek first-party judge):', mediaId, ULTRACUT_MODEL)

  // 1. audio — decoded ONCE; transcription reads from this single decode.
  op(3, 'Getting your audio ready…')
  const audio = await extractSttAudio(mediaId, (p) => op(3 + Math.round(p * 0.04)))

  // 2. verbatim transcription (AssemblyAI -> Deepgram); emits 8..49. Cached by
  //    mediaId — a re-run reuses the transcript and skips the STT round-trip.
  const { vt, warnings: tw } = await cachedTranscribe(mediaId, audio, op)
  warnings.push(...tw)

  // NO SILENCE: every silence-cutting engine was removed from this branch.
  const vadSil: { start: number; end: number }[] = []

  // 3. WORD-CUT BRAIN — the OpenRouter TEST model (ultracut-judge) over the FULL
  //    transcript, empty first pass. Same index-anchored payload + validateEdl as
  //    Retake β; only the judge endpoint + provider differ.
  op(72, 'Ultracut is judging your takes…')
  const map = buildTimestampMap(toAppTranscript(vt).words, vadSil)
  // 0.01 Ultracut runs the WORD-LIST payload (buildAiPayload) + the 'sharp' SYSTEM
  // variant. The segment prompt was reverted: real creator footage has mid-SENTENCE
  // retakes ("They pretty—", "the way that I—", "Food can, food can") buried inside
  // long run-on segments, and the segment prompt's "never cut inside a segment" rule
  // can't reach them — DeepSeek responded by cutting EVERY segment (rejected by
  // validateEdl's runaway guard → "no cuts"). The word-list prompt (partial/tail-
  // retake + stutter rules, plus the 'sharp' Rules A/B) makes surgical word cuts
  // instead — validated on the exact failing clip: 7 correct cuts, no over-cut.
  const payload = buildAiPayload(map)
  let baseCutSpans: CutSpan[] = []
  let modelRaw: string | null = null
  try {
    const res = await invokeEdge<ProcutJudgeRes>('ultracut-judge', {
      payload,
      proposal: { word_cuts: [], pause_cuts: [] },
      model: ULTRACUT_MODEL,
      promptVariant: 'sharp',
      reasoning: 'medium'
    } satisfies ProcutJudgeReq)
    modelRaw = res.raw
    if (res.judge === 'none') {
      warnings.push('Ultracut needs the OpenRouter API key configured on the server — no takes were cut.')
    } else if (res.raw == null) {
      warnings.push('Ultracut couldn’t analyze this clip — no takes were cut.')
    } else {
      const v = validateEdl(res.raw, map)
      if (!v.ok) {
        warnings.push('Ultracut couldn’t read the model’s result — no takes were cut.')
      } else {
        // Apply ONLY the LLM's word_cuts — no deterministic refineEdl passes
        // (backward dedupe extension + incomplete-fragment sweep). Those were
        // over-cutting (e.g. swallowing a valid opening flagged as an
        // "incomplete sentence"). validateEdl still clamps/guards the LLM's own
        // cuts; we just don't add anything the model didn't ask for.
        baseCutSpans = edlToRetakeCutSpans(v.edl, map)
      }
    }
  } catch {
    warnings.push('Ultracut couldn’t finish — please try again.')
  }

  // 4. finish: transcript from repaired words; word cuts only.
  op(90, 'Finishing up…')
  const artifacts = detectArtifacts(vt.words, baseCutSpans, vadSil)
  const transcript = toAppTranscript({ ...vt, words: artifacts.repairedWords })
  // Only the LLM's cuts drive the retake removals — drop the artifact
  // orphan-cut cleanup too (repairedWords still fixes ASR word timings for the
  // transcript; it just no longer adds cuts the model didn't propose).
  const cutSpans = [...baseCutSpans].sort((a, b) => a.start - b.start)
  const deleteWordIds = spansToWordIds(cutSpans, transcript)

  // NO SILENCE on this branch — the engines are gone, nothing stages pauses.
  const silenceRegions: SilenceRegion[] = []
  const silenceDebug = { source: 'none — silence engines removed from this branch' }

  // 5. debug JSON (best-effort, private bucket) — its own mode so ultracut runs
  //    are distinguishable from retake runs.
  const debugPath = await saveRetakeDebug({
    mode: 'retake_ultracut',
    provider: vt.provider,
    ai_payload: payload,
    model_raw: modelRaw,
    cut_spans: cutSpans,
    delete_word_ids_count: deleteWordIds.length,
    silence: silenceDebug,
    warnings
  })

  op(100, 'Cut Lord finished')
  return {
    // Same cut_mode as beta on purpose: the result shape + review contract are
    // identical, so nothing downstream needs to special-case ultracut.
    cut_mode: 'retake_aware_beta',
    provider: vt.provider,
    verbatim: vt,
    transcript,
    deleteWordIds,
    cutSpans,
    silenceRegions,
    retakeGroups: [],
    fillerDecisions: [],
    debugPath,
    warnings,
    summary: `Ultracut: ${deleteWordIds.length} word(s) flagged`
  }
}

/** Plain cloud transcription for the Transcribe button: same audio + provider
 *  chain as the beta engine, converted to the app transcript shape (rw0../rs0..
 *  ids) with the shared toAppTranscript. */
export async function transcribeCloud(
  mediaId: string,
  onProgress?: (pct: number, msg?: string) => void
): Promise<Transcript> {
  const op: ProgressFn = (pct, msg) => onProgress?.(pct, msg)
  // Cache hit → return immediately without decoding audio or calling STT again.
  const cached = getCachedTranscript(mediaId)
  if (cached) {
    op(100, 'Reusing transcript…')
    return toAppTranscript(cached.vt)
  }
  op(3, 'Extracting audio…')
  const audio = await extractSttAudio(mediaId, (p) => op(3 + Math.round(p * 0.04)))
  const r = await transcribeVerbatimCloud(audio, op)
  setCachedTranscript(mediaId, r)
  return toAppTranscript(r.vt)
}
