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

import { extractAudioWavBlob, extractSttAudioSmart } from '../webmedia'

/** Sample rate of webmedia's extracted WAV — the timebase for STT + VAD. */
const STT_RATE = 16000

export interface SttAudio {
  /** upload payload — 16 kHz mono WAV, or (fallback) the clip's compressed
   *  audio track remuxed into an audio-only container for server-side decode. */
  blob: Blob
  /** audio container extension for the stt sign-upload action. */
  ext: string
  /** the decoded samples themselves (16 kHz mono, lead-aligned) — feed the VAD
   *  with THESE so silence and words share one clock. EMPTY when the audio
   *  couldn't be decoded on-device (remux fallback) — VAD passes must skip. */
  float32: Float32Array
  sampleRate: number
  durationS: number
  /** compact decoder diagnostic (which layers ran, what they saw). */
  note?: string
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

/** Produce the STT audio for a `webmedia:` id.
 *
 *  Preferred: on-device decode (WebCodecs → WebAudio → ffmpeg.wasm, every layer
 *  silence-guarded and multi-track aware) → 16 kHz mono WAV whose SAME samples
 *  feed the VAD. Fallback: when nothing on-device can decode the audio, the
 *  compressed AUDIO TRACK is demuxed out of the container and uploaded for
 *  server-side decoding — audio only, the video never leaves the device; VAD is
 *  skipped for that clip (float32 empty). Throws with the full decoder
 *  diagnostic when even the demux fails. */
export async function extractSttAudio(mediaId: string, onProgress?: (pct: number) => void): Promise<SttAudio> {
  const a = await extractSttAudioSmart(mediaId, (p) => onProgress?.(Math.round(p * 0.95)))
  if (!a.blob) {
    throw new Error(
      `Couldn’t read this clip’s audio on this device [${a.diag}] — try re-importing it, or re-export it as MP4 (H.264 + AAC) and import that.`
    )
  }
  onProgress?.(100)
  if (a.pcm) {
    const float32 = new Float32Array(a.pcm.length)
    for (let i = 0; i < a.pcm.length; i++) {
      const s = a.pcm[i]
      float32[i] = s < 0 ? s / 0x8000 : s / 0x7fff
    }
    return { blob: a.blob, ext: a.ext, float32, sampleRate: STT_RATE, durationS: float32.length / STT_RATE, note: a.diag }
  }
  return { blob: a.blob, ext: a.ext, float32: new Float32Array(0), sampleRate: STT_RATE, durationS: 0, note: a.diag }
}
