// Retake Final Boss VAD — a fresh post-Gemma pass with no dependency on any
// previous silence cutter, preset, clamp, pause classifier, or artifact logic.

import type { SilenceRegion } from '@shared/types'
import {
  alignFinalBossFsmnGaps,
  planFinalBossSilenceCuts,
  TAIL_TRIM_DB,
  TAIL_TRIM_MAX_S,
  TAIL_TRIM_STEP_S,
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

/** Walk a cut backward while the audio it would keep is dead air.
 *
 *  A region's START is the END of the clip before it, so this only ever trims
 *  clip endings — a clip's opening is a region's END and is never touched.
 *
 *  Scanning (rather than testing one fixed window) is what makes this work at
 *  all: on a tight preset the cut already sits at or inside the speech boundary,
 *  so a window ending at the cut samples SPEECH and no trim is ever possible.
 *  Stepping back measures the audio that is actually there, which also lets it
 *  reclaim a tail FSMN mistakenly classified as speech — the usual reason a
 *  "flush" cut still trails off.
 *
 *  Guards: it stops at the first non-quiet step (so a clip ending on a word is
 *  untouched), never walks past TAIL_TRIM_MAX_S, and never crosses the previous
 *  cut or the media start, so it cannot swallow a clip whole. */
function trimQuietTails(
  regions: SilenceRegion[],
  float32: Float32Array,
  sampleRate: number
): SilenceRegion[] {
  const out: SilenceRegion[] = []
  for (const region of regions) {
    const clipStart = out.length ? out[out.length - 1].end : 0
    const floor = Math.max(clipStart, region.start - TAIL_TRIM_MAX_S)
    let cut = region.start
    while (
      cut - TAIL_TRIM_STEP_S >= floor &&
      windowDb(float32, sampleRate, cut - TAIL_TRIM_STEP_S, cut) < TAIL_TRIM_DB
    ) {
      cut -= TAIL_TRIM_STEP_S
    }
    out.push(cut < region.start ? { ...region, start: cut } : { ...region })
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
  // Finally drop any dead-air tail the geometry left on a clip ending — only for
  // the punchy presets, since the relaxed ones exist to KEEP that breathing room.
  return settings.tailTrim ? trimQuietTails(planned, float32, sampleRate) : planned
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
