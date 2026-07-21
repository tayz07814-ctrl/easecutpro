// Local-first media for the web client.
//
// On import we DON'T upload — we keep the File in the browser and play it from a
// blob URL, so manual editing is instant. Only when the PC actually needs the
// bytes (transcribe / silence / export) do we upload, lazily and in chunks
// (chunks dodge the ~100 MB request limit that tunnels like Cloudflare impose).
import type { MediaInfo, Waveform } from '@shared/types'
// Type-only — erased at build; the runtime import is dynamic (fast thumbnail path).
import type { Input as MBInput } from 'mediabunny'
import { ffmpegDecodeAudio, ffmpegRemuxAudioTrack, peakOfInt16 } from './ffmpegAudio'

interface MediaRec {
  file: File
  url: string // blob: URL for local <video>/<img> playback
  serverPath?: string // set once the full file is uploaded to the PC
  audioServerPath?: string // set once just the extracted audio is uploaded
}

const registry = new Map<string, MediaRec>()
const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp)$/i

// ---- IndexedDB persistence: imported Files survive reloads on THIS device ----
// Autosave stores only the small project JSON on the PC; the media BYTES live
// here so a reopened project plays without ever uploading the video. Everything
// is best-effort: a quota/eviction failure only means that file needs a
// re-import (or already re-resolves via a PC path if something uploaded it).
const IDB_NAME = 'ec-localmedia'
const IDB_STORE = 'files'
let idbPromise: Promise<IDBDatabase | null> | null = null
function idb(): Promise<IDBDatabase | null> {
  if (idbPromise) return idbPromise
  idbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return idbPromise
}
async function idbPut(id: string, file: File): Promise<void> {
  const db = await idb()
  if (!db) return
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite')
      tx.objectStore(IDB_STORE).put({ name: file.name, type: file.type, blob: file }, id)
      tx.oncomplete = () => resolve()
      tx.onabort = () => resolve()
      tx.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}
