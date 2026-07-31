// Audio conditioning for the VAD's ANALYSIS COPY.
//
// Nothing here ever touches the audio the creator keeps — preview and export
// still use the original decode. This only shapes the buffer the silence
// detector looks at, where two cheap fixes buy real accuracy:
//
//   HIGH-PASS (80 Hz)  Rumble, HVAC hum, desk thumps and mic handling noise all
//                      live below speech. They lift the noise floor, which is
//                      exactly the contrast the VAD measures, so a pause reads
//                      as "not quiet" and the cut arrives late or not at all.
//                      Speech fundamentals start ~85 Hz (a deep male voice), so
//                      80 Hz removes the problem without touching the voice.
//
//   NORMALISE          VAD thresholds are level-sensitive, and creators' levels
//                      vary hugely between recordings. Bringing everything to a
//                      consistent loudness makes detection behave the same on a
//                      quiet lav and a hot USB mic.
//
// Deliberately NOT a denoiser. Spectral denoisers introduce musical noise and
// pumping, and FSMN-VAD is trained on genuinely noisy speech — feeding it
// artifacts it has never heard can easily cost more accuracy than the cleanup
// gains. These two operations have no such failure mode.

/** Speech fundamentals start around 85 Hz; everything below is noise to a VAD. */
export const HIGHPASS_HZ = 80

/** Target RMS for the detection copy — about -20 dBFS, a normal speech level. */
export const TARGET_RMS = 0.1

/** Bounds on the normalisation gain. Without them a near-silent file would have
 *  its own noise floor amplified to speech level, which is precisely the input
 *  that makes a VAD hallucinate speech. */
export const MIN_GAIN = 0.25
export const MAX_GAIN = 8

/** One-pole-per-stage RBJ high-pass, applied forward only.
 *
 *  Forward-only filtering shifts phase, which would matter for audio the creator
 *  hears — it does not matter here, because only the VAD reads this buffer and it
 *  works on energy envelopes. Skipping the backward pass halves the cost. */
export function highPass(input: Float32Array, sampleRate: number, cutoffHz = HIGHPASS_HZ): Float32Array {
  const out = new Float32Array(input.length)
  if (!input.length || sampleRate <= 0) return out

  const w0 = (2 * Math.PI * cutoffHz) / sampleRate
  const cos0 = Math.cos(w0)
  const sin0 = Math.sin(w0)
  const q = Math.SQRT1_2 // Butterworth: maximally flat, no resonant bump at cutoff
  const alpha = sin0 / (2 * q)

  const b0 = (1 + cos0) / 2
  const b1 = -(1 + cos0)
  const b2 = (1 + cos0) / 2
  const a0 = 1 + alpha
  const a1 = -2 * cos0
  const a2 = 1 - alpha

  const nb0 = b0 / a0
  const nb1 = b1 / a0
  const nb2 = b2 / a0
  const na1 = a1 / a0
  const na2 = a2 / a0

  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i]
    const y0 = nb0 * x0 + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2
    out[i] = y0
    x2 = x1
    x1 = x0
    y2 = y1
    y1 = y0
  }
  return out
}

export function rms(buf: Float32Array): number {
  if (!buf.length) return 0
  let sum = 0
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
  return Math.sqrt(sum / buf.length)
}

function peak(buf: Float32Array): number {
  let p = 0
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i])
    if (a > p) p = a
  }
  return p
}

/** Gain that brings `buf` to TARGET_RMS without clipping or runaway boost. */
export function normalizeGain(buf: Float32Array): number {
  const r = rms(buf)
  if (r <= 0) return 1
  let g = TARGET_RMS / r
  const p = peak(buf)
  // Never drive peaks into clipping — a clipped detection copy has square edges
  // that read as broadband energy, i.e. as speech.
  if (p > 0) g = Math.min(g, 0.95 / p)
  return Math.max(MIN_GAIN, Math.min(MAX_GAIN, g))
}

export interface ConditionedAudio {
  /** High-passed ONLY. Absolute dB thresholds (the quiet-tail trim) must measure
   *  this, never the normalised copy — normalising would move the goalposts and
   *  make a fixed -22 dBFS threshold mean something different per file. */
  measured: Float32Array
  /** High-passed AND level-normalised: what the VAD actually sees. */
  detection: Float32Array
  /** Gain applied to `detection` (1 when the audio was already well levelled). */
  gain: number
}

/** Prepare an analysis copy for the silence detector.
 *
 *  When the file is already at a sane level the normalisation gain lands near 1
 *  and `detection` reuses `measured` rather than allocating a second full-length
 *  buffer — that matters on a long recording, where each copy is tens of MB. */
export function conditionForVad(
  input: Float32Array,
  sampleRate: number,
  cutoffHz = HIGHPASS_HZ
): ConditionedAudio {
  const measured = highPass(input, sampleRate, cutoffHz)
  const gain = normalizeGain(measured)
  if (Math.abs(gain - 1) < 0.02) return { measured, detection: measured, gain: 1 }
  const detection = new Float32Array(measured.length)
  for (let i = 0; i < measured.length; i++) detection[i] = measured[i] * gain
  return { measured, detection, gain }
}
