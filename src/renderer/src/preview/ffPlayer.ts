// Native-ffmpeg base-video engine for the WINDOWS DESKTOP preview.
//
// Same job and same public surface as WcPlayer (the reconciler can drive either
// without knowing which it holds), but the decoder is the BUNDLED ffmpeg in the
// main process: each pipe fetches `ecframes://frames/?p=…&t=…` and receives raw
// yuv420p frames — no WebCodecs decode, no browser codec limits (HEVC 10-bit /
// ProRes preview exactly like the export), and rotation applied by ffmpeg.
// Frames are wrapped in zero-copy-ish I420 VideoFrames purely for the GPU
// drawImage path; no decoding happens in the renderer.
//
// The two-pipe/owner/seam-cache design is ported from wcPlayer.ts on purpose —
// those semantics (pendingStart coverage, never restarting the owner, the
// serial pump handoff) each fix a specific frozen-picture bug; see the comments
// there. The one genuinely new concern here is that a pipe restart is an ffmpeg
// PROCESS SPAWN (~50-150ms), not a decoder seek, so paused-scrub restarts are
// debounced toward the latest target instead of firing per rAF.
//
// Failure is never fatal: any error sets `failed` and the preview falls back to
// the untouched element path, exactly like WcPlayer.

import { IS_WEB } from '../platform'

/** True when the native frame server is reachable (Electron with preload). */
export function ffSupported(): boolean {
  return (
    !IS_WEB &&
    typeof window !== 'undefined' &&
    !!(window as { api?: unknown }).api &&
    typeof VideoFrame !== 'undefined'
  )
}

const QUEUE_AHEAD = 3 // decoded frames buffered ahead of the playhead per pipe
const COVER_SLACK = 0.4 // how far past the last queued frame we still count as "covered"
const STILL_RESTART_MIN_MS = 150 // paused-scrub debounce: one ffmpeg spawn per this window
/** Prefer decoding forward over re-spawning ffmpeg for jumps this short —
 *  see the measured rationale on wcPlayer's FORWARD_DECODE_S. */
const FORWARD_DECODE_S = 3.0

function frameUrl(src: string, t: number, frames?: number): string {
  const f = frames ? `&frames=${frames}` : ''
  return `ecframes://frames/?p=${encodeURIComponent(src)}&t=${Math.max(0, t).toFixed(3)}${f}`
}

interface Rect {
  left: number
  top: number
  width: number
  height: number
}

function containRect(w: number, h: number, aspect: number): Rect {
  if (w <= 0 || h <= 0 || !isFinite(aspect) || aspect <= 0) return { left: 0, top: 0, width: w, height: h }
  if (w / h > aspect) {
    const width = h * aspect
    return { left: (w - width) / 2, top: 0, width, height: h }
  }
  const height = w / aspect
  return { left: 0, top: (h - height) / 2, width: w, height }
}

/** A raw frame off the stream. `t`/`dur` are SECONDS (mirrors VideoSample). */
interface FfFrame {
  vf: VideoFrame
  t: number
  dur: number
}

interface StreamMeta {
  w: number
  h: number
  fps: number
  t0: number
}

/** One ffmpeg decode stream over a source + a small look-ahead queue. The
 *  state machine (pendingStart / gen / serial pump handoff) is wcPlayer's Pipe;
 *  only the frame source differs. */
class FfPipe {
  cur: FfFrame | null = null
  private queue: FfFrame[] = []
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private abortCtl: AbortController | null = null
  private opening: Promise<void> | null = null
  private meta: StreamMeta = { w: 0, h: 0, fps: 30, t0: 0 }
  private parts: Uint8Array[] = []
  private partsLen = 0
  private frameIdx = 0
  private gen = 0
  private pumping = false
  /** See wcPlayer.ts Pipe.pendingStart — coverage checks MUST consult this. */
  private pendingStart: number | null = null
  /** Last requested time — frames older than this are cut footage and are
   *  skipped without building a VideoFrame (see ingest()). */
  private want: number | null = null
  private lastRestartWall = 0
  private stillTimer = 0
  private stillTarget: number | null = null