async function idbGet(id: string): Promise<File | null> {
  const db = await idb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly')
      const rq = tx.objectStore(IDB_STORE).get(id)
      rq.onsuccess = () => {
        const v = rq.result as { name: string; type: string; blob: Blob } | undefined
        resolve(v ? new File([v.blob], v.name, { type: v.type }) : null)
      }
      rq.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

/** Ask the browser not to evict our media under storage pressure (best effort;
 *  matters on iOS, which drops site storage after ~7 days without a visit). */
export function requestPersistentStorage(): void {
  try {
    void navigator.storage?.persist?.()
  } catch {
    /* unsupported */
  }
}

/** Re-register webmedia ids from this device's IndexedDB (project reopened
 *  after a reload). Returns the ids that could be restored. */
export async function hydrateLocalMedia(ids: string[]): Promise<string[]> {
  const restored: string[] = []
  for (const id of ids) {
    if (registry.has(id)) {
      restored.push(id)
      continue
    }
    const f = await idbGet(id)
    if (!f) continue
    registry.set(id, { file: f, url: URL.createObjectURL(f) })
    restored.push(id)
  }
  return restored
}

/** Server path this id is KNOWN to have (already uploaded this session), else undefined. */
export function serverPathOf(id: string): string | undefined {
  return registry.get(id)?.serverPath
}

export function isWebMediaId(p: string | undefined): boolean {
  return !!p && p.startsWith('webmedia:')
}

/** Keep a picked File locally; return an id used as its "path" in the model.
 *  `persist` false skips the IndexedDB copy — used for transient artifacts (e.g.
 *  a combined-montage audio) that would otherwise bloat storage on every run. */
export function registerLocalFile(file: File, persist = true): string {
  const id = `webmedia:${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  registry.set(id, { file, url: URL.createObjectURL(file) })
  if (persist) void idbPut(id, file) // survive reloads on this device (best effort)
  return id
}

export function localUrl(id: string): string {
  return registry.get(id)?.url ?? ''
}
export function getFile(id: string): File | undefined {
  return registry.get(id)?.file
}
/** Is the File for this id still in this browser session? (Loaded projects can
 *  reference ids from an earlier session — those can't be uploaded anymore.) */
export function hasLocalFile(id: string): boolean {
  return registry.has(id)
}

/** Read width/height/duration straight from the browser — no server needed. */
export function localProbe(id: string): Promise<MediaInfo> {
  const rec = registry.get(id)
  if (!rec) return Promise.resolve(blankInfo(id))
  const isImage = IMAGE_RE.test(rec.file.name) || rec.file.type.startsWith('image/')
  return new Promise((resolve) => {
    if (isImage) {
      const img = new Image()
      img.onload = () =>
        resolve({ path: id, duration: 0, width: img.naturalWidth, height: img.naturalHeight, fps: 0, hasVideo: true, hasAudio: false })
      img.onerror = () => resolve(blankInfo(id))
      img.src = rec.url
      return
    }
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.onloadedmetadata = () =>
      resolve({
        path: id,
        duration: v.duration || 0,
        width: v.videoWidth || 0,
        height: v.videoHeight || 0,
        fps: 30, // unknown in the browser; the server re-probes at export
        hasVideo: v.videoWidth > 0,
        hasAudio: true // assume; the server re-probes at export
      })
    v.onerror = () => resolve(blankInfo(id))
    v.src = rec.url
  })
}
function blankInfo(id: string): MediaInfo {
  return { path: id, duration: 0, width: 0, height: 0, fps: 30, hasVideo: true, hasAudio: true }
}

/**
 * Leading audio offset (seconds) from an MP4/MOV edit list (empty edit). Phone
 * .mov files often delay the audio (start_time > 0); `decodeAudioData` strips
 * that, so the browser waveform/transcription end up shifted earlier than the
 * video. We parse the `elst` ourselves to recover it. Returns 0 for non-MP4 or
 * when there's no offset. (Mirrors the desktop `aresample=...:first_pts=0` fix.)
 */
export function mp4AudioStartOffset(buf: ArrayBuffer): number {
  try {
    const dv = new DataView(buf)
    const len = dv.byteLength
    if (len < 16) return 0
    const fourcc = (o: number): string =>
      String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3))
    function* boxes(start: number, end: number): Generator<{ type: string; ps: number; pe: number }> {
      let p = start
      while (p + 8 <= end) {
        let size = dv.getUint32(p)
        const type = fourcc(p + 4)
        let header = 8
        if (size === 1) {
          size = dv.getUint32(p + 8) * 4294967296 + dv.getUint32(p + 12)
          header = 16
        } else if (size === 0) {
          size = end - p
        }
        if (size < header || p + size > end) break
        yield { type, ps: p + header, pe: p + size }
        p += size
      }
    }
    let movieTimescale = 0
    let audioOffset = 0
    for (const moov of boxes(0, len)) {
      if (moov.type !== 'moov') continue
      for (const m of boxes(moov.ps, moov.pe)) {
        if (m.type === 'mvhd') {
          const v = dv.getUint8(m.ps)
          movieTimescale = v === 1 ? dv.getUint32(m.ps + 20) : dv.getUint32(m.ps + 12)
        }
      }
      for (const trak of boxes(moov.ps, moov.pe)) {
        if (trak.type !== 'trak') continue
        let isAudio = false
        let elstOffset = 0
        for (const t of boxes(trak.ps, trak.pe)) {
          if (t.type === 'mdia') {
            for (const md of boxes(t.ps, t.pe)) if (md.type === 'hdlr' && fourcc(md.ps + 8) === 'soun') isAudio = true
          } else if (t.type === 'edts') {
            for (const e of boxes(t.ps, t.pe)) {
              if (e.type !== 'elst') continue
              const v = dv.getUint8(e.ps)
              const count = dv.getUint32(e.ps + 4)
              let o = e.ps + 8
              for (let i = 0; i < count; i++) {
                let segDur: number, mediaTime: number
                if (v === 1) {
                  segDur = dv.getUint32(o) * 4294967296 + dv.getUint32(o + 4)
                  mediaTime = Number(dv.getBigInt64(o + 8))
                  o += 20
                } else {
                  segDur = dv.getUint32(o)
                  mediaTime = dv.getInt32(o + 4)
                  o += 12
                }
                if (mediaTime === -1) elstOffset += segDur
              }
            }
          }
        }
        if (isAudio && elstOffset > 0 && movieTimescale > 0) audioOffset = elstOffset / movieTimescale
      }
    }
    return audioOffset
  } catch {
    return 0
  }
}

/** Decode a file's audio to an AudioBuffer at (near) `targetRate`, then ALWAYS
 *  release the context. iOS caps the number of live AudioContexts, so leaking one
 *  per clip eventually breaks all audio (waveform + Cut Lord). A hard timeout
 *  stops a stuck decode from hanging the media pipeline forever. NOTE: iOS ignores
 *  the sampleRate hint on a live context (locked to hardware rate) — that's fine,
 *  the waveform/WAV resample handles any input rate; correctness over speed. */
async function decodeAudioAtRate(buf: ArrayBuffer, _targetRate: number): Promise<AudioBuffer> {
  const AC: typeof AudioContext =
    window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  // Decode at the browser's NATIVE rate — its fast, well-tested path. Forcing a low
  // context rate (8k/16k) makes decodeAudioData resample ~6:1 DURING decode, which on
  // some phones is glacially slow and blew past the timeout ("decode timeout" → blank
  // waveform + "couldn't decode audio" in Cut Lord). Every caller already resamples the
  // result in JS (peaks / WAV / montage mix), so native-rate output is equivalent.
  const ac = new AC()
  try {
    return await new Promise<AudioBuffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('decode timeout')), 60000)
      ac.decodeAudioData(buf).then(
        (a) => {
          clearTimeout(timer)
          resolve(a)
        },
        (e) => {
          clearTimeout(timer)
          reject(e)
        }
      )
    })
  } finally {
    try {
      ac.close()
    } catch {
      /* already closed */
    }
  }
}

/** Compute a waveform (amplitude envelope) in the browser. Best-effort and purely
 *  cosmetic, so it degrades to no waveform rather than alarming the creator. */
export async function localWaveform(id: string, peaksPerSec = 60): Promise<Waveform> {
  const rec = registry.get(id)
  if (!rec || rec.file.size > 700 * 1024 * 1024) return { peaksPerSec, peaks: [] }
  // Primary: WebCodecs via mediabunny. It decodes with the platform's NATIVE audio
  // decoder, so it reads codecs that iOS Safari's decodeAudioData rejects (the
  // "waveform decode failed" box on mobile), and it opens NO AudioContext — iOS caps
  // how many can be live, and exhausting them broke decoding for every later clip.
  // Bounded by an abort timeout; any miss falls through to decodeAudioData.
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30000)
  let fast: number[] | null = null
  try {
    fast = await localWaveformFast(rec, peaksPerSec, ctrl.signal)
  } catch {
    fast = null
  } finally {
    clearTimeout(timer)
  }
  if (fast && fast.length) return { peaksPerSec, peaks: fast }
  // Fallback: WebAudio decodeAudioData at a LOW rate (~6x less PCM to scan and far
  // less memory — a multi-minute 48kHz file can GC-thrash a phone). Reliable on
  // desktop and on older iOS that predates WebCodecs audio.
  try {
    const buf = await rec.file.arrayBuffer()
    const leadPeaks = Math.round(mp4AudioStartOffset(buf) * peaksPerSec) // parse BEFORE decode (it detaches buf)
    const audio = await decodeAudioAtRate(buf, 8000)
    const peaks = peaksFromAudioBuffer(audio, peaksPerSec)
    // Pad the leading audio offset with silent peaks so the waveform aligns to the
    // video timeline (decodeAudioData strips the elst delay; the WebCodecs path
    // keeps it via presentation timestamps, so it needs no padding).
    if (leadPeaks > 0) return { peaksPerSec, peaks: new Array(leadPeaks).fill(0).concat(peaks) }
    return { peaksPerSec, peaks }
  } catch (e) {
    // Both decoders failed (e.g. an iOS-only codec with no WebCodecs support). The
    // waveform is a cosmetic envelope, so degrade to none QUIETLY — log for remote
    // debugging, but do NOT pop the on-screen error box for a non-fatal miss.
    console.warn('[ec] Waveform unavailable (audio not decodable here)', e)
    return { peaksPerSec, peaks: [] }
  }
}

/** Max-amplitude peaks per output bucket, reading ALL channels (voice is often on
 *  a single channel, so channel 0 alone can read flat while someone speaks). */
function peaksFromAudioBuffer(audio: AudioBuffer, peaksPerSec: number): number[] {
  const chans: Float32Array[] = []
  for (let c = 0; c < audio.numberOfChannels; c++) chans.push(audio.getChannelData(c))
  const n = chans[0]?.length ?? 0
  const per = Math.max(1, Math.floor(audio.sampleRate / peaksPerSec))
  const peaks: number[] = []
  for (let i = 0; i < n; i += per) {
    let max = 0
    const end = Math.min(i + per, n)
    for (const ch of chans) {
      for (let j = i; j < end; j++) {
        const a = Math.abs(ch[j])
        if (a > max) max = a
      }
    }
    peaks.push(max)
  }
  return peaks
}

/** WebCodecs waveform via mediabunny: decode the audio track in presentation order
 *  and fold each buffer into max-amplitude peak buckets keyed by ABSOLUTE time, so
 *  the edit-list (elst) delay lands as leading silence automatically. Returns null
 *  (→ decodeAudioData fallback) on any error, abort, or undecodable track. The
 *  `for await` yields between buffers so the main thread stays responsive. */
async function localWaveformFast(rec: MediaRec, peaksPerSec: number, signal: AbortSignal): Promise<number[] | null> {
  let input: MBInput | null = null
  try {
    const { Input, BlobSource, ALL_FORMATS, AudioBufferSink } = await import('mediabunny')
    input = new Input({ source: new BlobSource(rec.file), formats: ALL_FORMATS })
    const track = await input.getPrimaryAudioTrack()
    if (!track || signal.aborted || !(await track.canDecode())) return null
    const sink = new AudioBufferSink(track)
    const peaks: number[] = []
    for await (const wrapped of sink.buffers()) {
      if (signal.aborted) break
      const ab = wrapped.buffer
      const nCh = ab.numberOfChannels
      const n = ab.length
      const baseBucket = wrapped.timestamp * peaksPerSec // presentation time → bucket units
      const bucketPerSample = peaksPerSec / ab.sampleRate
      const chans: Float32Array[] = []
      for (let c = 0; c < nCh; c++) chans.push(ab.getChannelData(c))
      for (let j = 0; j < n; j++) {
        const bucket = (baseBucket + j * bucketPerSample) | 0 // floor (timestamp ≥ 0)
        let a = 0
        for (let c = 0; c < nCh; c++) {
          const v = Math.abs(chans[c][j])
          if (v > a) a = v
        }
        while (peaks.length <= bucket) peaks.push(0)
        if (a > peaks[bucket]) peaks[bucket] = a
      }
    }
    return peaks.length ? peaks : null
  } catch {
    return null // codec undecodable here, read failed, or aborted — use fallback
  } finally {
    try {
      input?.dispose()
    } catch {
      /* already disposed */
    }
  }
}

/** Generate filmstrip thumbnails in the browser — the web server never gets the
 *  full video, so this is the only way to show base-track thumbnails on the web.
 *  Tries a hardware WebCodecs pass (mediabunny) first, then falls back to seeking
 *  a <video>. The fast pass is bounded by an abort timeout so a stuck decoder can
 *  never wedge the strip — worst case it drops to the (slower) seek path. */
export async function localThumbnails(
  id: string,
  intervalSec = 2,
  onPartial?: (frames: { time: number; url: string }[]) => void
): Promise<{ time: number; url: string }[]> {
  const rec = registry.get(id)
  if (!rec) return []
  if (IMAGE_RE.test(rec.file.name) || rec.file.type.startsWith('image/')) {
    return [{ time: 0, url: rec.url }]
  }
  // Hardware WebCodecs pass, hard-bounded: if it produces no frame within the
  // budget we abort it (disposing the decoder) and fall back to seeking.
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  let fast: { time: number; url: string }[] | null = null
  try {
    fast = await localThumbnailsFast(rec, intervalSec, onPartial, ctrl.signal)
  } catch {
    fast = null
  } finally {
    clearTimeout(timer)
  }
  if (fast && fast.length) return fast
  return localThumbnailsSeek(rec, intervalSec, onPartial)
}

/** Hardware filmstrip via mediabunny: WebCodecs-decodes each needed frame at most
 *  once in one monotonic pass — far faster than seeking a <video> per frame, and
 *  applies the file's rotation metadata so frames come out upright. Fully guarded:
 *  returns null (→ seek fallback) on any error, abort, or undecodable track. The
 *  `for await` yields to the event loop at every frame, so the main thread stays
 *  responsive (the decode itself runs off-thread on the platform codec). */
async function localThumbnailsFast(
  rec: MediaRec,
  intervalSec: number,
  onPartial: ((frames: { time: number; url: string }[]) => void) | undefined,
  signal: AbortSignal
): Promise<{ time: number; url: string }[] | null> {
  let input: MBInput | null = null
  try {
    const { Input, BlobSource, ALL_FORMATS, CanvasSink } = await import('mediabunny')
    input = new Input({ source: new BlobSource(rec.file), formats: ALL_FORMATS })
    const track = await input.getPrimaryVideoTrack()
    if (!track || signal.aborted || !(await track.canDecode())) return null
    const dur = (await track.getDurationFromMetadata().catch(() => null)) || (await track.computeDuration())
    if (!dur || !isFinite(dur)) return null
    // ~24 frames, width 128 — matches the seek path; height auto-derives by aspect.
    const sink = new CanvasSink(track, { width: 128 })
    const step = Math.max(intervalSec || 1, dur / 24)
    const times: number[] = []
    for (let t = 0; t < dur - 0.05; t += step) times.push(t)
    if (!times.length) times.push(0)
    const outCanvas = document.createElement('canvas')
    const octx = outCanvas.getContext('2d')
    if (!octx) return null
    const out: { time: number; url: string }[] = []
    for await (const wrapped of sink.canvasesAtTimestamps(times)) {
      if (signal.aborted) break
      if (!wrapped) continue
      const c = wrapped.canvas
      if (outCanvas.width !== c.width || outCanvas.height !== c.height) {
        outCanvas.width = c.width
        outCanvas.height = c.height
      }
      // Copy off the (possibly pooled) sink canvas before encoding.
      octx.drawImage(c as CanvasImageSource, 0, 0)
      out.push({ time: wrapped.timestamp, url: outCanvas.toDataURL('image/jpeg', 0.55) })
      onPartial?.(out.slice()) // fill the strip in live, same as the seek path
    }
    return out.length ? out : null
  } catch {
    return null // codec undecodable here, read failed, or aborted — use seek
  } finally {
    try {
      input?.dispose()
    } catch {
      /* already disposed */
    }
  }
}

async function localThumbnailsSeek(
  rec: MediaRec,
  intervalSec: number,
  onPartial?: (frames: { time: number; url: string }[]) => void
): Promise<{ time: number; url: string }[]> {
  const video = document.createElement('video')
  video.src = rec.url
  video.muted = true
  video.preload = 'auto'
  ;(video as unknown as { playsInline: boolean }).playsInline = true

  // Resolve when `p` settles OR after `ms` — never rejects, never hangs.
  const withTimeout = (p: Promise<unknown>, ms: number): Promise<void> =>
    new Promise((res) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        res()
      }
      const timer = setTimeout(finish, ms)
      const clear = (): void => {
        clearTimeout(timer)
        finish()
      }
      void Promise.resolve(p).then(clear, clear)
    })
  const rvfcOK =
    typeof (HTMLVideoElement.prototype as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback === 'function'

  try {
    // loadeddata (readyState >= 2) means a frame is actually decodable — unlike
    // loadedmetadata, which only gives dimensions/duration and draws blank.
    await withTimeout(
      new Promise<void>((res, rej) => {
        video.onloadeddata = () => res()
        video.onerror = () => rej(new Error('thumb: cannot load'))
      }),
      8000
    )
    const dur = video.duration
    if (!dur || !isFinite(dur)) return []

    // Prime the decoder — iOS won't draw a never-played muted <video> to canvas.
    try {
      await video.play()
      video.pause()
    } catch {
      /* autoplay refused — the seek below may still present a frame */
    }

    const vw = video.videoWidth || 16
    const vh = video.videoHeight || 9
    const W = 128
    const H = Math.max(2, Math.round((W * vh) / vw))
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')
    if (!ctx) return []

    // Seek + wait for the frame to be PRESENTED (rVFC), not merely for `seeked`.
    const seek = (t: number): Promise<void> => {
      const presented = new Promise<void>((res) => {
        if (rvfcOK) {
          ;(video as unknown as { requestVideoFrameCallback: (cb: () => void) => void }).requestVideoFrameCallback(
            () => res()
          )
        } else {
          const onSeeked = (): void => {
            video.removeEventListener('seeked', onSeeked)
            res()
          }
          video.addEventListener('seeked', onSeeked)
        }
      })
      try {
        video.currentTime = Math.min(t, dur - 0.05)
      } catch {
        return Promise.resolve()
      }
      return withTimeout(presented, 2000)
    }

    // ~24 frames is plenty for a filmstrip — fewer seeks than the old ~50, and
    // each frame is handed to `onPartial` the moment it's drawn so the strip
    // fills in LIVE instead of appearing all at once after a blocking pass.
    const step = Math.max(intervalSec || 1, dur / 24)
    const out: { time: number; url: string }[] = []
    for (let t = 0; t < dur - 0.05; t += step) {
      await seek(t)
      try {
        ctx.drawImage(video, 0, 0, W, H)
        out.push({ time: t, url: canvas.toDataURL('image/jpeg', 0.55) })
        onPartial?.(out.slice())
      } catch {
        /* one frame refused to draw — keep going; a partial strip still helps */
      }
    }
    return out
  } catch {
    return []
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}

// ---- Lazy chunked upload to the PC ----
async function jpost(pathname: string, body: unknown): Promise<any> {
  const r = await fetch(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include'
  })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)
  return r.json()
}

/** Chunk-upload a Blob to the PC; returns its server path.
 *
 *  RESUMABLE: every chunk carries its byte offset; on any mismatch (a dropped
 *  or double-landed chunk) the server answers 409 with the file's real size
 *  and we realign — so a 600MB export upload over a flaky tunnel/mobile link
 *  continues where it left off instead of restarting from byte zero. A lost
 *  upload session (server restarted) is the only full restart.
 */
async function uploadBlob(name: string, blob: Blob, onProgress?: (pct: number) => void): Promise<string> {
  const CHUNK = 4 * 1024 * 1024
  const attempt = async (): Promise<string> => {
    const { uploadId, path } = await jpost('/api/upload-init', { name })
    let off = 0
    while (off < blob.size) {
      const part = blob.slice(off, off + CHUNK)
      let lastErr: Error | null = null
      let sent = -1
      for (let tries = 0; tries < 5 && sent < 0; tries++) {
        if (tries > 0) await new Promise((r) => setTimeout(r, 1000 * tries))
        try {
          const r = await fetch(
            `/api/upload-chunk?uploadId=${encodeURIComponent(uploadId)}&offset=${off}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/octet-stream' },
              body: part,
              credentials: 'include'
            }
          )
          if (r.status === 404) throw new Error('upload session lost') // server restarted
          if (r.status === 409) {
            // The server has a different size (a retried chunk actually landed,
            // or an earlier one vanished) — realign and continue from there.
            const d = await r.json().catch(() => ({}))
            sent = typeof d.size === 'number' ? d.size : off
            break
          }
          if (!r.ok) throw new Error(`chunk HTTP ${r.status}`)
          const d = await r.json().catch(() => ({}))
          sent = typeof d.size === 'number' ? d.size : off + part.size
        } catch (e) {
          lastErr = e as Error
          if (lastErr.message === 'upload session lost') throw lastErr
          // network drop: ask the server how much actually arrived, then resume
          try {
            const st = await fetch(`/api/upload-status?uploadId=${encodeURIComponent(uploadId)}`, { credentials: 'include' })
            if (st.ok) {
              const d = await st.json()
              if (typeof d.size === 'number' && d.size > off) {
                sent = d.size
                break
              }
            }
          } catch {
            /* status probe failed too — retry the chunk */
          }
        }
      }
      if (sent < 0) throw lastErr ?? new Error('Upload failed')
      off = sent
      onProgress?.(Math.min(99, Math.round((off / blob.size) * 100)))
    }
    await jpost('/api/upload-complete', { uploadId })
    return path
  }
  try {
    return await attempt()
  } catch {
    return attempt() // fresh upload session (e.g. the server restarted mid-upload)
  }
}

