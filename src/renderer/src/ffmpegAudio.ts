// On-device ffmpeg.wasm audio tooling — decoder of LAST RESORT + stream probe +
// audio-track remux. Runs ENTIRELY in the browser: the clip never leaves the
// device. Used when neither WebCodecs nor WebAudio can produce real (non-silent)
// audio — mainly iOS Safari, whose CoreAudio-backed decoders return silence for
// some phone-exported clips and screen recordings.
//
// The ~31 MB core is a SAME-ORIGIN static asset under /ffmpeg (staged by
// scripts/prepare-cloud-assets.mjs), so the existing CSP (script-src 'self',
// worker-src 'self', wasm-unsafe-eval) covers it — no relaxation. Loaded lazily:
// nothing downloads until a fallback actually runs. Input files are mounted via
// WORKERFS (read-only view over the File — no whole-file copy into wasm memory),
// with a MEMFS write as fallback.
import type { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg'

/** ≈ -48 dBFS on int16 — a decoded stream peaking below this is "silent". */
const PEAK_MIN_16 = 131
/** MEMFS fallback copies the whole file into wasm memory — cap it. */
const MEMFS_MAX = 450 * 1024 * 1024

export interface FfAudioStream {
  codec: string
  detail: string
}
export interface FfDecodeResult {
  /** 16 kHz mono int16 PCM (all non-silent tracks mixed), or null. */
  pcm: Int16Array | null
  /** Audio streams as probed from ffmpeg's own stream banner. */
  streams: FfAudioStream[]
  /** Compact diagnostic ("ff[aac/stereo; a0:0.00 a1:0.31]"). */
  note: string
}

let loadPromise: Promise<FFmpeg> | null = null
// One worker, shared virtual FS — serialize all jobs so runs can't interleave.
let chain: Promise<unknown> = Promise.resolve()
let seq = 0

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.then(job)
  chain = run.catch(() => undefined)
  return run
}

