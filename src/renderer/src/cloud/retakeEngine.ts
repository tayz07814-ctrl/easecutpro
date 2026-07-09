// Cloud build — Retake-Aware Cut Beta wrapper for the browser (no PC server).
//
// The orchestration is the SAME shared core Electron runs
// (src/shared/retakeaware/engine.ts) — this file only binds its deps to the
// cloud services: audio decoded in the browser (audio.ts), verbatim STT via
// the Supabase `stt` edge function (stt.ts), Silero VAD via onnxruntime-web
// over the SAME decoded samples (vad.ts), and the LLM judge via the
// `llm-judge` edge function (parsed with the shared parseLlmDecisions, so a
// bad reply degrades to rule-based decisions exactly like the Node path).
// Debug JSON is console-only here — there is no disk to write it to.

import type { RetakeAwareResult, ReviewPayload, LlmDecisions } from '@shared/retakeaware/types'
import type { Transcript } from '@shared/types'
import type { LlmJudgeReq, LlmJudgeRes } from '@shared/cloud'
import {
  runRetakeAwareCut,
  toAppTranscript,
  parseLlmDecisions,
  type RetakeEngineDeps,
  type ProgressFn
} from '@shared/retakeaware/engine'
import { DEFAULT_RETAKE_BETA_SILENCE_SETTINGS, type RetakeBetaSilenceSettings } from '@shared/retakeaware/silence'
import { invokeEdge } from './supabase'
import { extractSttAudio } from './audio'
import { transcribeVerbatimCloud } from './stt'
import { detectSilenceFloat32 } from './vad'

/** Browser twin of src/main/retakeaware/llm.ts reviewRetakeGroups: the edge
 *  function picks the judge (Anthropic -> OpenAI -> none) and returns the raw
 *  model text; parsing + every degradation path stays client-side so the
 *  warnings match the Node run word for word. Never throws. */
async function reviewRetakeGroupsCloud(
  payload: ReviewPayload,
  warnings: string[]
): Promise<{ decisions: LlmDecisions | null; judge: string }> {
  try {
    const res = await invokeEdge<LlmJudgeRes>('llm-judge', { payload } satisfies LlmJudgeReq)
    if (res.judge === 'none') {
      warnings.push('No LLM key configured — retake decisions are rule-based only.')
      return { decisions: null, judge: 'none' }
    }
    // raw null with a real judge = the function had a key but its provider
    // call failed — same degradation (and warning) as a judge.review() throw.
    if (res.raw == null) {
      warnings.push('LLM review failed (the edge function got no reply from the model) — using rule-based decisions.')
      return { decisions: null, judge: res.judge }
    }
    return { decisions: parseLlmDecisions(res.raw, warnings), judge: res.judge }
  } catch (e) {
    warnings.push(`LLM review failed (${(e as Error).message}) — using rule-based decisions.`)
    console.warn('[retake-aware-beta] LLM review failed:', (e as Error).message)
    return { decisions: null, judge: 'none' }
  }
}

export async function retakeAwareCutCloud(
  mediaId: string,
  onProgress?: (pct: number, msg?: string) => void,
  silenceSettings: RetakeBetaSilenceSettings = DEFAULT_RETAKE_BETA_SILENCE_SETTINGS
): Promise<RetakeAwareResult> {
  const warnings: string[] = []
  const op: ProgressFn = (pct, msg) => onProgress?.(pct, msg)
  console.log('[retake-aware-beta] cloud job start:', mediaId)

  // 1. audio — decoded ONCE in the browser; the upload blob, the VAD samples
  // and the transcription all come from this single decode (shared clock).
  op(3, 'Retake β: extracting audio…')
  const audio = await extractSttAudio(mediaId, (p) => op(3 + Math.round(p * 0.04)))

  const deps: RetakeEngineDeps = {
    transcribeVerbatim: (p) => transcribeVerbatimCloud(audio, p),
    detectSilence: (opts) => detectSilenceFloat32(audio.float32, audio.sampleRate, opts, audio.durationS),
    reviewRetakeGroups: reviewRetakeGroupsCloud,
    saveDebug: async (json) => {
      // No disk in the cloud build — one console line keeps the run debuggable
      // (copy the object from devtools when a run needs dissecting).
      console.debug(`[retake-aware-beta] debug JSON (${json.length} bytes) — not persisted in the cloud build`)
      return null
    }
  }
  return runRetakeAwareCut(deps, onProgress, silenceSettings, warnings)
}

/** Plain cloud transcription for the Transcribe button: same audio + provider
 *  chain as the beta engine, converted to the app transcript shape (rw0../rs0..
 *  ids) with the shared toAppTranscript. */
export async function transcribeCloud(
  mediaId: string,
  onProgress?: (pct: number, msg?: string) => void
): Promise<Transcript> {
  const op: ProgressFn = (pct, msg) => onProgress?.(pct, msg)
  op(3, 'Extracting audio…')
  const audio = await extractSttAudio(mediaId, (p) => op(3 + Math.round(p * 0.04)))
  const { vt } = await transcribeVerbatimCloud(audio, op)
  return toAppTranscript(vt)
}