/** Ensure the FULL local file is on the PC; returns its server path (uploaded once). */
export async function ensureUploaded(id: string, onProgress?: (pct: number) => void): Promise<string> {
  const rec = registry.get(id)
  if (!rec) throw new Error('media not found in browser')
  if (rec.serverPath) return rec.serverPath
  rec.serverPath = await uploadBlob(rec.file.name, rec.file, onProgress)
  return rec.serverPath
}

/**
 * Ensure just the AUDIO is on the PC (for transcribe / silence — they don't need
 * the video). Extracts a 16 kHz mono WAV in the browser (~15x smaller than a
 * typical video) and uploads only that, so the first server op isn't gated on a
 * huge video upload. Falls back to a full-file upload if extraction fails.
 */
export async function ensureAudioUploaded(id: string, onProgress?: (pct: number) => void): Promise<string> {
  const rec = registry.get(id)
  if (!rec) throw new Error('media not found in browser')
  if (rec.audioServerPath) return rec.audioServerPath
  // The FULL file is already on the PC (autosave/export uploaded it)? Use it —
  // the server extracts audio with ffmpeg in seconds. This is why Cut Lord jobs
  // used to stall for minutes: the browser was re-decoding a whole video that
  // the server already had.
  if (rec.serverPath) return rec.serverPath
  // Big files: decodeAudioData buffers the ENTIRE file in RAM — on phones a
  // multi-hundred-MB video takes minutes or dies. The resumable full upload +
  // server-side ffmpeg is strictly faster and more reliable there.
  if (rec.file.size > 250 * 1024 * 1024) {
    return ensureUploaded(id, onProgress)
  }
  const wav = await extractAudioWavBlob(id, (p) => onProgress?.(Math.round(p * 0.35)))
  if (!wav) {
    // Couldn't decode in this browser — fall back to uploading the whole file.
    return ensureUploaded(id, onProgress)
  }
  const base = rec.file.name.replace(/\.[^.]+$/, '') || 'audio'
  rec.audioServerPath = await uploadBlob(`${base}.ecaudio.wav`, wav, (p) => onProgress?.(35 + Math.round(p * 0.65)))
  return rec.audioServerPath
}

