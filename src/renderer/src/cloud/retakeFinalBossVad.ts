// Retake Final Boss VAD — a fresh post-Gemma pass with no dependency on any
// previous silence cutter, preset, clamp, pause classifier, or artifact logic.

import type { SilenceRegion } from '@shared/types'
import {
  alignFinalBossFsmnGaps,
  planFinalBossSilenceCuts,
  TAIL_TRIM_DB,
  TAIL_TRIM_WINDOW_S,
  type RetakeFinalBossSettings
} from '@shared/retakefinalboss'
import { detectFsmnSilences } from './fsmnVad'

/** RMS level of [t0, t1) as dBFS. -Infinity for an empty or digitally silent
 *  window, which reads as "quieter than any threshold". */
function windowDb(float32: Float32Array, sampleRate: number, t0: number, t1: number): number {
  const a = Math.max(0, Math.floor(t0 * sampleRate))
  const b = Math.min(float32.length, Math.ceil(t1 * sampleRate))
  if (b <= a) return -Infinity
  let sum = 0
  for (let i = a; i < b; i++) sum += float32[i] * float32[i]
  const rms = Math.sqrt(sum / (b - a))
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity
}

/** Pull a cut earlier when the clip it ends is trailing off into dead air (see
 *  TAIL_TRIM_DB / TAIL_TRIM_WINDOW_S). A region's START is the END of the clip
 *  before it, so measuring there only ever trims clip endings — a clip's opening
 *  is a region's END and is never touched.
 *
 *  Guards: the measured window must fit entirely inside the preceding clip, so
 *  the trim can never reach across the previous cut or before the media start,
 *  and can never swallow a clip whole. */
function trimQuietTails(
  regions: SilenceRegion[],
  float32: Float32Array,
  sampleRate: number
): SilenceRegion[] {
  const out: SilenceRegion[] = []
  for (const region of regions) {
    const clipStart = out.length ? out[out.length - 1].end : 0
    const tailStart = region.start - TAIL_TRIM_WINDOW_S
    const trimmable =
      tailStart >= clipStart && windowDb(float32, sampleRate, tailStart, region.start) < TAIL_TRIM_DB
    out.push(trimmable ? { ...region, start: tailStart } : { ...region })
  }
  return out
}

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
  // Keep FSMN completely at its published defaults, then remove only the fixed
  // endpoint timestamp cushion before applying the user's seam geometry.
  const aligned = alignFinalBossFsmnGaps(raw, durationS)
  const planned = planFinalBossSilenceCuts(aligned, settings, durationS)
  // Finally drop any dead-air tail the geometry left on a clip ending.
  return trimQuietTails(planned, float32, sampleRate)
}

/** Silence-only pass for the "Find Silences" button: the SAME FSMN engine and
 *  settings Find cuts uses, with no transcription and no retake judge. */
export async function fsmnSilenceOnly(
  float32: Float32Array,
  sampleRate: number,
  durationS: number,
  settings: RetakeFinalBossSettings
): Promise<SilenceRegion[]> {
  return detectRetakeFinalBossSilences(float32, sampleRate, durationS, settings)
}
