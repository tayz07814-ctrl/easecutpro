// Retake Final Boss — isolated cloud engine for the 0.07 branch.
//
// Pipeline: timeline audio -> AssemblyAI verbatim words -> words-only Gemma
// judge -> fresh Final Boss VAD -> review staging. No previous Retake analysis,
// artifact repair, pause map, incomplete-sentence predictor, silence planner,
// or model fallback participates in this path.

import type { RetakeAwareResult, CutSpan } from '@shared/retakeaware/types'
import type { SilenceRegion } from '@shared/types'
import type { RetakeFinalBossJudgeReq, RetakeFinalBossJudgeRes } from '@shared/cloud'
import {
  buildFinalBossVerbatimPayload,
  validateFinalBossWordCuts,
  type RetakeFinalBossSettings
} from '@shared/retakefinalboss'
import { toAppTranscript, type ProgressFn } from '@shared/retakeaware/engine'
import { getSupabase, invokeEdge } from './supabase'
import { extractSttAudio } from './audio'
import { transcribeAssemblyAiOnlyCloud } from './stt'
import { detectRetakeFinalBossSilences } from './retakeFinalBossVad'

async function saveFinalBossDebug(debug: Record<string, unknown>): Promise<string | null> {
  try {
    const supabase = getSupabase()
    const { data } = await supabase.auth.getUser()
    const uid = data.user?.id ?? 'anon'
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const path = `${uid}/${stamp}-retake-final-boss.json`
    const { error } = await supabase.storage
      .from('retake-aware-debugs')
      .upload(path, new Blob([JSON.stringify({ mode: 'retake_final_boss', ...debug }, null, 2)], { type: 'application/json' }), {
        contentType: 'application/json',
        upsert: false
      })
    if (error) return null
    return path
  } catch {
    return null
  }
}

export async function retakeFinalBossCloud(
  mediaId: string,
  onProgress: ((pct: number, msg?: string) => void) | undefined,
  settings: RetakeFinalBossSettings
): Promise<RetakeAwareResult> {
  const warnings: string[] = []
  const op: ProgressFn = (pct, msg) => onProgress?.(pct, msg)

  op(3, 'Preparing timeline audio…')
  const audio = await extractSttAudio(mediaId, (percent) => op(3 + Math.round(percent * 0.04)))

  // AssemblyAI is mandatory for this engine. The complete returned transcript
  // is retained for display/review, but only its word strings reach Gemma.
  const verbatim = await transcribeAssemblyAiOnlyCloud(audio, op)
  const transcript = toAppTranscript(verbatim)
  const payload = buildFinalBossVerbatimPayload(verbatim.words)

  op(65, 'Judging retakes…')
  let judgeRaw: string | null = null
  let wordCuts = [] as NonNullable<ReturnType<typeof validateFinalBossWordCuts>>
  try {
    const response = await invokeEdge<RetakeFinalBossJudgeRes>(
      'retakefinalboss',
      { payload } satisfies RetakeFinalBossJudgeReq
    )
    judgeRaw = response.raw
    if (response.judge === 'none') warnings.push('Retake Final Boss is not configured on the server.')
    else if (response.raw == null) warnings.push('Retake Final Boss returned no cut decisions.')
    else {
      const validated = validateFinalBossWordCuts(response.raw, verbatim.words.length)
      if (validated == null) warnings.push('Retake Final Boss returned an invalid cut list, so no word cuts were staged.')
      else {
        wordCuts = validated
        if (validated.length === 0) warnings.push('No automatic word cuts were suggested; the complete transcript is still available for review.')
      }
    }
  } catch {
    warnings.push('Retake Final Boss could not finish judging this transcript.')
  }

  const cutSpans: CutSpan[] = wordCuts.flatMap((cut) => {
    const first = verbatim.words[cut.from]
    const last = verbatim.words[cut.to]
    return first && last
      ? [{
          start: first.start,
          end: last.end,
          type: 'failed_retake' as const,
          source: 'retake_final_boss' as const,
          reason: cut.reason || 'earlier retake; final delivery kept'
        }]
      : []
  })
  const deleteIndices = new Set<number>()
  for (const cut of wordCuts) for (let index = cut.from; index <= cut.to; index++) deleteIndices.add(index)
  const deleteWordIds = [...deleteIndices].sort((a, b) => a - b).flatMap((index) => transcript.words[index]?.id ? [transcript.words[index].id] : [])

  // This is the only silence stage in Final Boss, and it always runs last.
  op(88, 'Running Final Boss silence detection…')
  const survivingWords = verbatim.words.filter((_, index) => !deleteIndices.has(index))
  let silenceRegions: SilenceRegion[] = []
  try {
    silenceRegions = await detectRetakeFinalBossSilences(
      audio.float32,
      audio.sampleRate,
      audio.durationS,
      settings,
      survivingWords
    )
  } catch {
    warnings.push('Final Boss silence detection could not finish; word cuts are still available.')
  }

  const debugPath = await saveFinalBossDebug({
    provider: 'assemblyai',
    silence_detector: 'funasr_fsmn_vad_onnx',
    verbatim_word_count: verbatim.words.length,
    gemma_payload: payload,
    judge_raw: judgeRaw,
    word_cuts: wordCuts,
    silence_settings: settings,
    silence_regions: silenceRegions,
    warnings
  })

  op(100, 'Retake Final Boss finished')
  return {
    cut_mode: 'retake_final_boss',
    provider: 'assemblyai',
    verbatim,
    transcript,
    deleteWordIds,
    cutSpans,
    silenceRegions,
    retakeGroups: [],
    fillerDecisions: [],
    debugPath,
    warnings,
    summary: `Retake Final Boss: ${deleteWordIds.length} word(s) flagged, ${silenceRegions.length} silence cut(s)`
  }
}