/** ≈ -48 dBFS on int16 — a decoded track peaking below this is "silent". */
const PEAK_MIN_16 = 131

/** STT audio for a `webmedia:` id, produced ON-DEVICE with a self-diagnosing,
 *  silence-guarded decoder chain. `blob` is null only when every layer failed —
 *  `diag` then names exactly what each decoder saw (tracks, codecs, peaks). */
export interface SmartSttAudio {
  blob: Blob | null
  /** upload container extension ('wav' when decoded locally). */
  ext: string
  /** 16 kHz mono PCM when a local decoder produced real audio, else null
   *  (audio-track remux → the server decodes; VAD has nothing to read). */
  pcm: Int16Array | null
  /** compact per-layer diagnostic, e.g. "wc[t0:0.00 t1:nodec] wa[silent] ff[aac+aac; a0:0.00 a1:0.31]". */
  diag: string
}

/** Decode a media file's audio in the browser → 16 kHz mono WAV Blob (null if it
 *  can't). Thin wrapper over the guarded multi-decoder chain (WebCodecs →
 *  WebAudio → ffmpeg.wasm), all on-device. */
export async function extractAudioWavBlob(id: string, onProgress?: (pct: number) => void): Promise<Blob | null> {
  const rec = registry.get(id)
  if (!rec || rec.file.size > 800 * 1024 * 1024) return null
  const pcm = await extractAudioPcm16(rec, [], onProgress)
  return pcm ? encodeWav(pcm, 16000) : null
}

