// Cloud build — STT audio extraction, fully in the browser (no PC server).
//
// One decode feeds EVERYTHING: webmedia's battle-tested extractAudioWavBlob
// (16 kHz mono, phone-.mov delayed-audio lead already re-aligned via the elst
// parse) is decoded once, its PCM re-read as Float32 for the in-browser VAD,
// and the SAME samples become the upload blob — so transcription timestamps
// and the VAD silence map are guaranteed to describe identical audio.
//
// Upload payload: the 16 kHz mono WAV goes up as-is. We used to mux a smaller
// WebCodecs AAC/m4a first, but iOS Safari's encoder produces an mp4 that both
// STT providers ACCEPT then fail to transcode ("Transcoding failed") — and it
// reports a decoder config, so a capability check can't tell the good encoder
// from the bad one. The WAV is decoded natively and reliably by AssemblyAI and
// Deepgram alike, so it's the only upload path now.

import { extractAudioWavBlob, isWebMediaId } from '../webmedia'
import { mediaSrc } from '../platform'

/** Sample rate of webmedia's extracted WAV — the timebase for STT + VAD. */
const STT_RATE = 16000

export interface SttAudio {
  /** upload payload — the 16 kHz mono WAV. */
  blob: Blob
  /** audio container extension for the stt sign-upload action (always 'wav'). */
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
  const pcm = wavPcm16(buf)
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i]
    out[i] = s < 0 ? s / 0x8000 : s / 0x7fff
  }
  return out
}

/** Locate the `data` chunk with a real RIFF walk instead of assuming the
 *  44-byte canonical header: webmedia's encodeWav IS canonical, but the native
 *  ffmpeg WAV (desktop hybrid) carries a LIST/INFO metadata chunk before
 *  `data`, and byte 44 would land mid-metadata — garbage samples for the VAD. */
function wavPcm16(buf: ArrayBuffer): Int16Array {
  const dv = new DataView(buf)
  const tag = (o: number): string => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3))
  if (buf.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return new Int16Array(0)
  let off = 12
  while (off + 8 <= buf.byteLength) {
    const id = tag(off)
    const size = dv.getUint32(off + 4, true)
    if (id === 'data') {
      const start = off + 8
      const len = Math.min(size, buf.byteLength - start)
      return new Int16Array(buf, start, Math.floor(len / 2))
    }
    off += 8 + size + (size & 1) // chunks are word-aligned
  }
  return new Int16Array(0)
}

/** Desktop hybrid: extract the 16 kHz mono STT WAV with the BUNDLED ffmpeg
 *  (IPC → main process; same `aresample=async=1:first_pts=0` alignment the
 *  browser path recovers via the elst parse) and read it back over ecmedia://.
 *  Returns null when unavailable (web build, or the IPC method is missing). */
async function nativeSttWav(path: string, onProgress?: (pct: number) => void): Promise<Blob | null> {
  if (isWebMediaId(path) || typeof window === 'undefined') return null
  const api = (window as { api?: { sttAudioWav?: (p: string) => Promise<string> } }).api
  if (!api?.sttAudioWav) return null
  onProgress?.(5)
  const wavPath = await api.sttAudioWav(path)
  onProgress?.(70)
  const res = await fetch(mediaSrc(wavPath))
  if (!res.ok) throw new Error(`Could not read the extracted audio (${res.status}).`)
  return await res.blob()
}

/** Decode a `webmedia:` id's audio → 16 kHz mono Float32 (lead-aligned), for
 *  standalone VAD use. Throws an honest error when the browser can't decode. */
export async function decodeAudioFloat32(
  mediaId: string,
  onProgress?: (pct: number) => void
): Promise<{ float32: Float32Array; sampleRate: number; durationS: number }> {
  const wav = (await nativeSttWav(mediaId, onProgress)) ?? (await extractAudioWavBlob(mediaId, onProgress))
  if (!wav) {
    throw new Error('Could not decode this media’s audio in the browser (unsupported codec or the file is too large).')
  }
  const float32 = wavToFloat32(await wav.arrayBuffer())
  return { float32, sampleRate: STT_RATE, durationS: float32.length / STT_RATE }
}

/** Produce the STT audio for a `webmedia:` id: decode once, return the 16 kHz
 *  mono WAV upload blob + the decoded samples for the VAD (one shared clock). */
export async function extractSttAudio(mediaId: string, onProgress?: (pct: number) => void): Promise<SttAudio> {
  const wav =
    (await nativeSttWav(mediaId, (p) => onProgress?.(Math.round(p * 0.9)))) ??
    (await extractAudioWavBlob(mediaId, (p) => onProgress?.(Math.round(p * 0.9))))
  if (!wav) {
    throw new Error('Could not decode this media’s audio in the browser (unsupported codec or the file is too large).')
  }
  const float32 = wavToFloat32(await wav.arrayBuffer())
  onProgress?.(100)
  return { blob: wav, ext: 'wav', float32, sampleRate: STT_RATE, durationS: float32.length / STT_RATE }
}