  constructor(
    private readonly src: string,
    private readonly onError: (e: unknown) => void
  ) {}

  frameScore(t: number): number {
    if (!this.cur) return Number.POSITIVE_INFINITY
    const lo = this.cur.t - 0.06
    const last = this.queue.length ? this.queue[this.queue.length - 1] : this.cur
    const hi = last.t + last.dur + COVER_SLACK
    if (t >= lo && t <= hi) return Math.abs(t - this.cur.t) / 1e6 // covered; prefer the closer cur
    return Math.min(Math.abs(t - lo), Math.abs(t - hi))
  }

  score(t: number): number {
    if (this.pendingStart !== null && t >= this.pendingStart - 0.1 && t <= this.pendingStart + 2.5) {
      return Math.abs(t - this.pendingStart) / 1e6
    }
    return this.frameScore(t)
  }

  /** Kill the current ffmpeg stream and start a new one at `t`. The old `cur`
   *  keeps displaying until the first new frame lands — no black flash. */
  restart(t: number): void {
    this.gen++
    const myGen = this.gen
    this.lastRestartWall = performance.now()
    if (this.stillTimer) {
      window.clearTimeout(this.stillTimer)
      this.stillTimer = 0
      this.stillTarget = null
    }
    this.abortCtl?.abort() // cancels the fetch → protocol stream cancel → ffmpeg killed
    this.reader = null
    this.parts = []
    this.partsLen = 0
    this.frameIdx = 0
    for (const f of this.queue) f.vf.close()
    this.queue = []
    this.pendingStart = Math.max(0, t)
    const ac = new AbortController()
    this.abortCtl = ac
    this.opening = (async () => {
      const res = await fetch(frameUrl(this.src, t), { signal: ac.signal })
      if (!res.ok || !res.body) throw new Error(`ecframes ${res.status} for ${this.src.slice(-24)}`)
      if (myGen !== this.gen) {
        void res.body.cancel().catch(() => undefined)
        return
      }
      this.meta = {
        w: Number(res.headers.get('X-EC-W')) || 0,
        h: Number(res.headers.get('X-EC-H')) || 0,
        fps: Number(res.headers.get('X-EC-FPS')) || 30,
        t0: Number(res.headers.get('X-EC-T0')) || Math.max(0, t)
      }
      if (!this.meta.w || !this.meta.h) throw new Error('ecframes: missing geometry headers')
      this.reader = res.body.getReader()
    })()
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    const myGen = this.gen
    try {
      await this.opening
      while (myGen === this.gen && this.reader && this.queue.length < QUEUE_AHEAD) {
        const rd = this.reader
        const r = await rd.read()
        if (myGen !== this.gen) return
        // EOS: leave pendingStart as-is (mirrors wc: a request past the file's
        // end must not restart-loop; the reconciler never asks past sourceEnd).
        if (r.done) break
        this.ingest(r.value)
      }
    } catch (e) {
      if (myGen === this.gen && (e as Error)?.name !== 'AbortError') this.onError(e)
    } finally {
      this.pumping = false
      // Serial handoff (see wcPlayer.ts): restart() installed a replacement
      // stream while this pump awaited the cancelled generation — start it.
      if (myGen !== this.gen && (this.reader || this.opening) && this.queue.length < QUEUE_AHEAD) void this.pump()
    }
  }

