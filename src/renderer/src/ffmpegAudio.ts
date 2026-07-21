// On-device audio decode of LAST RESORT, via ffmpeg.wasm.
//
// Used only when neither WebCodecs nor WebAudio decodeAudioData can read a clip's
// audio in the browser — mainly iOS Safari, which decodes some phone-exported
// clips to silence and reports WebCodecs AudioDecoder unsupported. ffmpeg.wasm
// decodes the containers/codecs WebKit can't, and it runs ENTIRELY on-device: the
// video never leaves the phone.
//
// The ~31 MB core is a SAME-ORIGIN static asset under /ffmpeg (staged by
// scripts/prepare-cloud-assets.mjs). Same-origin URLs (not blob:) keep it within
// the existing CSP — script-src 'self', connect-src 'self', wasm-unsafe-eval,
// worker-src 'self' — so no CSP relaxation is needed. It's imported lazily, so
// the wrapper + core download only the first time this fallback actually runs.
import type { FFmpeg } from '@ffmpeg/ffmpeg'

let loadPromise: Promise<FFmpeg> | null = null
// ffmpeg.wasm is a single worker — one exec at a time. Serialize calls so two
// overlapping runs can't corrupt each other's MEMFS.
let chain: Promise<unknown> = Promise.resolve()
let seq = 0

/** Load (once) and cache the ffmpeg.wasm instance. */
async function getFFmpeg(onStatus?: (msg: string) => void): Promise<FFmpeg> {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    onStatus?.('Preparing the audio engine…')
    const { FFmpeg } = await import('@ffmpeg/ffmpeg')
    const ff = new FFmpeg()
    const base = `${location.origin}/ffmpeg`
    await ff.load({ coreURL: `${base}/ffmpeg-core.js`, wasmURL: `${base}/ffmpeg-core.wasm` })
    return ff
  })().catch((e) => {
    loadPromise = null // let the next attempt retry the load
    throw e
  })
  return loadPromise
}

/** Decode a media File's audio → 16 kHz mono 16-bit PCM (Int16Array), or null if
 *  ffmpeg can't read it. `onProgress` reports 0..100 across load + decode. */
export async function ffmpegExtractPcm16kMono(
  file: File,
  onProgress?: (pct: number, msg?: string) => void
): Promise<Int16Array | null> {
  // Serialize: await any in-flight extraction, then run ours.
  const run = chain.then(() => extractOne(file, onProgress))
  // Keep the chain alive even if this run rejects (it won't — extractOne catches).
  chain = run.catch(() => undefined)
  return run
}

async function extractOne(
  file: File,
  onProgress?: (pct: number, msg?: string) => void
): Promise<Int16Array | null> {
  let ff: FFmpeg
  try {
    ff = await getFFmpeg((m) => onProgress?.(2, m))
  } catch (e) {
    console.warn('[ec] ffmpeg.wasm failed to load', e)
    return null
  }
  const id = ++seq
  const inName = `ecin_${id}`
  const outName = `ecout_${id}.pcm`
  const onProg = ({ progress }: { progress: number }): void => {
    // ffmpeg progress is 0..1 (accurate for like-length in/out); map to 5..98.
    onProgress?.(Math.min(98, 5 + Math.round((progress || 0) * 93)))
  }
  try {
    ff.on('progress', onProg)
    await ff.writeFile(inName, new Uint8Array(await file.arrayBuffer()))
    // -vn: drop video. Downmix to mono, resample to 16 kHz, emit raw signed
    // 16-bit little-endian PCM (wrapped into a canonical WAV by the caller).
    const code = await ff.exec(['-i', inName, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', outName])
    if (code !== 0) {
      console.warn('[ec] ffmpeg.wasm exited non-zero', code)
      return null
    }
    const data = await ff.readFile(outName)
    if (typeof data === 'string' || !data || !data.byteLength || data.byteLength < 2) return null
    onProgress?.(100)
    // Copy into a fresh, 2-byte-aligned buffer, then view as little-endian Int16
    // (every browser target is little-endian, so a direct view is correct).
    const bytes = new Uint8Array(data as Uint8Array)
    return new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1)
  } catch (e) {
    console.warn('[ec] ffmpeg.wasm audio extract failed', e)
    return null
  } finally {
    ff.off('progress', onProg)
    void ff.deleteFile(inName).catch(() => undefined)
    void ff.deleteFile(outName).catch(() => undefined)
  }
}
