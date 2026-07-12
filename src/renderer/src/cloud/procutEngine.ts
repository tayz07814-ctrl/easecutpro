// Cloud build — ProCut (CutCutPro) for the browser (no PC server).
//
// The cloud ProCut is the desktop pipeline with its two non-portable phases
// swapped for cloud services and its GPT "listening" pass DROPPED (that stays
// desktop-only): AssemblyAI transcribes (stt edge fn), Silero VAD runs in the
// browser over the same decode, and Claude is the SINGLE finalizer (procut-judge
// edge fn, given an empty first-pass proposal so it does the full analysis).
// Everything else is the SAME shared, pure logic Electron runs
// (src/shared/cutcutpro.ts: buildTimestampMap -> buildAiPayload -> validateEdl
// -> refineEdl -> edlToEdits), so the review-first contract and cut quality
// match the desktop path. The desktop GPT/whisper code is untouched.

import type { Transcript } from '@shared/types'
import type { ProcutJudgeReq, ProcutJudgeRes } from '@shared/cloud'
import {
  buildTimestampMap,
  buildAiPayload,
  validateEdl,
  refineEdl,
  edlToEdits,
  type Edl,
  type TimestampMap,
  type CutCutProResult
} from '@shared/cutcutpro'
import { toAppTranscript } from '@shared/retakeaware/engine'
import { DEFAULT_VAD_SILENCE_SETTINGS, vadSilenceToOpts, type VadSilenceSettings } from '@shared/vadsilence'
import { invokeEdge } from './supabase'
import { extractSttAudio, type SttAudio } from './audio'
import { transcribeVerbatimCloud } from './stt'
import { detectSilenceFloat32, clampSilenceRegions } from './vad'

/**
 * Cloud twin of src/main/cutcutpro.ts cutCutPro. `runVad=false` (the VAD testing
 * switch is off) makes it do WORD cuts only — silence is handled at Execute —
 * exactly like the desktop path.
 */
export async function cutCutProCloud(
  mediaId: string,
  existing: Transcript | null,
  runVad: boolean,
  script: string | undefined,
  vadSettings: VadSilenceSettings = DEFAULT_VAD_SILENCE_SETTINGS,
  onProgress?: (pct: number, msg?: string) => void
): Promise<CutCutProResult> {
  const op = (pct: number, msg?: string): void => onProgress?.(pct, msg)
  const warnings: string[] = []

  // ---- Phase 1: transcription (AssemblyAI) + pause mapping -------------------
  // One decode feeds BOTH the transcript and the VAD (shared clock). Reused when
  // the project already has a transcript, and skipped entirely when we need
  // neither a transcript nor the VAD.
  let transcript = existing
  let audio: SttAudio | null = null
  if (!transcript) {
    op(2, 'Cut Lord is transcribing (1/4)…')
    audio = await extractSttAudio(mediaId, (p) => op(2 + Math.round(p * 0.05), 'Cut Lord is getting your audio…'))
    const { vt, warnings: w } = await transcribeVerbatimCloud(audio, op)
    warnings.push(...w)
    transcript = toAppTranscript(vt)
  }

  let vad: { start: number; end: number }[] = []
  if (runVad) {
    try {
      op(52, 'Cut Lord is mapping pauses (1/4)…')
      if (!audio) audio = await extractSttAudio(mediaId)
      const regions = await detectSilenceFloat32(audio.float32, audio.sampleRate, vadSilenceToOpts(vadSettings), audio.durationS)
      vad = regions.map((r) => ({ start: r.start, end: r.end }))
    } catch (e) {
      warnings.push(`VAD unavailable (${(e as Error).message}) — pauses from word gaps only.`)
    }
  }

  const map: TimestampMap = buildTimestampMap(transcript.words, vad)
  let payload = buildAiPayload(map)
  if (script?.trim()) {
    payload += `\n\nCREATOR'S INTENDED SCRIPT (ground truth — this is what the final video should say):\n"""\n${script.trim()}\n"""\nUse it to decide the cuts: among repeated takes KEEP THE LAST take that matches the script; speech that deviates from the script (flubbed lines, asides, production talk, abandoned tangents) is cut material. Do NOT cut a line merely because the wording differs slightly — natural delivery beats verbatim — but content with no counterpart in the script does not belong in the final video.`
  }

  // ---- Phase 3: Claude finalization (no GPT first pass in the cloud) ----------
  op(72, 'Cut Lord is finalizing (3/4)…')
  let finalEdl: Edl = { word_cuts: [], pause_cuts: [] }
  try {
    const res = await invokeEdge<ProcutJudgeRes>('procut-judge', {
      payload,
      proposal: { word_cuts: [], pause_cuts: [] }
    } satisfies ProcutJudgeReq)
    if (res.judge === 'none') {
      warnings.push('ProCut needs a Claude key configured on the server — nothing was cut.')
    } else if (res.raw == null) {
      warnings.push('ProCut’s finalizer got no reply from the model — nothing was cut.')
    } else {
      const v = validateEdl(res.raw, map)
      // VAD owns silence now (Phase 4 below); ignore any pause_cuts the model returned.
      if (v.ok) finalEdl = { word_cuts: v.edl.word_cuts, pause_cuts: [] }
      else warnings.push('ProCut’s finalizer returned an unusable EDL — nothing was cut.')
    }
  } catch (e) {
    warnings.push(`ProCut finalizer failed (${(e as Error).message}).`)
  }

  // ---- Phase 4: word cuts via the EDL + silence via the unified VAD pass ------
  op(88, 'Cut Lord is cutting (4/4)…')
  const refined = refineEdl(finalEdl, map)
  const edits = edlToEdits(refined.edl, map, transcript.words) // pause_cuts empty → silenceAdds []
  // SILENCE = the configurable VAD pass (replaces Opus pause cuts). Clamp the
  // same VAD regions off the words the EDL keeps, so no kept word onset clips.
  let silenceAdds = edits.silenceAdds
  if (runVad && vad.length) {
    const cut = new Set(edits.deleteWordIds)
    const keptWords = transcript.words.filter((w) => !w.deleted && !cut.has(w.id))
    silenceAdds = clampSilenceRegions(vad, keptWords, 'procutvad')
  }

  op(100, 'Cut Lord finished')
  return {
    transcript: existing ? null : transcript,
    deleteWordIds: edits.deleteWordIds,
    silenceAdds,
    debugPath: '',
    warnings,
    summary: `ProCut flagged ${edits.deleteWordIds.length} word(s) + ${silenceAdds.length} pause(s).`
  }
}
