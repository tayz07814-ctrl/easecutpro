// WebCodecs base-video engine for the DESKTOP preview (0.01).
//
// The element-pool player must SEEK a <video> at every cut seam; even warm
// seeks stall the picture for 30-150ms, and the buddy swap still shows a
// 1-frame hold (an element can't pre-roll invisibly). This engine removes the
// seek dependence entirely: each source is demuxed by Mediabunny and decoded
// with WebCodecs into VideoSamples the reconciler DRAWS onto the preview
// canvas — a cut is just "draw a frame from a different queue", zero seeks.
//
// Per source there are TWO pipes (the decoder twin of the element path's
// live/buddy pair): the live pipe iterates forward under the playhead while
// the warm pipe pre-decodes the NEXT segment's in-point, so a same-source cut
// swaps queues instead of restarting a decoder. draw() picks whichever pipe
// covers the requested time best and flips live itself; prewarm() parks the
// other pipe at an upcoming in-point.
//
// Failure is never fatal: any init/decode error sets `failed` and the preview
// falls back to the untouched element path (mobile always uses that path).

import type { Input, BlobSource, UrlSource, InputVideoTrack, VideoSample, VideoSampleSink } from 'mediabunny'
import { IS_WEB } from '../platform'
import { isWebMediaId, getFile } from '../webmedia'
import { resolveMedia } from '../media/resolver'

// Mediabunny is DYNAMICALLY imported (repo convention — the exports do the
// same) so mobile, which never runs this engine, pays nothing in the bundle.
type MB = typeof import('mediabunny')
let mbPromise: Promise<MB> | null = null
function loadMb(): Promise<MB> {
  if (!mbPromise) mbPromise = import('mediabunny')
  return mbPromise
}

/** True when this browser can run the WebCodecs preview at all. */
export function wcSupported(): boolean {
  return typeof window !== 'undefined' && 'VideoDecoder' in window
}

const QUEUE_AHEAD = 3 // decoded frames buffered ahead of the playhead per pipe
/** A `want` advance larger than this is a CUT, not normal playback. */
const JUMP_S = 0.15
/** How far forward we prefer to DECODE rather than seek.
 *
 *  Measured on a densely cut phone clip: the old "restart whenever the jump
 *  leaves the decoded window" rule fired 110 times in 10s of playback — ~11
 *  seeks/second, 3.9s of cumulative stall (39% of the time). Phone H.264 puts
 *  keyframes ~3s apart, so each seek re-decodes up to a full GOP anyway; just
 *  walking the decoder forward over the removed footage costs no more and
 *  keeps the picture live. Beyond roughly one GOP a seek starts to win. */
const FORWARD_DECODE_S = 3.0
/** Frame-skip policy. 'jump' (default) skips only across cuts; 'off' and 'all'
 *  exist so the packaged app can be A/B measured from DevTools without a
 *  rebuild (set window.__ecSkipMode). Read per sample, so it can be flipped
 *  mid-playback. */
type SkipMode = 'off' | 'all' | 'jump'
function skipMode(): SkipMode {
  return (typeof window !== 'undefined' && (window as { __ecSkipMode?: SkipMode }).__ecSkipMode) || 'jump'
}

/** Diagnostics for the preview stall hunt — where the frozen frames go.
 *  Readable from DevTools as window.__wcStats; zero cost when unread. */
const STATS = {
  restarts: 0,
  restartLatencyMs: [] as number[],
  skipped: 0,
  paintGood: 0,
  paintSeamCache: 0,
  paintStale: 0,
  paintNone: 0
}
if (typeof window !== 'undefined') (window as { __wcStats?: typeof STATS }).__wcStats = STATS
const COVER_SLACK = 0.4 // how far past the last queued frame we still count as "covered"

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

/** One decode pipeline over a source: an async sample iterator + a small
 *  look-ahead queue. `cur` is the frame currently presentable. */
