// Branch-only Retake silence cutter. It runs one fresh VAD pass AFTER the judge
// EDL, then delegates all edit decisions to the pure shared planner.

import type { SilenceRegion } from '@shared/types'
import { planRetakeSilenceCuts } from '@shared/retakesilence'
import { vadSilenceToOpts, type PauseContextWord, type VadSilenceSettings } from '@shared/vadsilence'
import { detectSilenceFloat32 } from './vad'

export async function detectRetakeSilenceCuts(
  float32: Float32Array,
  sampleRate: number,
  durationS: number,
  settings: VadSilenceSettings,
  survivingWords: PauseContextWord[]
): Promise<SilenceRegion[]> {
  // Raw map only: padding and final cut geometry belong to the planner. Growing
  // regions here could turn quiet speech into a candidate that touches a word.
  const opts = {
    ...vadSilenceToOpts(settings),
    padBeforeMs: 0,
    padAfterMs: 0,
    edgeTrimMs: 0
  }
  const raw = await detectSilenceFloat32(float32, sampleRate, opts, durationS)
  return planRetakeSilenceCuts(raw, survivingWords, settings, durationS)
}
