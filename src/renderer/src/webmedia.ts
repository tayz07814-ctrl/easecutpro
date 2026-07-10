// Local-first media for the web client.
//
// On import we DON'T upload — we keep the File in the browser and play it from a
// blob URL, so manual editing is instant. Only when the PC actually needs the
// bytes (transcribe / silence / export) do we upload, lazily and in chunks
// (chunks dodge the ~100 MB request limit that tunnels like Cloudflare impose).
import type { MediaInfo, Waveform } from '@shared/types'

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

/** Keep a picked File locally; return an id used as its "path" in the model. */
export function registerLocalFile(file: File): string {
  const id = `webmedia:${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  registry.set(id, { file, url: URL.createObjectURL(file) })
  void idbPut(id, file) // survive reloads on this device (best effort)
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
function mp4AudioStartOffset(buf: ArrayBuffer): number {
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
async function decodeAudioAtRate(buf: ArrayBuffer, targetRate: number): Promise<AudioBuffer> {
  const AC: typeof AudioContext =
    window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  let ac: AudioContext
  try {
    ac = new AC({ sampleRate: targetRate })
  } catch {
    ac = new AC()
  }
  try {
    return await new Promise<AudioBuffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('decode timeout')), 25000)
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

/** Compute a waveform in the browser via WebAudio (best effort; skipped if huge). */
export async function localWaveform(id: string, peaksPerSec = 60): Promise<Waveform> {
  const rec = registry.get(id)
  if (!rec || rec.file.size > 700 * 1024 * 1024) return { peaksPerSec, peaks: [] }
  try {
    const buf = await rec.file.arrayBuffer()
    const leadPeaks = Math.round(mp4AudioStartOffset(buf) * peaksPerSec) // parse BEFORE decode (it detaches buf)
    // A waveform only needs the amplitude envelope, so decode/resample to a LOW
    // rate: ~6x less PCM to scan and far less memory (a multi-minute file at full
    // 48kHz can GC-thrash or OOM a phone).
    const audio = await decodeAudioAtRate(buf, 8000)
    // Use ALL channels (max across them): voice is often recorded on only one
    // channel, so reading channel 0 alone shows flat waves while someone speaks.
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
    // Pad the leading audio offset with silent peaks so the waveform aligns to
    // the video timeline (matches the desktop extraction fix).
    if (leadPeaks > 0) return { peaksPerSec, peaks: new Array(leadPeaks).fill(0).concat(peaks) }
    return { peaksPerSec, peaks }
  } catch {
    return { peaksPerSec, peaks: [] }
  }
}

/** Generate filmstrip thumbnails in the browser by seeking a <video> + drawing to
 *  a canvas — the web server never gets the full video, so this is the only way to
 *  show base-track thumbnails on the web. Best-effort + async + progressive.
 *
 *  iOS/iPadOS is the fussy target (every browser there is WebKit, incl. Chrome):
 *  a muted <video> that has NEVER played paints NOTHING to a canvas, and a
 *  `currentTime` set before the media is buffered may never fire `seeked`. So we
 *  (a) prime the decoder with a muted inline play→pause, (b) wait for a frame that
 *  is actually PRESENTED via requestVideoFrameCallback (fallback: `seeked`), and
 *  (c) time-bound every wait so a stalled seek skips one frame instead of wedging
 *  the whole strip. */
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
  return localThumbnailsSeek(rec, intervalSec, onPartial)
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

/** Decode a media file's audio in the browser → 16 kHz mono WAV Blob (null if it can't). */
export async function extractAudioWavBlob(id: string, onProgress?: (pct: number) => void): Promise<Blob | null> {
  const rec = registry.get(id)
  if (!rec) return null
  // Very large files risk OOM on decode; let the caller fall back to full upload.
  if (rec.file.size > 800 * 1024 * 1024) return null
  try {
    onProgress?.(5)
    const ab = await rec.file.arrayBuffer()
    const lead = mp4AudioStartOffset(ab) // parse BEFORE decode (it detaches ab)
    const audio = await decodeAudioAtRate(ab, 16000)
    onProgress?.(70)
    // Pad the leading offset so transcription timestamps align to the video.
    const wav = audioBufferTo16kMonoWav(audio, lead)
    onProgress?.(100)
    return wav
  } catch {
    return null // unsupported container/codec, or decode OOM
  }
}

/** Downmix to mono, resample to 16 kHz, encode 16-bit PCM WAV. `leadSec` of
 *  leading silence is prepended to re-align a delayed audio stream to the video. */
function audioBufferTo16kMonoWav(buf: AudioBuffer, leadSec = 0): Blob {
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
  return encodeWav(pcm, TARGET)
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