class Pipe {
  cur: VideoSample | null = null
  private queue: VideoSample[] = []
  private iter: AsyncGenerator<VideoSample, void, unknown> | null = null
  private gen = 0
  private pumping = false
  /** Where an in-flight restart is decoding toward. `cur` stays on the STALE
   *  frame until the restarted iterator's first frame lands, so any "am I
   *  covering t?" check MUST consult this — judging by the stale `cur` made
   *  every tick issue another restart, each killing the previous pump before
   *  it could deliver a frame: a frozen picture with running audio. */
  private pendingStart: number | null = null
  /** The time the reconciler last asked for. */
  private want: number | null = null
  /** Set ONLY when `want` jumps (a cut): pump() then discards decoded samples
   *  until it reaches this time, so the skip runs at decode speed. Null during
   *  normal playback — see the note in pump(). */
  private skipUntil: number | null = null
  private restartAt = 0

  constructor(
    private readonly sink: VideoSampleSink,
    private readonly onError: (e: unknown) => void
  ) {}

  /** Timestamp of the frame currently presentable, or null. */
  get curTime(): number | null {
    return this.cur ? this.cur.timestamp : null
  }

  /** Coverage by DECODED frames only: ~0 when `cur`/queue can show t right
   *  now, else the distance to the covered window. */
  frameScore(t: number): number {
    if (!this.cur) return Number.POSITIVE_INFINITY
    const lo = this.cur.timestamp - 0.06
    const last = this.queue.length ? this.queue[this.queue.length - 1] : this.cur
    const hi = last.timestamp + last.duration + COVER_SLACK
    if (t >= lo && t <= hi) return Math.abs(t - this.cur.timestamp) / 1e6 // covered; prefer the closer cur
    return Math.min(Math.abs(t - lo), Math.abs(t - hi))
  }

  /** Coverage score for time t — a restart already DECODING toward t counts as
   *  covering it (used to pick which pipe should own t; drawing still needs a
   *  real frame, see frameScore). */
  score(t: number): number {
    if (this.pendingStart !== null && t >= this.pendingStart - 0.1 && t <= this.pendingStart + 2.5) {
      return Math.abs(t - this.pendingStart) / 1e6
    }
    return this.frameScore(t)
  }

  /** Restart the iterator at `t` (closing everything queued). The old `cur`
   *  keeps displaying until the first new frame lands — no black flash. */
  restart(t: number): void {
    this.gen++
    const old = this.iter
    this.iter = null
    if (old) void old.return(undefined).catch(() => undefined)
    for (const s of this.queue) s.close()
    this.queue = []
    this.pendingStart = Math.max(0, t)
    this.skipUntil = null // a seek lands on the target; nothing to skip past
    this.restartAt = performance.now()
    STATS.restarts++
    try {
      this.iter = this.sink.samples(Math.max(0, t))
    } catch (e) {
      this.onError(e)
      return
    }
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    const myGen = this.gen
    try {
      while (myGen === this.gen && this.iter && this.queue.length < QUEUE_AHEAD) {
        const it = this.iter
        const r = await it.next()
        if (myGen !== this.gen) {
          if (!r.done && r.value) r.value.close()
          return
        }
        if (r.done) break
        // FAST-FORWARD OVER CUT FOOTAGE (the "preview freezes at every cut").
        // A cut jumps the playhead forward inside the SAME source. Seeking
        // there is usually worse than decoding to it — phone H.264 keyframes
        // sit ~3s apart, so a seek re-decodes up to 90 frames from the last
        // keyframe — which is why follow() only restarts on a big jump and
        // otherwise lets the decoder walk forward.
        //
        // But walking forward delivers only QUEUE_AHEAD (3) frames per pump,
        // and the reconciler pumps once per animation frame: skipping a 1s cut
        // took ~30 ticks with the picture held the whole time. So when `want`
        // JUMPS, follow() arms skipUntil and we drop the skipped-over samples
        // here without queueing them, racing to the landing frame at decode
        // speed (`await it.next()` still yields, so the UI stays responsive).
        //
        // Gated on a jump ON PURPOSE: discarding every sample that merely
        // lands behind the playhead throws away frames whenever the decoder
        // runs a touch late, which is most of the time on 1080x1920 — measured
        // at 12.6 painted fps instead of 30. Late frames still get shown.
        const mode = skipMode()
        if (mode !== 'off') {
          const target = mode === 'all' ? this.want : this.skipUntil
          if (target !== null && r.value.timestamp + r.value.duration < target - 0.001) {
            r.value.close()
            STATS.skipped++
            continue
          }
          this.skipUntil = null // reached the landing frame
        }
        this.queue.push(r.value)
        if (this.pendingStart !== null && this.restartAt) {
          if (STATS.restartLatencyMs.length >= 200) STATS.restartLatencyMs.shift() // bounded
          STATS.restartLatencyMs.push(Math.round(performance.now() - this.restartAt))
          this.restartAt = 0
        }
        this.pendingStart = null // the restarted iterator delivered — coverage is real again
      }
    } catch (e) {
      if (myGen === this.gen) this.onError(e)
    } finally {
      this.pumping = false
      // restart() may have installed a replacement iterator while this pump
      // was awaiting the cancelled generation's next frame. Its pump() call
      // saw the latch and returned, so explicitly start it now; without this
      // handoff the new iterator remains permanently idle (audio runs while
      // the picture freezes). Keeping the handoff serial also avoids two
      // iterators pulling from the same VideoSampleSink concurrently.
      if (myGen !== this.gen && this.iter && this.queue.length < QUEUE_AHEAD) void this.pump()
    }
  }