  /** Slice the byte stream into whole frames. One copy per frame (assembling
   *  chunk-by-chunk into a growing buffer was quadratic — 100s of MB/s of
   *  pointless memcpy at 30fps). */
  private ingest(chunk: Uint8Array): void {
    this.parts.push(chunk)
    this.partsLen += chunk.length
    const bytes = (this.meta.w * this.meta.h * 3) / 2
    while (this.partsLen >= bytes) {
      const data = new Uint8Array(bytes)
      let need = bytes
      let at = 0
      while (need > 0) {
        const head = this.parts[0]
        if (head.length <= need) {
          data.set(head, at)
          at += head.length
          need -= head.length
          this.parts.shift()
        } else {
          data.set(head.subarray(0, need), at)
          this.parts[0] = head.subarray(need)
          at += need
          need = 0
        }
      }
      this.partsLen -= bytes
      const t = this.meta.t0 + this.frameIdx / this.meta.fps
      const dur = 1 / this.meta.fps
      // Cut footage the playhead already passed: drop the bytes without
      // building a VideoFrame so a skip costs nothing but the memcpy (same
      // fast-forward rule as wcPlayer.pump — see the long note there).
      if (this.want !== null && t + dur < this.want - 0.001) {
        this.frameIdx++
        continue
      }
      try {
        const vf = new VideoFrame(data, {
          format: 'I420',
          codedWidth: this.meta.w,
          codedHeight: this.meta.h,
          timestamp: Math.round(t * 1e6),
          duration: Math.round(dur * 1e6),
          colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }
        })
        this.queue.push({ vf, t, dur })
        this.pendingStart = null // the restarted stream delivered — coverage is real again
      } catch (e) {
        this.onError(e)
        return
      }
      this.frameIdx++
    }
  }

  /** Playing: keep `cur` tracking `t` (same policy as wcPlayer's follow). */
  follow(t: number): void {
    this.want = t
    if (this.pendingStart !== null) {
      if (Math.abs(t - this.pendingStart) > 2.5) this.restart(t)
    } else if (!this.reader && !this.opening) {
      this.restart(t) // first play after a paused still: begin decoding
    } else if (this.score(t) > 1.5) {
      // Same rule as wcPlayer (see FORWARD_DECODE_S there): a short FORWARD
      // jump is a cut — read on through it rather than restarting, which here
      // costs a whole ffmpeg process spawn.
      const ahead = this.cur ? t - this.cur.t : Number.POSITIVE_INFINITY
      if (!(ahead > 0 && ahead <= FORWARD_DECODE_S)) this.restart(t)
    }
    let moved = false
    while (this.queue.length && this.queue[0].t <= t) {
      this.cur?.vf.close()
      this.cur = this.queue.shift() as FfFrame
      moved = true
    }
    if (moved || this.queue.length < QUEUE_AHEAD) void this.pump()
  }

  prime(t: number): boolean {
    this.follow(t)
    return this.pendingStart === null && this.frameScore(t) <= COVER_SLACK && this.queue.length > 0
  }

  /** Park this pipe decoding at `t` (seam prewarm). */
  park(t: number): void {
    if (this.pendingStart !== null && Math.abs(t - this.pendingStart) < 0.5) return
    if (this.score(t) <= 0.25) return
    this.want = t
    this.restart(t)
  }

  /** Paused/scrub. Unlike wcPlayer (decoder seek ≈ free) every restart here is
   *  an ffmpeg spawn, and the rAF loop re-targets on every drag tick — so
   *  restarts are rate-limited and always retarget to the LATEST request. */
  requestStill(t: number): void {
    this.want = t
    let moved = false
    while (this.queue.length && this.queue[0].t <= t) {
      this.cur?.vf.close()
      this.cur = this.queue.shift() as FfFrame
      moved = true
    }
    const wants =
      this.pendingStart !== null
        ? Math.abs(t - this.pendingStart) > 0.08
        : (!this.reader && !this.opening) || this.frameScore(t) > 0.08
    if (wants) {
      const now = performance.now()
      const since = now - this.lastRestartWall
      if (since >= STILL_RESTART_MIN_MS) {
        this.restart(t)
      } else {
        this.stillTarget = t
        if (!this.stillTimer) {
          this.stillTimer = window.setTimeout(
            () => {
              this.stillTimer = 0
              const tt = this.stillTarget
              this.stillTarget = null
              if (tt === null) return
              const stillWants =
                this.pendingStart !== null
                  ? Math.abs(tt - this.pendingStart) > 0.08
                  : (!this.reader && !this.opening) || this.frameScore(tt) > 0.08
              if (stillWants) this.restart(tt)
            },
            Math.max(1, STILL_RESTART_MIN_MS - since + 1)
          )
        }
      }
    }
    if (moved || this.queue.length < QUEUE_AHEAD) void this.pump()
  }

  dispose(): void {
    this.gen++
    if (this.stillTimer) {
      window.clearTimeout(this.stillTimer)
      this.stillTimer = 0
    }
    this.abortCtl?.abort()
    this.abortCtl = null
    this.reader = null
    this.opening = null
    this.parts = []
    this.partsLen = 0
    for (const f of this.queue) f.vf.close()
    this.queue = []
    this.cur?.vf.close()
    this.cur = null
    this.pendingStart = null
  }
}