/** Full STT audio pipeline: guarded decode chain first; if NOTHING on-device can
 *  produce real audio, demux the compressed AUDIO TRACK out of the container
 *  (no decode needed) and hand that up for server-side decoding. The video
 *  never leaves the device on any path. */
export async function extractSttAudioSmart(id: string, onProgress?: (pct: number) => void): Promise<SmartSttAudio> {
  const rec = registry.get(id)
  if (!rec) return { blob: null, ext: 'wav', pcm: null, diag: 'media not found in this browser — re-import the clip' }
  if (rec.file.size > 800 * 1024 * 1024) return { blob: null, ext: 'wav', pcm: null, diag: 'file over 800 MB' }
  // iOS quietly invalidates photo-library Files after a while — read a few bytes
  // up front so that case gets an honest "re-import" instead of decoder noise.
  try {
    await rec.file.slice(0, 4).arrayBuffer()
  } catch {
    return { blob: null, ext: 'wav', pcm: null, diag: 'file no longer readable — re-import the clip' }
  }
  const diag: string[] = []
  const pcm = await extractAudioPcm16(rec, diag, onProgress)
  if (pcm) return { blob: encodeWav(pcm, 16000), ext: 'wav', pcm, diag: diag.join(' ') }
  const remux = await ffmpegRemuxAudioTrack(rec.file)
  if (remux) {
    diag.push(`remux:${remux.ext}`)
    return { blob: remux.blob, ext: remux.ext, pcm: null, diag: diag.join(' ') }
  }
  diag.push('remux:failed')
  return { blob: null, ext: 'wav', pcm: null, diag: diag.join(' ') }
}