  /** Playing: keep `cur` tracking `t`, starting/restarting the iterator as
   *  needed. Never re-restarts while a restart is still decoding toward a
   *  nearby time (that's what froze the picture). */
  follow(t: number): void {
    // A cut moves `want` forward by the removed span in ONE tick; normal
    // playback advances it by about a frame. Only the former arms the skip.
    if (this.want !== null && t - this.want > JUMP_S) this.skipUntil = t
    this.want = t
    if (this.pendingStart !== null) {
      // a restart is in flight; only abandon it if the playhead ran far past
      if (Math.abs(t - this.pendingStart) > 2.5) this.restart(t)
    } else if (!this.iter) {
      this.restart(t) // first play after a paused still: begin decoding
    } else if (this.score(t) > 1.5) {
      // Jumped beyond the decoded window. A SHORT FORWARD jump is just a cut:
      // decode through it (skipUntil, armed above, keeps those frames off the
      // canvas) instead of seeking — see FORWARD_DECODE_S. Backward jumps and
      // long skips still seek, which is genuinely cheaper there.
      const ahead = this.cur ? t - this.cur.timestamp : Number.POSITIVE_INFINITY
      if (!(ahead > 0 && ahead <= FORWARD_DECODE_S)) this.restart(t)
    }
    let moved = false
    while (this.queue.length && this.queue[0].timestamp <= t) {
      this.cur?.close()
      this.cur = this.queue.shift() as VideoSample
      moved = true
    }
    if (moved || this.queue.length < QUEUE_AHEAD) void this.pump()
  }

  /** Start/follow the streaming iterator and report when it has both the frame
   *  at `t` and at least one decoded frame after it. The latter is the small
   *  runway required to start the audio clock without holding the first frame. */
  prime(t: number): boolean {
    this.follow(t)
    return this.pendingStart === null && this.frameScore(t) <= COVER_SLACK && this.queue.length > 0
  }

  /** Park this pipe decoding at `t` (seam prewarm) unless it's already there
   *  or already restarting toward it. */
  park(t: number): void {
    if (this.pendingStart !== null && Math.abs(t - this.pendingStart) < 0.5) return
    if (this.score(t) <= 0.25) return
    this.want = t
    this.restart(t)
  }

