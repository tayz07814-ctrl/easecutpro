// Streaming audio decode via Mediabunny (WebCodecs AudioDecoder) — bounded RAM.
//
// `decodeAudioData` holds the ENTIRE compressed file plus a full-rate decoded
// AudioBuffer in memory at once; on iPhone Safari that combination OOM-kills
// the tab mid-job (the "Last run crashed — likely out of memory" breadcrumb),
// and iOS's legacy decoder refuses some camera containers outright. These
// helpers demux + decode incrementally instead: peak memory is the small
// OUTPUT (16 kHz mono PCM), never the input file, and decoding goes through
// WebCodecs, which Safari supports for camera-recorded AAC. Every caller keeps
// its legacy path as a fallback for browsers without WebCodecs.

type MB = typeof import('mediabunny')
type AudioSampleLike = import('mediabunny').AudioSample
let mbPromise: Promise<MB | null> | null = null
function loadMb(): Promise<MB | null> {
  if (!mbPromise) mbPromise = import('mediabunny').catch(() => null)
  return mbPromise
}

/** Linear-interpolation resampler across chunk boundaries. Holds only a
 *  fractional read cursor + the previous chunk's last sample between pushes,
 *  so input length never drives memory. */
class Resampler {
  private t = 0 // fractional input index of the next output sample
  private consumed = 0 // input samples seen so far
  private prevLast = 0
  constructor(readonly ratio: number) {} // inputRate / outputRate

  push(x: Float32Array, emit: (s: number) => void): void {
    const n = x.length
    if (!n) return
    const end = this.consumed + n
    const val = (k: number): number => (k < this.consumed ? this.prevLast : x[k - this.consumed])
    while (this.t < end) {
      const i0 = Math.floor(this.t)
      const frac = this.t - i0
      if (frac > 0 && i0 + 1 >= end) break // interpolation partner is in the next chunk
      const a = val(i0)
      const b = frac === 0 ? a : val(i0 + 1)
      emit(a + (b - a) * frac)
      this.t += this.ratio
    }
    this.prevLast = x[n - 1]
    this.consumed = end
  }
}

/** Canonical 44-byte PCM WAV header (mono 16-bit). */
function wavHeader(pcmBytes: number, rate = 16000): Uint8Array {
  const b = new ArrayBuffer(44)
  const dv = new DataView(b)
  const ws = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i))
  }
  ws(0, 'RIFF')
  dv.setUint32(4, 36 + pcmBytes, true)
  ws(8, 'WAVE')
  ws(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true) // PCM
  dv.setUint16(22, 1, true) // mono
  dv.setUint32(24, rate, true)
  dv.setUint32(28, rate * 2, true) // byte rate
  dv.setUint16(32, 2, true) // block align
  dv.setUint16(34, 16, true) // bits per sample
  ws(36, 'data')
  dv.setUint32(40, pcmBytes, true)
  return new Uint8Array(b)
}

/** Downmix every channel plane of a decoded sample to mono f32. */
function monoOf(samp: AudioSampleLike): Float32Array {
  const frames = samp.numberOfFrames
  const mono = new Float32Array(frames)
  const plane = new Float32Array(frames)
  for (let c = 0; c < samp.numberOfChannels; c++) {
    samp.copyTo(plane, { planeIndex: c, format: 'f32-planar' })
    for (let i = 0; i < frames; i++) mono[i] += plane[i]
  }
  if (samp.numberOfChannels > 1) {
    for (let i = 0; i < frames; i++) mono[i] /= samp.numberOfChannels
  }
  return mono
}

/** Decode `file`'s audio track to a 16 kHz mono WAV Blob, streaming. Memory use
 *  is bounded by the OUTPUT (~26 MB/hour), not the input video. Returns null
 *  when this browser can't (no WebCodecs / unsupported codec) — callers fall
 *  back to their legacy path. */