interface SourcePipes {
  pipes: [FfPipe, FfPipe]
  /** Which pipe OWNS the currently-displayed time — prewarm() may only ever
   *  touch the other one (see wcPlayer.ts). */
  owner: 0 | 1
  dead: boolean
}

const SEAM_CACHE_MAX = 600
const SEAM_CACHE_LONG = 720
const SEAM_HIT_TOL = 0.12
const SEAM_FETCH_PAR = 4 // concurrent single-frame ffmpeg spawns while polishing

export class FfPlayer {
  /** Flips true on ANY pipeline error — the preview falls back to elements. */
  failed = false
  private sources = new Map<string, SourcePipes>()
  private seamCache = new Map<string, { t: number; bmp: ImageBitmap; aspect: number }[]>()
  private cacheGen = 0
  /** Original source → conditioned edit-friendly copy (dense keyframes), set by
   *  DocPreview when the IPC conditioning pass reports a file. */
  private conditioned = new Map<string, string>()

  private fail(e: unknown): void {
    if (!this.failed) console.warn('[ff-preview] falling back to element path:', e)
    this.failed = true
  }

  /** Adopt a conditioned preview copy for `src`, recreating its pipes so they
   *  spawn ffmpeg against the dense-keyframe file (every restart costs 1-3
   *  frames of decode instead of a full long-GOP seek). Call while PAUSED —
   *  recreating mid-playback would drop the picture for the spawn duration.
   *  Mirrors WcPlayer.useConditioned. */
  useConditioned(src: string, path: string): void {
    if (!path || this.conditioned.get(src) === path) return
    this.conditioned.set(src, path)
    const sp = this.sources.get(src)
    if (!sp) return
    sp.pipes.forEach((p) => p.dispose())
    this.sources.delete(src)
    this.open(src)
  }

  private open(src: string): void {
    const sp: SourcePipes = { pipes: null as unknown as [FfPipe, FfPipe], owner: 0, dead: false }
    this.sources.set(src, sp)
    const onErr = (e: unknown): void => {
      sp.dead = true
      this.fail(e)
    }
    const eff = this.conditioned.get(src) ?? src
    sp.pipes = [new FfPipe(eff, onErr), new FfPipe(eff, onErr)]
  }