/** The guarded decoder chain: WebCodecs (all tracks) → WebAudio decodeAudioData →
 *  ffmpeg.wasm (all streams). EVERY layer's output is checked for actual signal —
 *  on iOS the platform decoders "succeed" with pure silence for some clips, and
 *  an unchecked silent result here is exactly what made Cut Lord upload silence.
 *  Layers append what they saw to `diag`. */
async function extractAudioPcm16(rec: MediaRec, diag: string[], onProgress?: (pct: number) => void): Promise<Int16Array | null> {
  // 1. WebCodecs via mediabunny — platform decoder, no AudioContext, reads ALL
  //    audio tracks (screen recordings carry mic voice on track 2).
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 120000)
  try {
    const pcm = await webcodecsExtractPcm(rec, ctrl.signal, diag, onProgress)
    if (pcm) return pcm
  } catch {
    diag.push('wc[threw]')
  } finally {
    clearTimeout(timer)
  }
  // 2. WebAudio decodeAudioData — desktop-reliable; first track only. Trust it
  //    only when the decode carries signal.
  try {
    onProgress?.(40)
    const ab = await rec.file.arrayBuffer()
    const lead = mp4AudioStartOffset(ab) // parse BEFORE decode (it detaches ab)
    const audio = await decodeAudioAtRate(ab, 16000)
    const pcm = audioBufferToPcm16kMono(audio, lead)
    const pk = peakOfInt16(pcm)
    diag.push(`wa[${(pk / 32768).toFixed(2)}]`)
    if (pk >= PEAK_MIN_16) {
      onProgress?.(100)
      return pcm
    }
  } catch (e) {
    diag.push(`wa[${String((e as Error)?.message || e).slice(0, 40)}]`)
  }
  // 3. ffmpeg.wasm — on-device last resort; decodes what WebKit can't and mixes
  //    every non-silent stream. ~31 MB core, fetched lazily on first use.
  const ff = await ffmpegDecodeAudio(rec.file, (p) => onProgress?.(40 + Math.round(p * 0.6)))
  diag.push(ff.note)
  if (ff.pcm) {
    onProgress?.(100)
    return ff.pcm
  }
  return null
}

