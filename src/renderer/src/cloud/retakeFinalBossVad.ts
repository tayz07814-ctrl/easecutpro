// Retake Final Boss VAD — a fresh post-Gemma pass with no dependency on any
// previous silence cutter, preset, clamp, pause classifier, or artifact logic.

import type { SilenceRegion } from '@shared/types'
import {
  planFinalBossSilenceCuts,
  type FinalBossSpeechWord,
  type RetakeFinalBossSettings
} from '@shared/retakefinalboss'
import { detectSilenceFloat32 } from './vad'

const FIXED_MIN_SILENCE_S = 0.25

export async function detectRetakeFinalBossSilences(
  float32: Float32Array,
  sampleRate: number,
  durationS: number,
  settings: RetakeFinalBossSettings,
  survivingWords: FinalBossSpeechWord[]
): Promise<SilenceRegion[]> {
  const raw = await detectSilenceFloat32(float32, sampleRate, {
    mode: 'vad',
    noiseDb: -40,
    vadThreshold: settings.speechThreshold,
    minDuration: FIXED_MIN_SILENCE_S,
    speechPadMs: 0,
    padBeforeMs: 0,
    padAfterMs: 0,
    edgeTrimMs: 0,
    removeBreaths: false
  }, durationS)
  return planFinalBossSilenceCuts(raw, survivingWords, settings, durationS)
}