  /** Paused/scrub: use the SAME sequential iterator playback will consume.
   *  The previous sparse getSample() path created a second decoder; when Play
   *  arrived before it finished, its late still could overwrite streamed frames
   *  and the two decoders contended for hardware. Keeping one iterator means the
   *  paused frame also leaves a ready-made playback runway in `queue`. */
  requestStill(t: number): void {
    this.want = t
    // Promote a decoded landing frame BEFORE testing coverage. Checking `cur`
    // first sees it as empty even though queue[0] is ready, and restarts the
    // iterator every rAF before that frame can ever be drawn.
    let moved = false
    while (this.queue.length && this.queue[0].timestamp <= t) {
      this.cur?.close()
      this.cur = this.queue.shift() as VideoSample
      moved = true
    }
    if (this.pendingStart !== null) {
      // A real scrub supersedes an older landing immediately; repeated rAF
      // requests for the same target leave its decoder alone.
      if (Math.abs(t - this.pendingStart) > 0.08) this.restart(t)
    } else if (!this.iter || this.frameScore(t) > 0.08) {
      this.restart(t)
    }
    if (moved || this.queue.length < QUEUE_AHEAD) void this.pump()
  }

  dispose(): void {
    this.gen++
    const old = this.iter
    this.iter = null
    if (old) void old.return(undefined).catch(() => undefined)
    for (const s of this.queue) s.close()
    this.queue = []
    this.cur?.close()
    this.cur = null
    this.pendingStart = null
  }
}

interface SourcePipes {
  input: Input | null
  pipes: [Pipe, Pipe] | null
  /** Which pipe OWNS the currently-displayed time (recomputed every render).
   *  prewarm() may only ever touch the other one — restarting the owner
   *  mid-segment killed its frames and froze the picture on short segments. */
  owner: 0 | 1
  ready: boolean
  dead: boolean
}

async function inputSourceFor(mb: MB, src: string): Promise<BlobSource | UrlSource> {
  // Web imports keep their File in the registry — a BlobSource reads it
  // directly (range reads off disk, no copy). Everything else goes through the
  // playable URL: blob: URLs are fetched whole (fetch ignores Range on them),
  // real URLs stream with range requests.
  if (IS_WEB && isWebMediaId(src)) {
    const f = getFile(src)
    if (f) return new mb.BlobSource(f)
  }
  const url = resolveMedia(src).url
  if (!url) throw new Error('no url for ' + src)
  if (url.startsWith('blob:')) return new mb.BlobSource(await (await fetch(url)).blob())
  return new mb.UrlSource(url)
}

const SEAM_CACHE_MAX = 600 // safety cap on cached landing frames
const SEAM_CACHE_LONG = 720 // longest side of a cached frame (px) — a brief flash; downscale is invisible
const SEAM_HIT_TOL = 0.12 // how close tSrc must be to a cached landing time to use it (s)

export class WcPlayer {
  /** Flips true on ANY pipeline error — the preview falls back to elements. */
  failed = false
  private sources = new Map<string, SourcePipes>()
  /** Landing-frame cache: each cut's in-point decoded ONCE (downscaled, held as
   *  an ImageBitmap decoupled from the live decoders). Built PROACTIVELY during
   *  the "Polishing" phase after cuts apply, so the FIRST playback draws every
   *  seam's real landing frame from here instead of holding the stale pre-cut
   *  frame — no freeze / stutter on cut crossings. Keyed by src. */
  private seamCache = new Map<string, { t: number; bmp: ImageBitmap; aspect: number }[]>()
  private cacheGen = 0

  private fail(e: unknown): void {
    if (!this.failed) console.warn('[wc-preview] falling back to element path:', e)
    this.failed = true
  }