/** WebCodecs decode of EVERY audio track → 16 kHz mono int16, silence-guarded
 *  per track, non-silent tracks mixed. Returns null when no track carries
 *  signal (the per-track verdicts land in `diag`). */
async function webcodecsExtractPcm(
  rec: MediaRec,
  signal: AbortSignal,
  diag: string[],
  onProgress?: (pct: number) => void
): Promise<Int16Array | null> {
  let input: MBInput | null = null
  try {
    const { Input, BlobSource, ALL_FORMATS, AudioBufferSink } = await import('mediabunny')
    input = new Input({ source: new BlobSource(rec.file), formats: ALL_FORMATS })
    const tracks = await input.getAudioTracks()
    if (!tracks.length) {
      diag.push('wc[no-audio-track]')
      return null
    }
    const TARGET = 16000
    const notes: string[] = []
    const parts: Int16Array[] = []
    for (let t = 0; t < tracks.length; t++) {
      if (signal.aborted) break
      const track = tracks[t]
      if (!(await track.canDecode())) {
        notes.push(`t${t}:nodec`)
        continue
      }
      // Stream-decode this track with a drift-free linear resample; presentation
      // timestamps map the container's leading offset to silence automatically.
      const sink = new AudioBufferSink(track)
      const content: number[] = []
      let srcRate = 0
      let firstTs = -1
      let globalIn = 0
      let k = 0
      let failed = false
      try {
        for await (const wrapped of sink.buffers()) {
          if (signal.aborted) break
          const ab = wrapped.buffer
          if (!srcRate) srcRate = ab.sampleRate
          if (firstTs < 0) firstTs = Math.max(0, wrapped.timestamp)
          const nCh = ab.numberOfChannels
          const n = ab.length
          const mono = new Float32Array(n)
          for (let c = 0; c < nCh; c++) {
            const ch = ab.getChannelData(c)
            for (let j = 0; j < n; j++) mono[j] += ch[j]
          }
          if (nCh > 1) for (let j = 0; j < n; j++) mono[j] /= nCh
          const ratio = srcRate / TARGET
          const chunkEnd = globalIn + n
          while (k * ratio < chunkEnd) {
            const local = k * ratio - globalIn
            const i0 = Math.floor(local)
            const frac = local - i0
            const a = mono[i0]
            const b = i0 + 1 < n ? mono[i0 + 1] : mono[i0]
            let s = a + (b - a) * frac
            s = s < -1 ? -1 : s > 1 ? 1 : s
            content.push(s < 0 ? s * 0x8000 : s * 0x7fff)
            k++
          }
          globalIn = chunkEnd
        }
      } catch {
        failed = true
      }
      if (failed || !srcRate || !content.length) {
        notes.push(`t${t}:err`)
        continue
      }
      const lead = Math.max(0, Math.round(firstTs * TARGET))
      const pcm = new Int16Array(lead + content.length)
      pcm.set(content, lead)
      const pk = peakOfInt16(pcm)
      notes.push(`t${t}:${(pk / 32768).toFixed(2)}`)
      if (pk >= PEAK_MIN_16) parts.push(pcm)
      onProgress?.(Math.round(((t + 1) / tracks.length) * 35))
    }
    diag.push(`wc[${notes.join(' ')}]`)
    if (!parts.length) return null
    if (parts.length === 1) return parts[0]
    // Mix simultaneous tracks (mic + app audio), clamped.
    const len = Math.max(...parts.map((p) => p.length))
    const mixed = new Int16Array(len)
    for (let j = 0; j < len; j++) {
      let s = 0
      for (const p of parts) if (j < p.length) s += p[j]
      mixed[j] = s < -32768 ? -32768 : s > 32767 ? 32767 : s
    }
    return mixed
  } catch {
    diag.push('wc[err]')
    return null
  } finally {
    try {
      input?.dispose()
    } catch {
      /* already disposed */
    }
  }
}

