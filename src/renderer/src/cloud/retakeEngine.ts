// Cloud build — Retake-Aware Cut Beta for the browser (no PC server).
//
// WORD CUTS are now LLM-first, "ProCut style": instead of the rules-first
// detectors deciding the cuts and Opus only adjudicating the ambiguous ones, the
// FULL index-anchored transcript (shared/cutcutpro buildAiPayload) goes to the
// SAME Opus finalizer ProCut uses (the `procut-judge` edge fn, empty first pass)
// and Opus scans everything and returns the cut EDL. This closes the recall gap
// vs ProCut — Opus is the detector, not a downstream referee.
//
// SILENCE now uses the UNIFIED configurable VAD pass shared with ProCut
// (vad.ts vadSilenceRegions, driven by the store's VadSilenceSettings): raw
// Silero speech detection + asymmetric guard padding + edge trim + breath
// removal, then clamped off the kept words. This REPLACES the transcript-gap
// hybrid + vadHardCut toggle in the cloud build. The desktop path
// (src/main/retakeaware, runRetakeAwareCut) still uses the hybrid, untouched.
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
  refineEdl,
  type Edl,
  type TimestampMap
} from '@shared/cutcutpro'
import { toAppTranscript, type ProgressFn } from '@shared/retakeaware/engine'
import { spansToWordIds } from '@shared/retakeaware/analyze'
import { detectArtifacts } from '@shared/retakeaware/artifacts'
import { retakeBetaVadSafetyOpts } from '@shared/retakeaware/silence'
import { DEFAULT_VAD_SILENCE_SETTINGS, type VadSilenceSettings } from '@shared/vadsilence'
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
  vadSettings: VadSilenceSettings = DEFAULT_VAD_SILENCE_SETTINGS
): Promise<RetakeAwareResult> {
  const warnings: string[] = []
  const op: ProgressFn = (pct, msg) => onProgress?.(pct, msg)
  console.log('[retake-aware-beta] cloud job start (retake04-judge — new prompt + gpt-oss-20b, easecut0.04):', mediaId)

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

  // 4. WORD-CUT BRAIN — easecut0.04 TEST: the creator's new retake-editor prompt on
  //    openai/gpt-oss-20b (OpenRouter, reasoning:medium). Routed to the ISOLATED
  //    `retake04-judge` edge fn (a clone of ultracut-judge whose only difference is
  //    that prompt) so this branch A/Bs the new prompt WITHOUT touching the shared
  //    `ultracut-judge` that main/production use. This is the SMALL-model lane; the
  //    Ultracut β button runs the SAME prompt on gpt-oss-120b for comparison. main
  //    never calls retake04-judge, so main stays as-is.
  op(72, 'Cut Lord is judging your takes…')
  // buildTimestampMap wants app Words (id/text); the pre-artifact transcript is
  // 1:1 with vt.words, so EDL word indices resolve to the right times. The FINAL
  // transcript (from repaired words) is rebuilt after the judge pass below.
  const map = buildTimestampMap(toAppTranscript(vt).words, vadSil)
  const payload = buildAiPayload(map)
  let baseCutSpans: CutSpan[] = []
  let claudeRaw: string | null = null
  try {
    const res = await invokeEdge<ProcutJudgeRes>('retake04-judge', {
      payload,
      proposal: { word_cuts: [], pause_cuts: [] },
      model: 'openai/gpt-oss-20b',
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
        baseCutSpans = edlToRetakeCutSpans(refineEdl(v.edl, map).edl, map)
      }
    }
  } catch {
    warnings.push('Retake β couldn’t finish — please try again.')
  }

  // 5. SILENCE — the UNIFIED configurable VAD pass (shared with ProCut). ASR-
  //    artifact repair still runs (stretched-word clamp + orphan record-clicks)
  //    so the word-clamp inside vadSilenceRegions protects real words; then it
  //    cuts silence per the user's VadSilenceSettings.
  op(90, 'Cleaning silence…')
  const artifacts = detectArtifacts(vt.words, baseCutSpans, vadSil)
  const transcript = toAppTranscript({ ...vt, words: artifacts.repairedWords })
  const cutSpans = [...baseCutSpans, ...artifacts.orphanCutSpans].sort((a, b) => a.start - b.start)
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
// easecut0.04 A/B: the Ultracut Beta button runs the SAME new retake-editor prompt as
// Retake β (both on the isolated `retake04-judge` edge fn), but on the LARGER model —
// openai/gpt-oss-120b via OpenRouter, reasoning:'medium'. Retake β uses gpt-oss-20b,
// so the two buttons compare the 120b vs 20b judge on identical prompt + payload.
// Scoped to this branch: retake04-judge is never called from main. gpt-oss-120b is
// cheaper + faster than the old deepseek-v4-flash judge.
const ULTRACUT_MODEL = 'openai/gpt-oss-120b'
export async function ultracutCutCloud(
  mediaId: string,
  onProgress?: (pct: number, msg?: string) => void,
  vadSettings: VadSilenceSettings = DEFAULT_VAD_SILENCE_SETTINGS
): Promise<RetakeAwareResult> {
  const warnings: string[] = []
  const op: ProgressFn = (pct, msg) => onProgress?.(pct, msg)
  console.log('[ultracut] cloud job start (retake04-judge — new prompt + gpt-oss-120b, easecut0.04):', mediaId, ULTRACUT_MODEL)

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

  // 4. WORD-CUT BRAIN — the isolated retake04-judge (our new prompt) on gpt-oss-120b
  //    over the FULL transcript. Same index-anchored WORD-LIST payload (buildAiPayload)
  //    + validateEdl as Retake β; only the model size differs (120b here vs 20b there),
  //    so this button is the LARGE-model half of the easecut0.04 A/B.
  op(72, 'Ultracut is judging your takes…')
  const map = buildTimestampMap(toAppTranscript(vt).words, vadSil)
  const payload = buildAiPayload(map)
  let baseCutSpans: CutSpan[] = []
  let modelRaw: string | null = null
  try {
    const res = await invokeEdge<ProcutJudgeRes>('retake04-judge', {
      payload,
      proposal: { word_cuts: [], pause_cuts: [] },
      model: ULTRACUT_MODEL,
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
        baseCutSpans = edlToRetakeCutSpans(refineEdl(v.edl, map).edl, map)
      }
    }
  } catch {
    warnings.push('Ultracut couldn’t finish — please try again.')
  }

  // 5. SILENCE — the UNIFIED configurable VAD pass (identical to Retake β).
  op(90, 'Cleaning silence…')
  const artifacts = detectArtifacts(vt.words, baseCutSpans, vadSil)
  const transcript = toAppTranscript({ ...vt, words: artifacts.repairedWords })
  const cutSpans = [...baseCutSpans, ...artifacts.orphanCutSpans].sort((a, b) => a.start - b.start)
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