export async function streamWav16kMono(
  file: Blob,
  leadSec = 0,
  onProgress?: (pct: number) => void
): Promise<Blob | null> {
  const mb = await loadMb()
  if (!mb) return null
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track || !(await track.canDecode())) return null
    const RATE = 16000
    const res = new Resampler(track.sampleRate / RATE)
    const blocks: Int16Array[] = []
    let block = new Int16Array(RATE * 8) // emit in ~8 s blocks
    let used = 0
    let written = 0
    const lead = Math.max(0, Math.round(leadSec * RATE))
    if (lead > 0) {
      blocks.push(new Int16Array(lead)) // leading silence re-aligns delayed audio
      written += lead
    }
    let dur: number | null = null
    try {
      dur = await input.getDurationFromMetadata()
    } catch {
      /* progress is optional */
    }
    const sink = new mb.AudioSampleSink(track)
    for await (const samp of sink.samples()) {
      const mono = monoOf(samp)
      samp.close()
      res.push(mono, (s) => {
        const v = s < -1 ? -1 : s > 1 ? 1 : s
        block[used++] = v < 0 ? v * 0x8000 : v * 0x7fff
        if (used === block.length) {
          blocks.push(block)
          block = new Int16Array(block.length)
          used = 0
        }
      })
      if (onProgress && dur && dur > 0) onProgress(Math.min(99, (samp.timestamp / dur) * 100))
    }
    if (used > 0) blocks.push(block.subarray(0, used))
    onProgress?.(100)
    // Blob parts avoid concatenating the PCM a second time.
    return new Blob([wavHeader(written * 2, RATE), ...blocks] as BlobPart[], { type: 'audio/wav' })
  } catch {
    return null
  } finally {
    try {
      input.dispose()
    } catch {
      /* already disposed */
    }
  }
}

/** Decode + scan waveform peaks incrementally (max abs across ALL channels —
 *  voice is often recorded on one channel only). Same bounded-memory contract
 *  as streamWav16kMono. */
export async function streamPeaks(
  file: Blob,
  peaksPerSec: number,
  onProgress?: (pct: number) => void
): Promise<{ peaksPerSec: number; peaks: number[] } | null> {
  const mb = await loadMb()
  if (!mb) return null
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track || !(await track.canDecode())) return null
    let dur: number | null = null
    try {
      dur = await input.getDurationFromMetadata()
    } catch {
      /* estimate only */
    }
    const est = dur && dur > 0 ? dur : 60
    let peaks = new Float32Array(Math.ceil(est * peaksPerSec) + peaksPerSec)
    const grow = (need: number): void => {
      if (need <= peaks.length) return
      const next = new Float32Array(Math.max(need, peaks.length * 2))
      next.set(peaks)
      peaks = next
    }
    let lastIdx = -1
    const sink = new mb.AudioSampleSink(track)
    for await (const samp of sink.samples()) {
      const frames = samp.numberOfFrames
      const rate = samp.sampleRate
      const acc = new Float32Array(frames)
      const plane = new Float32Array(frames)
      for (let c = 0; c < samp.numberOfChannels; c++) {
        samp.copyTo(plane, { planeIndex: c, format: 'f32-planar' })
        for (let i = 0; i < frames; i++) {
          const a = plane[i] < 0 ? -plane[i] : plane[i]
          if (a > acc[i]) acc[i] = a
        }
      }
      const base = samp.timestamp
      for (let i = 0; i < frames; i++) {
        const idx = Math.floor((base + i / rate) * peaksPerSec)
        if (idx >= peaks.length) grow(idx + peaksPerSec)
        if (acc[i] > peaks[idx]) peaks[idx] = acc[i]
        if (idx > lastIdx) lastIdx = idx
      }
      samp.close()
      if (onProgress && dur && dur > 0) onProgress(Math.min(99, (samp.timestamp / dur) * 100))
    }
    onProgress?.(100)
    return { peaksPerSec, peaks: Array.from(peaks.subarray(0, Math.max(0, lastIdx + 1))) }
  } catch {
    return null
  } finally {
    try {
      input.dispose()
    } catch {
      /* already disposed */
    }
  }
}