/** Downmix to mono, resample to 16 kHz → int16 PCM. `leadSec` of leading
 *  silence is prepended to re-align a delayed audio stream to the video. */
function audioBufferToPcm16kMono(buf: AudioBuffer, leadSec = 0): Int16Array {
  const TARGET = 16000
  const chans: Float32Array[] = []
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c))
  const srcLen = chans[0]?.length ?? 0
  const ratio = buf.sampleRate / TARGET
  const outLen = Math.max(0, Math.floor(srcLen / ratio))
  const lead = Math.max(0, Math.round(leadSec * TARGET))
  const pcm = new Int16Array(lead + outLen) // [lead silence][content]
  const nch = chans.length || 1
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const frac = pos - i0
    let s = 0
    for (const ch of chans) {
      const a = ch[i0] ?? 0
      const b = ch[i0 + 1] ?? a
      s += a + (b - a) * frac
    }
    s = s / nch
    s = s < -1 ? -1 : s > 1 ? 1 : s
    pcm[lead + i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return pcm
}

function encodeWav(pcm: Int16Array, rate: number): Blob {
  const dataLen = pcm.length * 2
  const out = new ArrayBuffer(44 + dataLen)
  const view = new DataView(out)
  const writeStr = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataLen, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits
  writeStr(36, 'data')
  view.setUint32(40, dataLen, true)
  new Int16Array(out, 44).set(pcm)
  return new Blob([out], { type: 'audio/wav' })
}

/** Extract the video-time [inSec,outSec] slice of a decoded buffer as mono 16-bit
 *  PCM at `rate`, gain-scaled (linear resample). `lead` (from an MP4 edit list) is
 *  the audio's delay relative to video, so a video-time sample reads decoded-time
 *  `t - lead` (silence before the audio actually starts). */
function sliceMonoInt16(audio: AudioBuffer, inSec: number, outSec: number, rate: number, gain: number, lead: number): Int16Array {
  const nOut = Math.max(0, Math.round((outSec - inSec) * rate))
  const out = new Int16Array(nOut)
  const chans: Float32Array[] = []
  for (let c = 0; c < audio.numberOfChannels; c++) chans.push(audio.getChannelData(c))
  const nch = chans.length || 1
  const sr = audio.sampleRate
  for (let i = 0; i < nOut; i++) {
    const at = inSec + i / rate - lead
    if (at < 0) continue // before the audio starts → leave silent (0)
    const pos = at * sr
    const i0 = Math.floor(pos)
    const frac = pos - i0
    let s = 0
    for (const ch of chans) {
      const a = ch[i0] ?? 0
      const b = ch[i0 + 1] ?? a
      s += a + (b - a) * frac
    }
    s = (s / nch) * gain
    s = s < -1 ? -1 : s > 1 ? 1 : s
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

/** Cloud replacement for the desktop ffmpeg `combineClips(audioOnly)`: concatenate
 *  the montage clips' audio — each trimmed to [sourceIn,sourceOut], in order — into
 *  ONE 16 kHz mono WAV. Image / silent clips contribute silence for their natural
 *  length, so the WAV's timeline equals the montage's virtual time (cumulative
 *  sourceOut-sourceIn) — exactly where the transcript / silence / retake results
 *  are stored, so the existing single-file pipeline runs unchanged. Speed is NOT
 *  applied (the virtual domain is un-sped; speed is applied later at preview/export). */
export async function combineSequenceAudioWav(
  clips: { sourcePath: string; sourceIn: number; sourceOut: number; isImage?: boolean; hasAudio?: boolean; gain?: number }[],
  onProgress?: (pct: number) => void
): Promise<Blob> {
  const TARGET = 16000
  const parts: Int16Array[] = []
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]
    const nOut = Math.max(0, Math.round((c.sourceOut - c.sourceIn) * TARGET))
    const rec = registry.get(c.sourcePath)
    if (c.isImage || c.hasAudio === false || !rec) {
      parts.push(new Int16Array(nOut)) // still / silent / missing → silence, stays aligned
    } else {
      try {
        const buf = await rec.file.arrayBuffer()
        const lead = mp4AudioStartOffset(buf) // parse BEFORE decode (it detaches buf)
        const audio = await decodeAudioAtRate(buf, TARGET)
        parts.push(sliceMonoInt16(audio, c.sourceIn, c.sourceOut, TARGET, c.gain ?? 1, lead))
      } catch {
        parts.push(new Int16Array(nOut)) // decode failed → silence (keep time alignment)
      }
    }
    onProgress?.(Math.round(((i + 1) / clips.length) * 100))
  }
  const total = parts.reduce((n, a) => n + a.length, 0)
  const pcm = new Int16Array(total)
  let o = 0
  for (const a of parts) {
    pcm.set(a, o)
    o += a.length
  }
  return encodeWav(pcm, TARGET)
}