  /** Decode + cache every cut's landing frame once (background, blocking-phase).
   *  `onProgress(done,total)` drives the Polishing bar. Idempotent per (src,t);
   *  a newer call supersedes it. Non-fatal on any error. */
  async cacheSeams(list: { src: string; t: number }[], onProgress?: (done: number, total: number) => void): Promise<void> {
    const myGen = ++this.cacheGen
    const bySrc = new Map<string, number[]>()
    for (const { src, t } of list) {
      const arr = bySrc.get(src) ?? []
      if (!arr.some((x) => Math.abs(x - t) < 0.02)) arr.push(t)
      bySrc.set(src, arr)
    }
    for (const src of [...this.seamCache.keys()]) if (!bySrc.has(src)) this.dropSeam(src)
    const total = Math.min(SEAM_CACHE_MAX, [...bySrc.values()].reduce((n, a) => n + a.length, 0))
    let done = 0
    onProgress?.(0, total)
    const mb = await loadMb().catch(() => null)
    if (!mb || myGen !== this.cacheGen) return
    let stored = [...this.seamCache.values()].reduce((n, a) => n + a.length, 0)
    for (const [src, times] of bySrc) {
      if (myGen !== this.cacheGen || stored >= SEAM_CACHE_MAX) break
      const store = this.seamCache.get(src) ?? []
      this.seamCache.set(src, store)
      const want = times.filter((t) => !store.some((e) => Math.abs(e.t - t) < 0.02)).sort((a, b) => a - b)
      if (!want.length) {
        done += times.length
        onProgress?.(Math.min(done, total), total)
        continue
      }
      let input: Input | null = null
      try {
        input = new mb.Input({ source: await inputSourceFor(mb, src), formats: mb.ALL_FORMATS })
        if (myGen !== this.cacheGen) { input.dispose(); return }
        const track = await input.getPrimaryVideoTrack()
        if (!track || !(await track.canDecode())) { input.dispose(); continue }
        const sink = new mb.VideoSampleSink(track)
        for await (const samp of sink.samplesAtTimestamps(want)) {
          if (myGen !== this.cacheGen) { samp?.close(); break }
          if (samp && stored < SEAM_CACHE_MAX) {
            try {
              const dw = samp.displayWidth
              const dh = samp.displayHeight
              const scale = Math.min(1, SEAM_CACHE_LONG / Math.max(dw, dh))
              const w = Math.max(2, Math.round(dw * scale))
              const h = Math.max(2, Math.round(dh * scale))
              const off = new OffscreenCanvas(w, h)
              const octx = off.getContext('2d')
              if (octx) {
                samp.draw(octx, 0, 0, w, h)
                store.push({ t: samp.timestamp, bmp: off.transferToImageBitmap(), aspect: dw / dh })
                stored++
              }
            } catch {
              /* frame not drawable — skip */
            }
          }
          samp?.close()
          done++
          onProgress?.(Math.min(done, total), total)
        }
        store.sort((a, b) => a.t - b.t)
      } catch {
        /* caching failure is non-fatal — live decode still plays */
      } finally {
        input?.dispose()
      }
    }
    onProgress?.(total, total)
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
        sp.pipes?.forEach((p) => p.dispose())
        sp.input?.dispose()
        this.sources.delete(src)
      }
    }
    for (const src of want) if (!this.sources.has(src)) this.open(src)
  }

  private open(src: string): void {
    const sp: SourcePipes = { input: null, pipes: null, owner: 0, ready: false, dead: false }
    this.sources.set(src, sp)
    void (async () => {
      try {
        const mb = await loadMb()
        const input = new mb.Input({ source: await inputSourceFor(mb, src), formats: mb.ALL_FORMATS })
        sp.input = input
        const track: InputVideoTrack | null = await input.getPrimaryVideoTrack()
        if (!track || !(await track.canDecode())) throw new Error('undecodable video track: ' + src)
        const onErr = (e: unknown): void => {
          sp.dead = true
          this.fail(e)
        }
        sp.pipes = [new Pipe(new mb.VideoSampleSink(track), onErr), new Pipe(new mb.VideoSampleSink(track), onErr)]
        sp.ready = true
        console.info('[wc-preview] source ready:', src.slice(-24))
      } catch (e) {
        sp.dead = true
        this.fail(e)
      }
    })()
  }

  /** Park a source's non-owner pipe at an upcoming in-point (seam decode-ahead).
   *  NEVER the owner: on segments shorter than the prewarm lead this used to
   *  restart the pipe still decoding the CURRENT segment — a frozen picture. */
  prewarm(src: string, tSrc: number): void {
    const sp = this.sources.get(src)
    if (!sp?.ready || !sp.pipes) return
    // Don't park the warm pipe for a seam the LIVE pipe will simply decode
    // through: parking is a seek, and on a densely cut timeline that doubled
    // the seek storm (one park + one restart per cut). Only pays off for a
    // different source, or a jump too long to walk. (For a different source
    // this source's owner holds no frame, so `own` is null and we park.)
    const own = sp.pipes[sp.owner].curTime
    if (own !== null && tSrc > own && tSrc - own <= FORWARD_DECODE_S) return
    sp.pipes[sp.owner ^ 1].park(tSrc)
  }

  /** Prepare sequential playback at a source timestamp. Returns true only when
   *  the selected pipe has a presentable frame plus decoded runway ahead. */
  prime(src: string, tSrc: number): boolean {
    const sp = this.sources.get(src)
    if (!sp?.ready || !sp.pipes || sp.dead) return false
    const [a, b] = sp.pipes
    sp.owner = a.score(tSrc) <= b.score(tSrc) ? 0 : 1
    return sp.pipes[sp.owner].prime(tSrc)
  }

  /**
   * Draw the frame for (src, tSrc) letterboxed into a cw×ch canvas context.
   * The pipe that best covers tSrc (a pending restart counts) OWNS the time and
   * is advanced/one-shot-fetched; drawing prefers the owner's REAL frame and
   * otherwise falls back to the nearest stale frame either pipe holds — a held
   * frame for a tick or two beats a black flash. Returns true if painted.
   */
  render(ctx: CanvasRenderingContext2D, cw: number, ch: number, src: string, tSrc: number, playing: boolean): boolean {
    const sp = this.sources.get(src)
    if (!sp?.ready || !sp.pipes || sp.dead) return false
    const [a, b] = sp.pipes
    sp.owner = a.score(tSrc) <= b.score(tSrc) ? 0 : 1
    const own = sp.pipes[sp.owner]
    const other = sp.pipes[sp.owner ^ 1]
    if (playing) own.follow(tSrc)
    else own.requestStill(tSrc)
    // Priority: a GOOD real frame (decoder on time) → the armed seam frame from
    // the cache (exactly this in-point, pre-decoded in the Polishing phase) →
    // the nearest stale frame. The cache is what keeps a late decoder from
    // holding the WRONG (pre-cut) frame on the first pass / dense timelines.
    const good = own.cur && own.frameScore(tSrc) <= COVER_SLACK ? own.cur : null
    if (good) STATS.paintGood++
    if (!good) {
      const hit = this.seamHit(src, tSrc)
      if (hit) STATS.paintSeamCache++
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
    let s: VideoSample | null = good
    if (!s) {
      const c1 = own.cur
      const c2 = other.cur
      s = !c1 ? c2 : !c2 ? c1 : Math.abs(c1.timestamp - tSrc) <= Math.abs(c2.timestamp - tSrc) ? c1 : c2
      if (s) STATS.paintStale++
    }
    if (!s) {
      STATS.paintNone++
      return false
    }
    const r = containRect(cw, ch, s.displayWidth / s.displayHeight)
    try {
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, cw, ch)
      s.draw(ctx, r.left, r.top, r.width, r.height)
    } catch {
      return false
    }
    return true
  }

  dispose(): void {
    this.cacheGen++
    for (const [, sp] of this.sources) {
      sp.pipes?.forEach((p) => p.dispose())
      sp.input?.dispose()
    }
    this.sources.clear()
    for (const src of [...this.seamCache.keys()]) this.dropSeam(src)
  }
}
