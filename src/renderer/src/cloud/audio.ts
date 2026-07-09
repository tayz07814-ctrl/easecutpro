// Cloud build — STT audio extraction, fully in the browser (no PC server).
//
// One decode feeds EVERYTHING: webmedia's battle-tested extractAudioWavBlob
// (16 kHz mono, phone-.mov delayed-audio lead already re-aligned via the elst
// parse) is decoded once, its PCM re-read as Float32 for the in-browser VAD,
// and the SAME samples become the upload blob — so transcription timestamps
// and the VAD silence map are guaranteed to describe identical audio.
//
// Upload size: a WAV minute is ~1.9 MB; AAC at 64 kbps is ~0.5 MB. When the
// browser has WebCodecs AudioEncoder we mux an audio-only m4a (mp4-muxer, the
// same dependency the on-device exporter uses); otherwise the plain WAV goes
// up. Both providers accept either container.

import { Muxer, ArrayBufferTarget } from 'mp4-muxer'
import { extractAudioWavBlob } from '../webmedia'

/** Sample rate of webmedia's extracted WAV — the timebase for STT + VAD. */
const STT_RATE = 16000
const AAC_BITRATE = 64_000

export interface SttAudio {
  /** upload payload (audio-only m4a when AAC encoding worked, else the WAV). */
  blob: Blob
  /** audio container extension for the stt sign-upload action: 'm4a' | 'wav'. */
  ext: string
  /** the decoded samples themselves (16 kHz mono, lead-aligned) — feed the VAD
   *  with THESE so silence and words share one clock. */
  float32: Float32Array
  sampleRate: number
  durationS: number
}

/** Re-read the 16-bit PCM of the WAV we just encoded — no second decode, and
 *  the VAD sees byte-for-byte what the providers will hear (lead included). */
function wavToFloat32(buf: ArrayBuffer): Float32Array<ArrayBuffer> {
  const pcm = new Int16Array(buf, 44) // 44-byte canonical header (webmedia's encodeWav)
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i]
    out[i] = s < 0 ? s / 0x8000 : s / 0x7fff
  }
  return out
}

/** Resample mono Float32 via OfflineAudioContext (only used when the AAC
 *  encoder rejects 16 kHz and needs a mainstream rate). */
async function resampleFloat32(f32: Float32Array<ArrayBuffer>, from: number, to: number): Promise<Float32Array<ArrayBuffer>> {
  const frames = Math.max(1, Math.ceil((f32.length / from) * to))
  const oc = new OfflineAudioContext(1, frames, to)
  const buf = oc.createBuffer(1, Math.max(1, f32.length), from)
  buf.copyToChannel(f32, 0)
  const src = oc.createBufferSource()
  src.buffer = buf
  src.connect(oc.destination)
  src.start()
  const rendered = await oc.startRendering()
  return rendered.getChannelData(0)
}

/** Encode mono Float32 → audio-only AAC m4a. null when WebCodecs AAC is
 *  unavailable/unsupported (caller falls back to the WAV). */
async function encodeAacM4a(float32: Float32Array<ArrayBuffer>): Promise<Blob | null> {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return null
  try {
    const cfgFor = (r: number): AudioEncoderConfig => ({ codec: 'mp4a.40.2', sampleRate: r, numberOfChannels: 1, bitrate: AAC_BITRATE })
    // 16 kHz mono AAC first (smallest); some encoders only take mainstream
    // rates — resample to 48 kHz and retry before giving up.
    let rate = STT_RATE
    let samples = float32
    let ok = false
    try {
      ok = !!(await AudioEncoder.isConfigSupported(cfgFor(rate))).supported
    } catch {
      ok = false
    }
    if (!ok) {
      rate = 48000
      try {
        ok = !!(await AudioEncoder.isConfigSupported(cfgFor(rate))).supported
      } catch {
        ok = false
      }
      if (!ok) return null
      samples = await resampleFloat32(float32, STT_RATE, rate)
    }
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      audio: { codec: 'aac', sampleRate: rate, numberOfChannels: 1 },
      fastStart: 'in-memory'
    })
    const encErr: { e: Error | null } = { e: null }
    const enc = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => { encErr.e = e as Error }
    })
    enc.configure(cfgFor(rate))
    const CHUNK = 16384 // frames per AudioData (~1s at 16 kHz)
    for (let off = 0; off < samples.length; off += CHUNK) {
      const n = Math.min(CHUNK, samples.length - off)
      const data = new AudioData({
        format: 'f32-planar',
        sampleRate: rate,
        numberOfFrames: n,
        numberOfChannels: 1,
        timestamp: Math.round((off / rate) * 1e6), // µs
        data: samples.subarray(off, off + n)
      })
      enc.encode(data)
      data.close()
    }
    await enc.flush()
    enc.close()
    if (encErr.e) return null
    muxer.finalize()
    return new Blob([muxer.target.buffer], { type: 'audio/mp4' })
  } catch {
    return null // encoder quirk — the WAV path always works
  }
}

/** Decode a `webmedia:` id's audio → 16 kHz mono Float32 (lead-aligned), for
 *  standalone VAD use. Throws an honest error when the browser can't decode. */
export async function decodeAudioFloat32(
  mediaId: string,
  onProgress?: (pct: number) => void
): Promise<{ float32: Float32Array; sampleRate: number; durationS: number }> {
  const wav = await extractAudioWavBlob(mediaId, onProgress)
  if (!wav) {
    throw new Error('Could not decode this media’s audio in the browser (unsupported codec or the file is too large).')
  }
  const float32 = wavToFloat32(await wav.arrayBuffer())
  return { float32, sampleRate: STT_RATE, durationS: float32.length / STT_RATE }
}

/** Produce the STT audio for a `webmedia:` id: decode once, return the upload
 *  blob (AAC m4a when possible, else WAV) + the decoded samples for the VAD. */
export async function extractSttAudio(mediaId: string, onProgress?: (pct: number) => void): Promise<SttAudio> {
  const wav = await extractAudioWavBlob(mediaId, (p) => onProgress?.(Math.round(p * 0.8)))
  if (!wav) {
    throw new Error('Could not decode this media’s audio in the browser (unsupported codec or the file is too large).')
  }
  const float32 = wavToFloat32(await wav.arrayBuffer())
  const durationS = float32.length / STT_RATE
  const m4a = await encodeAacM4a(float32)
  onProgress?.(100)
  return m4a
    ? { blob: m4a, ext: 'm4a', float32, sampleRate: STT_RATE, durationS }
    : { blob: wav, ext: 'wav', float32, sampleRate: STT_RATE, durationS }
}
