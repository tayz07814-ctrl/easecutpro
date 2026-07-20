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

import { extractAudioWavBlob, getMediaFile } from '../webmedia'

/** Sample rate of webmedia's extracted WAV — the timebase for STT + VAD. */
const STT_RATE = 16000

/** The stt-audio bucket's cap (see the init migration). Above this we can neither
 *  decode locally nor upload the original, so we surface an honest error. */
const RAW_UPLOAD_MAX = 250 * 1024 * 1024

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

/** Does this PCM carry real signal, or did the decoder hand back silence? iOS
 *  Safari "successfully" decodes some phone-exported clips to pure zeros — the STT
 *  providers then reject that upload with "no spoken audio", so a silent decode is
 *  treated as a FAILURE and we fall back to a server-side extraction. */
function hasAudibleSignal(pcm: Float32Array): boolean {
  if (!pcm.length) return false
  const step = Math.max(1, Math.floor(pcm.length / 4000)) // sample ~4k points across the clip
  let peak = 0
  for (let i = 0; i < pcm.length; i += step) {
    const a = Math.abs(pcm[i])
    if (a > peak) peak = a
  }
  return peak > 0.004 // ≈ -48 dBFS; below this the clip is effectively silent
}

/** Container extension for the STT upload path (from the file name, else the MIME). */
function mediaExt(file: File): string {
  const fromName = /\.([a-z0-9]{2,5})$/i.exec(file.name)?.[1]
  if (fromName) return fromName.toLowerCase()
  const t = (file.type || '').toLowerCase()
  if (t.includes('quicktime')) return 'mov'
  if (t.includes('webm')) return 'webm'
  if (t.includes('matroska')) return 'mkv'
  if (t.includes('mp4') || t.startsWith('video/')) return 'mp4'
  if (t.startsWith('audio/')) return 'm4a'
  return 'mp4'
}

/** Produce the STT audio for a `webmedia:` id.
 *
 *  Preferred: decode the audio on-device to a small 16 kHz mono WAV — the upload
 *  stays tiny AND the SAME samples feed the VAD, so words and silence share one
 *  clock. Falls back to uploading the ORIGINAL clip for server-side extraction
 *  when no in-browser decoder yields real audio (mainly iOS Safari, which decodes
 *  some phone-exported clips to silence). The fallback has no local PCM, so
 *  `float32` is empty and callers skip the VAD silence pass (transcription and
 *  retake word-cuts still run). */
export async function extractSttAudio(mediaId: string, onProgress?: (pct: number) => void): Promise<SttAudio> {
  const wav = await extractAudioWavBlob(mediaId, (p) => onProgress?.(Math.round(p * 0.9)))
  if (wav) {
    const float32 = wavToFloat32(await wav.arrayBuffer())
    if (hasAudibleSignal(float32)) {
      onProgress?.(100)
      return { blob: wav, ext: 'wav', float32, sampleRate: STT_RATE, durationS: float32.length / STT_RATE }
    }
  }
  // Fallback: send the original clip; the provider (AssemblyAI/Deepgram) extracts
  // the audio server-side. No local PCM → empty float32 → VAD skipped upstream.
  const file = getMediaFile(mediaId)
  if (!file) {
    throw new Error('Could not read this clip’s audio on this device.')
  }
  if (file.size > RAW_UPLOAD_MAX) {
    throw new Error(
      'This clip’s audio can’t be read on this device, and the file is too large to transcribe on our servers. Try a shorter clip.'
    )
  }
  onProgress?.(100)
  return { blob: file, ext: mediaExt(file), float32: new Float32Array(0), sampleRate: STT_RATE, durationS: 0 }
}
