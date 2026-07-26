// Retake Final Boss VAD — a fresh post-Gemma pass with no dependency on any
// previous silence cutter, preset, clamp, pause classifier, or artifact logic.

import type { SilenceRegion } from '@shared/types'
import {
  planFinalBossSilenceCuts,
  type RetakeFinalBossSettings
} from '@shared/retakefinalboss'
import { detectFsmnSilences } from './fsmnVad'

export async function detectRetakeFinalBossSilences(
  float32: Float32Array,
  sampleRate: number,
  durationS: number,
  settings: RetakeFinalBossSettings
): Promise<SilenceRegion[]> {
  const raw = await detectFsmnSilences(
    float32,
    sampleRate,
    durationS
  )
  return planFinalBossSilenceCuts(raw, settings, durationS)
}
