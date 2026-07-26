// Retake Final Boss VAD — a fresh post-Gemma pass with no dependency on any
// previous silence cutter, preset, clamp, pause classifier, or artifact logic.

import type { SilenceRegion } from '@shared/types'
import {
  planFinalBossSilenceCuts,
  RETAKE_FINAL_BOSS_MIN_SILENCE_S,
  type FinalBossSpeechWord,
  type RetakeFinalBossSettings
} from '@shared/retakefinalboss'
import { detectFsmnSilences } from './fsmnVad'

export async function detectRetakeFinalBossSilences(
  float32: Float32Array,
  sampleRate: number,
  durationS: number,
  settings: RetakeFinalBossSettings,
  survivingWords: FinalBossSpeechWord[]
): Promise<SilenceRegion[]> {
  const raw = await detectFsmnSilences(
    float32,
    sampleRate,
    durationS,
    settings.speechThreshold,
    RETAKE_FINAL_BOSS_MIN_SILENCE_S
  )
  return planFinalBossSilenceCuts(raw, survivingWords, settings, durationS)
}