async function getFFmpeg(): Promise<FFmpeg> {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
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

export function peakOfInt16(pcm: Int16Array): number {
  const step = Math.max(1, Math.floor(pcm.length / 4000))
  let peak = 0
  for (let i = 0; i < pcm.length; i += step) {
    const a = Math.abs(pcm[i])
    if (a > peak) peak = a
  }
  return peak
}

/** Run `fn` with the file visible to ffmpeg's FS; prefers a zero-copy WORKERFS
 *  mount, falls back to a MEMFS write (bounded). Always cleans up. */
async function withInput<T>(ff: FFmpeg, file: File, fn: (path: string) => Promise<T>): Promise<T> {
  const id = ++seq
  const dir = `/mnt${id}`
  let mounted = false
  try {
    await ff.createDir(dir)
    await ff.mount('WORKERFS' as unknown as FFFSType, { blobs: [{ name: 'input', data: file }] }, dir)
    mounted = true
  } catch {
    /* WORKERFS unavailable in this core — use MEMFS below */
  }
  if (mounted) {
    try {
      return await fn(`${dir}/input`)
    } finally {
      try {
        await ff.unmount(dir)
      } catch {
        /* already unmounted */
      }
      try {
        await ff.deleteDir(dir)
      } catch {
        /* best effort */
      }
    }
  }
  if (file.size > MEMFS_MAX) throw new Error('file too large for in-memory decode')
  const name = `in${id}`
  await ff.writeFile(name, new Uint8Array(await file.arrayBuffer()))
  try {
    return await fn(name)
  } finally {
    void ff.deleteFile(name).catch(() => undefined)
  }
}

/** List the file's audio streams by parsing ffmpeg's own `-i` banner (works for
 *  every container/codec ffmpeg can DEMUX, even ones it can't decode — so the
 *  diagnostic names exotic codecs like apac instead of failing blind). */
async function probeAudioStreams(ff: FFmpeg, path: string): Promise<FfAudioStream[]> {
  const lines: string[] = []
  const onLog = ({ message }: { type: string; message: string }): void => {
    lines.push(message)
  }
  ff.on('log', onLog)
  try {
    // No output file → ffmpeg prints the stream banner and exits non-zero. Fast.
    await ff.exec(['-hide_banner', '-i', path], 30000)
  } catch {
    /* non-zero exit is expected */
  }
  ff.off('log', onLog)
  const out: FfAudioStream[] = []
  for (const l of lines) {
    const m = /Stream #0:\d+[^:]*: Audio: ([A-Za-z0-9_.-]+)\s*([^\n]*)/.exec(l)
    if (m) out.push({ codec: m[1], detail: m[2].replace(/\s+/g, ' ').trim().slice(0, 60) })
  }
  return out
}

/** Decode EVERY audio stream to 16 kHz mono int16 and mix the non-silent ones —
 *  screen recordings and app exports often carry voice on the SECOND track
 *  (mic) while track 1 (app audio) is silent, and single-track decoders read
 *  those clips as "no audio". Returns pcm=null when nothing decodable carries
 *  signal; `note` always reports what was found. */
export function ffmpegDecodeAudio(file: File, onProgress?: (pct: number) => void): Promise<FfDecodeResult> {
  return enqueue(async () => {
    let ff: FFmpeg
    try {
      ff = await getFFmpeg()
    } catch (e) {
      console.warn('[ec] ffmpeg.wasm failed to load', e)
    return { pcm: null, streams: [], note: 'ff[load-failed]' }
    }
    try {
      return await withInput(ff, file, async (input) => {
        const streams = await probeAudioStreams(ff, input)
        // Probe can theoretically miss — still blind-try stream 0.
        const tryN = Math.min(Math.max(streams.length, 1), 4)
        const parts: Int16Array[] = []
        const notes: string[] = []
        for (let i = 0; i < tryN; i++) {
          const out = `out${i}.pcm`
          const onProg = ({ progress }: { progress: number; time: number }): void =>
            onProgress?.(Math.min(97, Math.round(((i + Math.min(1, Math.max(0, progress))) / tryN) * 95)))
          ff.on('progress', onProg)
          let code = 1
          try {
            code = await ff.exec(
              ['-i', input, '-map', `0:a:${i}`, '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-f', 's16le', out],
              300000
            )
          } catch {
            code = 1
          }
          ff.off('progress', onProg)
          if (code !== 0) {
            notes.push(`a${i}:err`)
            continue
          }
          const data = await ff.readFile(out).catch(() => null)
          void ff.deleteFile(out).catch(() => undefined)
          if (!data || typeof data === 'string' || data.byteLength < 2) {
            notes.push(`a${i}:empty`)
            continue
          }
          const bytes = (data as Uint8Array).slice() // own, 0-offset buffer for the int16 view
          const pcm = new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1)
          const pk = peakOfInt16(pcm)
          notes.push(`a${i}:${(pk / 32768).toFixed(2)}`)
          if (pk >= PEAK_MIN_16) parts.push(pcm)
        }
        const desc = streams.map((s) => s.codec).join('+') || 'unprobed'
        const note = `ff[${desc}; ${notes.join(' ')}]`
        if (!parts.length) return { pcm: null, streams, note }
        if (parts.length === 1) return { pcm: parts[0], streams, note }
        // Mix simultaneous tracks (mic + app audio) sample-by-sample, clamped.
        const len = Math.max(...parts.map((p) => p.length))
        const mixed = new Int16Array(len)
        for (let j = 0; j < len; j++) {
          let s = 0
          for (const p of parts) if (j < p.length) s += p[j]
          mixed[j] = s < -32768 ? -32768 : s > 32767 ? 32767 : s
        }
        return { pcm: mixed, streams, note: `${note} mixed:${parts.length}` }
      })
    } catch (e) {
      return { pcm: null, streams: [], note: `ff[${String((e as Error)?.message || e).slice(0, 50)}]` }
    }
  })
}

/** Extract the COMPRESSED audio track(s) out of the container without decoding
 *  (`-c:a copy` only demuxes, so it works even for codecs nothing on-device can
 *  decode). The result is an audio-only file for server-side transcription —
 *  the video frames stay on the device. Returns null if even remuxing fails. */
export function ffmpegRemuxAudioTrack(file: File): Promise<{ blob: Blob; ext: string } | null> {
  return enqueue(async () => {
    let ff: FFmpeg
    try {
      ff = await getFFmpeg()
    } catch {
      return null
    }
    try {
      return await withInput(ff, file, async (input) => {
        // m4a (mp4 muxer) first; mov accepts more exotic codec tags.
        for (const [ext, mime] of [
          ['m4a', 'audio/mp4'],
          ['mov', 'video/quicktime']
        ] as const) {
          const out = `aud.${ext}`
          let code = 1
          try {
            code = await ff.exec(['-i', input, '-map', '0:a', '-vn', '-sn', '-dn', '-c:a', 'copy', out], 120000)
          } catch {
            code = 1
          }
          if (code !== 0) {
            void ff.deleteFile(out).catch(() => undefined)
            continue
          }
          const data = await ff.readFile(out).catch(() => null)
          void ff.deleteFile(out).catch(() => undefined)
          if (data && typeof data !== 'string' && data.byteLength > 1024) {
            return { blob: new Blob([(data as Uint8Array).slice()], { type: mime }), ext }
          }
        }
        return null
      })
    } catch {
      return null
    }
  })
}
