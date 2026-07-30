// Cloud build — Retake-Aware Cut Beta for the browser (no PC server).
//
// WORD CUTS are now LLM-first, "ProCut style": instead of the rules-first
// detectors deciding the cuts and Opus only adjudicating the ambiguous ones, the
// FULL index-anchored transcript (shared/cutcutpro buildAiPayload) goes to the
// SAME Opus finalizer ProCut uses (the `procut-judge` edge fn, empty first pass)
// and Opus scans everything and returns the cut EDL. This closes the recall gap
// vs ProCut — Opus is the detector, not a downstream referee.
//
// SILENCE is the FSMN (FunASR) VAD engine and nothing else: in-browser ONNX VAD
// at the model's published defaults, endpoint cushions removed, then the
// creator's seam padding from the "Silence settings" modal
// (retakeFinalBossSettings). It is the ONLY live silence cutter in this build.
//
// The transcript-gap "Smart Silence" engine (src/renderer/src/smartSilence/) is
// DORMANT — it is not wired into Find cuts and has no UI entry point. Its code is
// kept intact but unreferenced; see SMART_SILENCE_DORMANT in main.tsx.
//
// The desktop path (src/main/retakeaware, runRetakeAwareCut) still uses the
// hybrid, untouched.
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
import { retakeBetaVadSafetyOpts } from '@shared/retakeaware/silence'
import { DEFAULT_VAD_SILENCE_SETTINGS, type VadSilenceSettings } from '@shared/vadsilence'
import { DEFAULT_RETAKE_FINAL_BOSS_SETTINGS, type RetakeFinalBossSettings } from '@shared/retakefinalboss'
import { detectRetakeFinalBossSilences } from './retakeFinalBossVad'
import { getSupabase, invokeEdge } from './supabase'
import { extractSttAudio } from './audio'
import { cachedTranscribe, getCachedTranscript, setCachedTranscript } from './transcriptCache'
import { transcribeVerbatimCloud } from './stt'
import { detectSilenceFloat32, vadSilenceRegions } from './vad'

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
  onProgress?: (pct: number, msg?: string) => void,
  fsmnSettings: RetakeFinalBossSettings = DEFAULT_RETAKE_FINAL_BOSS_SETTINGS
): Promise<RetakeAwareResult> {
  const warnings: string[] = []
  const op: ProgressFn = (pct, msg) => onProgress?.(pct, msg)
  console.log('[retake-aware-beta] cloud job start (Gemma-4-31B + sharp judge):', mediaId)

  // 1. audio — decoded ONCE; the transcription, the VAD safety scan and the
  //    silence engine all read from this single decode (shared clock).
  op(3, 'Getting your audio ready…')
  const audio = await extractSttAudio(mediaId, (p) => op(3 + Math.round(p * 0.04)))

  // 2. verbatim transcription (AssemblyAI -> Deepgram); emits 8..49. Cached by
  //    mediaId — a re-run reuses the transcript and skips the STT round-trip.
  const { vt, warnings: tw } = await cachedTranscribe(mediaId, audio, op)
  warnings.push(...tw)

  // 3. VAD safety scan (Retake β's own profile) — ONE pass, reused for the Opus
  //    payload's pause markers AND the silence engine below (same as the rules
  //    path's safety scan). If it fails we fall back to transcript-gap pauses.
  op(56, 'Listening for pauses…')
  let vadSil: { start: number; end: number }[] = []
  try {
    vadSil = (await detectSilenceFloat32(audio.float32, audio.sampleRate, retakeBetaVadSafetyOpts(), audio.durationS)).map((r) => ({
      start: r.start,
      end: r.end
    }))
  } catch (e) {
    warnings.push(`VAD safety scan failed (${(e as Error).message}) — trimming from transcript gaps only.`)
  }

  // 4. WORD-CUT BRAIN — 0.01 Retake Beta judge over the FULL transcript: Gemma 4
  //    31B on CEREBRAS (ultracut-judge edge fn, un-prefixed 'gemma-4-31b' → the
  //    Cerebras first-party route) on the 'sharp' word-list prompt. Cerebras is
  //    used instead of OpenRouter's google/gemma-4-31b-it because the OpenRouter
  //    free provider was rate-limiting (HTTP 429) ~1-in-9 runs, failing the judge.
  //    Gemma is non-reasoning, so reasoning is 'off'. 0.01 ONLY.
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
      model: 'google/gemma-4-31b-it',
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

  // 5. ASR-artifact repair (stretched-word clamp + orphan record-clicks) so the
  //    transcript timings are truthful before the silence pass below.
  op(90, 'Cleaning silence…')
  const artifacts = detectArtifacts(vt.words, baseCutSpans, vadSil)
  const transcript = toAppTranscript({ ...vt, words: artifacts.repairedWords })
  // Only the LLM's cuts drive the retake removals — drop the artifact
  // orphan-cut cleanup too (repairedWords still fixes ASR word timings for the
  // transcript; it just no longer adds cuts the model didn't propose).
  const cutSpans = [...baseCutSpans].sort((a, b) => a.start - b.start)
  const deleteWordIds = spansToWordIds(cutSpans, transcript)

  const keptWords = artifacts.repairedWords.filter((w) => {
    const m = (w.start + w.end) / 2
    return !cutSpans.some((s) => m >= s.start && m <= s.end)
  })
  // SILENCE — the FSMN (FunASR) engine, the ONLY silence cutter in this build.
  // In-browser ONNX VAD at the model's published defaults, endpoint cushions
  // removed, then the creator's seam padding (retakeFinalBossSettings, the
  // "Silence settings" modal). Reads the audio waveform, so it is independent of
  // the judge above.
  let silenceRegions: SilenceRegion[] = []
  try {
    silenceRegions = await detectRetakeFinalBossSilences(audio.float32, audio.sampleRate, audio.durationS, fsmnSettings)
  } catch (e) {
    warnings.push(`FSMN silence pass failed (${(e as Error).message}) — no silence removed this run.`)
  }
  const silenceDebug = {
    source: 'fsmn_vad',
    settings: fsmnSettings,
    silence_detector: 'funasr_fsmn_vad_onnx',
    regions_count: silenceRegions.length,
    total_removed_s: Number(silenceRegions.reduce((n, r) => n + (r.end - r.start), 0).toFixed(3)),
    // Full lists so a bad cut/kept stretch can be located exactly (compact [start,end] pairs).
    regions: silenceRegions.map((r) => [Number(r.start.toFixed(2)), Number(r.end.toFixed(2))]),
    kept_words: keptWords.map((w) => [Number(w.start.toFixed(2)), Number(w.end.toFixed(2))])
  }

  // 6. debug JSON (best-effort, private bucket).
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
    summary: `Retake β: ${deleteWordIds.length} word(s) flagged, ${silenceRegions.length} pause(s)`
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
  onProgress?: (pct: number, msg?: string) => void,
  vadSettings: VadSilenceSettings = DEFAULT_VAD_SILENCE_SETTINGS
): Promise<RetakeAwareResult> {
  const warnings: string[] = []
  const op: ProgressFn = (pct, msg) => onProgress?.(pct, msg)
  console.log('[ultracut] cloud job start (DeepSeek first-party judge):', mediaId, ULTRACUT_MODEL)

  // 1. audio — decoded ONCE; transcription, VAD safety scan and the silence
  //    engine all read from this single decode (shared clock).
  op(3, 'Getting your audio ready…')
  const audio = await extractSttAudio(mediaId, (p) => op(3 + Math.round(p * 0.04)))

  // 2. verbatim transcription (AssemblyAI -> Deepgram); emits 8..49. Cached by
  //    mediaId — a re-run reuses the transcript and skips the STT round-trip.
  const { vt, warnings: tw } = await cachedTranscribe(mediaId, audio, op)
  warnings.push(...tw)

  // 3. VAD safety scan (same profile as Retake β) — reused for the payload's
  //    pause markers AND the silence engine below.
  op(56, 'Listening for pauses…')
  let vadSil: { start: number; end: number }[] = []
  try {
    vadSil = (await detectSilenceFloat32(audio.float32, audio.sampleRate, retakeBetaVadSafetyOpts(), audio.durationS)).map((r) => ({
      start: r.start,
      end: r.end
    }))
  } catch (e) {
    warnings.push(`VAD safety scan failed (${(e as Error).message}) — trimming from transcript gaps only.`)
  }

  // 4. WORD-CUT BRAIN — the OpenRouter TEST model (ultracut-judge) over the FULL
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

  // 5. SILENCE — the UNIFIED configurable VAD pass (identical to Retake β).
  op(90, 'Cleaning silence…')
  const artifacts = detectArtifacts(vt.words, baseCutSpans, vadSil)
  const transcript = toAppTranscript({ ...vt, words: artifacts.repairedWords })
  // Only the LLM's cuts drive the retake removals — drop the artifact
  // orphan-cut cleanup too (repairedWords still fixes ASR word timings for the
  // transcript; it just no longer adds cuts the model didn't propose).
  const cutSpans = [...baseCutSpans].sort((a, b) => a.start - b.start)
  const deleteWordIds = spansToWordIds(cutSpans, transcript)

  const keptWords = artifacts.repairedWords.filter((w) => {
    const m = (w.start + w.end) / 2
    return !cutSpans.some((s) => m >= s.start && m <= s.end)
  })
  let silenceRegions: SilenceRegion[] = []
  try {
    silenceRegions = await vadSilenceRegions(audio.float32, audio.sampleRate, audio.durationS, vadSettings, keptWords, 'betavad')
  } catch (e) {
    warnings.push(`Silence VAD pass failed (${(e as Error).message}) — no silence removed this run.`)
  }
  const silenceDebug = {
    source: 'vad_pass',
    settings: vadSettings,
    regions_count: silenceRegions.length,
    total_removed_s: Number(silenceRegions.reduce((n, r) => n + (r.end - r.start), 0).toFixed(3))
  }

  // 6. debug JSON (best-effort, private bucket) — its own mode so ultracut runs
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
    summary: `Ultracut: ${deleteWordIds.length} word(s) flagged, ${silenceRegions.length} pause(s)`
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