  /** Fetch exactly one frame at (src,t) and downscale it to a cache bitmap. */
  private async grabStill(src: string, t: number): Promise<{ t: number; bmp: ImageBitmap; aspect: number } | null> {
    const res = await fetch(frameUrl(src, t, 1))
    if (!res.ok || !res.body) return null
    const w = Number(res.headers.get('X-EC-W')) || 0
    const h = Number(res.headers.get('X-EC-H')) || 0
    if (!w || !h) return null
    const bytes = (w * h * 3) / 2
    const data = new Uint8Array(bytes)
    let got = 0
    const reader = res.body.getReader()
    try {
      while (got < bytes) {
        const r = await reader.read()
        if (r.done) break
        const take = Math.min(r.value.length, bytes - got)
        data.set(r.value.subarray(0, take), got)
        got += take
      }
    } finally {
      void reader.cancel().catch(() => undefined)
    }
    if (got < bytes) return null // e.g. t past EOF — ffmpeg produced nothing
    const vf = new VideoFrame(data, {
      format: 'I420',
      codedWidth: w,
      codedHeight: h,
      timestamp: Math.round(t * 1e6),
      colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }
    })
    try {
      const scale = Math.min(1, SEAM_CACHE_LONG / Math.max(w, h))
      const bw = Math.max(2, Math.round(w * scale))
      const bh = Math.max(2, Math.round(h * scale))
      const off = new OffscreenCanvas(bw, bh)
      const octx = off.getContext('2d')
      if (!octx) return null
      octx.drawImage(vf, 0, 0, bw, bh)
      return { t, bmp: off.transferToImageBitmap(), aspect: w / h }
    } finally {
      vf.close()
    }
  }

  /** Decode + cache every cut's landing frame once (Polishing phase). Same
   *  contract as WcPlayer.cacheSeams; work is capped and mildly parallel
   *  because each still is its own short-lived ffmpeg. */
  async cacheSeams(list: { src: string; t: number }[], onProgress?: (done: number, total: number) => void): Promise<void> {
    const myGen = ++this.cacheGen
    const bySrc = new Map<string, number[]>()
    for (const { src, t } of list) {
      const arr = bySrc.get(src) ?? []
      if (!arr.some((x) => Math.abs(x - t) < 0.02)) arr.push(t)
      bySrc.set(src, arr)
    }
    for (const src of [...this.seamCache.keys()]) if (!bySrc.has(src)) this.dropSeam(src)
    const jobs: { src: string; t: number }[] = []
    for (const [src, times] of bySrc) {
      const store = this.seamCache.get(src) ?? []
      this.seamCache.set(src, store)
      for (const t of times.sort((a, b) => a - b)) {
        if (!store.some((e) => Math.abs(e.t - t) < 0.02)) jobs.push({ src, t })
      }
    }
    let stored = [...this.seamCache.values()].reduce((n, a) => n + a.length, 0)
    const capped = jobs.slice(0, Math.max(0, SEAM_CACHE_MAX - stored))
    const total = capped.length
    let done = 0
    onProgress?.(0, total)
    const worker = async (): Promise<void> => {
      for (;;) {
        if (myGen !== this.cacheGen) return
        const j = capped.shift()
        if (!j) return
        try {
          const hit = await this.grabStill(j.src, j.t)
          if (myGen !== this.cacheGen) {
            hit?.bmp.close()
            return
          }
          if (hit && stored < SEAM_CACHE_MAX) {
            const store = this.seamCache.get(j.src)
            if (store) {
              store.push(hit)
              store.sort((a, b) => a.t - b.t)
              stored++
            } else {
              hit.bmp.close()
            }
          }
        } catch {
          /* caching failure is non-fatal — live decode still plays */
        }
        done++
        onProgress?.(Math.min(done, total), total)
      }
    }
    await Promise.all(Array.from({ length: SEAM_FETCH_PAR }, () => worker()))
    onProgress?.(total, total)
  }

  /** Abandon any in-flight seam-cache build (playback started, or a newer cut
   *  list is starting one). Workers re-check the generation per frame and bail;
   *  already-cached entries stay valid. Mirrors WcPlayer.cancelCacheSeams. */
  cancelCacheSeams(): void {
    this.cacheGen++
  }

  private dropSeam(src: string): void {
    for (const e of this.seamCache.get(src) ?? []) e.bmp.close()
    this.seamCache.delete(src)
  }

  private seamHit(src: string, t: number): { bmp: ImageBitmap; aspect: number } | null {
    const arr = this.seamCache.get(src)
    if (!arr) return null
    let best: { bmp: ImageBitmap; aspect: number } | null = null
    let bestD = SEAM_HIT_TOL
    for (const e of arr) {
      const d = Math.abs(e.t - t)
      if (d < bestD) {
        bestD = d
        best = e
      }
    }
    return best
  }

  /** Declare the current set of base-video sources (idempotent; drops gone ones). */
  setSources(list: { src: string }[]): void {
    const want = new Set(list.map((l) => l.src))
    for (const [src, sp] of this.sources) {
      if (!want.has(src)) {
        sp.pipes.forEach((p) => p.dispose())
        this.sources.delete(src)
      }
    }
    for (const src of want) if (!this.sources.has(src)) this.open(src)
  }

  /** Park a source's non-owner pipe at an upcoming in-point (seam decode-ahead).
   *  `fromTSrc` (the outgoing clip's sourceEnd) is accepted for signature parity
   *  with WcPlayer but not used to skip: this engine seeks by respawning ffmpeg,
   *  so it cannot cheaply decode through removed footage the way WebCodecs can —
   *  parking ahead is still the better trade here. */
  prewarm(src: string, tSrc: number, _fromTSrc?: number): void {
    const sp = this.sources.get(src)
    if (!sp || sp.dead) return
    sp.pipes[sp.owner ^ 1].park(tSrc)
  }

  /** Prepare sequential playback at a source timestamp. */
  prime(src: string, tSrc: number): boolean {
    const sp = this.sources.get(src)
    if (!sp || sp.dead) return false
    const [a, b] = sp.pipes
    sp.owner = a.score(tSrc) <= b.score(tSrc) ? 0 : 1
    return sp.pipes[sp.owner].prime(tSrc)
  }

  /** Draw the frame for (src, tSrc) letterboxed into a cw×ch canvas context.
   *  Same priority ladder as WcPlayer.render. Returns true if painted. */
  render(ctx: CanvasRenderingContext2D, cw: number, ch: number, src: string, tSrc: number, playing: boolean): boolean {
    const sp = this.sources.get(src)
    if (!sp || sp.dead) return false
    const [a, b] = sp.pipes
    sp.owner = a.score(tSrc) <= b.score(tSrc) ? 0 : 1
    const own = sp.pipes[sp.owner]
    const other = sp.pipes[sp.owner ^ 1]
    if (playing) own.follow(tSrc)
    else own.requestStill(tSrc)
    const good = own.cur && own.frameScore(tSrc) <= COVER_SLACK ? own.cur : null
    if (!good) {
      const hit = this.seamHit(src, tSrc)
      if (hit) {
        const rr = containRect(cw, ch, hit.aspect)
        try {
          ctx.fillStyle = '#000'
          ctx.fillRect(0, 0, cw, ch)
          ctx.drawImage(hit.bmp, rr.left, rr.top, rr.width, rr.height)
          return true
        } catch {
          /* fall through to a real frame */
        }
      }
    }
    let f: FfFrame | null = good
    if (!f) {
      // STALE-FRAME GUARD: when crossing a cut boundary, the "nearest" frame
      // by timestamp is often the LAST frame of the PREVIOUS clip. Reject frames
      // that are behind the nearest cached seam landing point for this source.
      const seamEntries = this.seamCache.get(src) ?? []
      const nextSeam = seamEntries.find((e) => e.t >= tSrc)
      const cutBoundary = nextSeam ? nextSeam.t : null
      const c1 = own.cur
      const c2 = other.cur
      const candidates = [c1, c2].filter((f): f is FfFrame => !!f)
      for (const candidate of candidates) {
        // If we know a cut boundary ahead, discard frames from before it.
        // Also discard if the frame is significantly BEHIND tSrc (pre-cut).
        if (cutBoundary !== null && candidate.t < cutBoundary - 0.05) continue
        if (tSrc - candidate.t > 0.25) continue // more than a frame behind = likely pre-cut
        f = candidate
        break
      }
    }
    if (!f) return false
    const r = containRect(cw, ch, f.vf.displayWidth / f.vf.displayHeight)
    try {
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, cw, ch)
      ctx.drawImage(f.vf, r.left, r.top, r.width, r.height)
    } catch {
      return false
    }
    return true
  }

  dispose(): void {
    this.cacheGen++
    for (const [, sp] of this.sources) sp.pipes.forEach((p) => p.dispose())
    this.sources.clear()
    for (const src of [...this.seamCache.keys()]) this.dropSeam(src)
  }
}
