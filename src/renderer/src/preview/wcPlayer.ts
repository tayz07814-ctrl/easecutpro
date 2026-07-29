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
  private stillBusy = false
  private stillWant: number | null = null
  /** Where an in-flight restart is decoding toward. `cur` stays on the STALE
   *  frame until the restarted iterator's first frame lands, so any "am I
   *  covering t?" check MUST consult this — judging by the stale `cur` made
   *  every tick issue another restart, each killing the previous pump before
   *  it could deliver a frame: a frozen picture with running audio. */
  private pendingStart: number | null = null

  constructor(
    private readonly sink: VideoSampleSink,
    private readonly onError: (e: unknown) => void
  ) {}

  /** Coverage score for time t: 0 = this pipe can show t right now (tie-break
   *  by distance from cur), else the distance to its covered window. A restart
   *  already decoding toward t counts as covering it. */
  score(t: number): number {
    if (this.pendingStart !== null && t >= this.pendingStart - 0.1 && t <= this.pendingStart + 2.5) {
      return Math.abs(t - this.pendingStart) / 1e6
    }
    if (!this.cur) return Number.POSITIVE_INFINITY
    const lo = this.cur.timestamp - 0.06
    const last = this.queue.length ? this.queue[this.queue.length - 1] : this.cur
    const hi = last.timestamp + last.duration + COVER_SLACK
    if (t >= lo && t <= hi) return Math.abs(t - this.cur.timestamp) / 1e6 // covered; prefer the closer cur
    return Math.min(Math.abs(t - lo), Math.abs(t - hi))
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
      while (this.iter && this.queue.length < QUEUE_AHEAD) {
        const it = this.iter
        const r = await it.next()
        if (myGen !== this.gen) {
          if (!r.done && r.value) r.value.close()
          return
        }
        if (r.done) break
        this.queue.push(r.value)
        this.pendingStart = null // the restarted iterator delivered — coverage is real again
      }
    } catch (e) {
      if (myGen === this.gen) this.onError(e)
    } finally {
      if (myGen === this.gen) this.pumping = false
    }
  }

  /** Playing: keep `cur` tracking `t`, starting/restarting the iterator as
   *  needed. Never re-restarts while a restart is still decoding toward a
   *  nearby time (that's what froze the picture). */
  follow(t: number): void {
    if (this.pendingStart !== null) {
      // a restart is in flight; only abandon it if the playhead ran far past
      if (Math.abs(t - this.pendingStart) > 2.5) this.restart(t)
    } else if (!this.iter) {
      this.restart(t) // first play after a paused still: begin decoding
    } else if (this.score(t) > 1.5) {
      this.restart(t) // jumped beyond coverage (scrub-then-play, big skip)
    }
    let moved = false
    while (this.queue.length && this.queue[0].timestamp <= t) {
      this.cur?.close()
      this.cur = this.queue.shift() as VideoSample
      moved = true
    }
    if (moved || this.queue.length < QUEUE_AHEAD) void this.pump()
  }

  /** Park this pipe decoding at `t` (seam prewarm) unless it's already there
   *  or already restarting toward it. */
  park(t: number): void {
    if (this.pendingStart !== null && Math.abs(t - this.pendingStart) < 0.5) return
    if (this.score(t) <= 0.25) return
    this.restart(t)
  }

  /** Paused/scrub: fetch exactly the frame at `t` (debounced one-shot). */
  requestStill(t: number): void {
    if (this.cur && Math.abs(this.cur.timestamp - t) <= Math.max(0.02, this.cur.duration)) return
    this.stillWant = t
    if (this.stillBusy) return
    this.stillBusy = true
    const run = async (): Promise<void> => {
      try {
        while (this.stillWant !== null) {
          const want = this.stillWant
          this.stillWant = null
          const s = await this.sink.getSample(want)
          if (s) {
            this.cur?.close()
            this.cur = s
          }
        }
      } catch (e) {
        this.onError(e)
      } finally {
        this.stillBusy = false
      }
    }
    void run()
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
  live: 0 | 1
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

export class WcPlayer {
  /** Flips true on ANY pipeline error — the preview falls back to elements. */
  failed = false
  private sources = new Map<string, SourcePipes>()

  private fail(e: unknown): void {
    if (!this.failed) console.warn('[wc-preview] falling back to element path:', e)
    this.failed = true
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
    const sp: SourcePipes = { input: null, pipes: null, live: 0, ready: false, dead: false }
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
      } catch (e) {
        sp.dead = true
        this.fail(e)
      }
    })()
  }

  /** Park a source's WARM pipe at an upcoming in-point (seam decode-ahead). */
  prewarm(src: string, tSrc: number): void {
    const sp = this.sources.get(src)
    if (!sp?.ready || !sp.pipes) return
    sp.pipes[sp.live ^ 1].park(tSrc)
  }

  /**
   * Draw the frame for (src, tSrc) letterboxed into a cw×ch canvas context.
   * Picks the better-covering pipe (flipping live at a seam), advances it while
   * playing or one-shot-fetches while paused. Returns true if a frame painted.
   */
  render(ctx: CanvasRenderingContext2D, cw: number, ch: number, src: string, tSrc: number, playing: boolean): boolean {
    const sp = this.sources.get(src)
    if (!sp?.ready || !sp.pipes || sp.dead) return false
    const [a, b] = sp.pipes
    const cand = a.score(tSrc) <= b.score(tSrc) ? 0 : 1
    if (cand !== sp.live && sp.pipes[cand].score(tSrc) < sp.pipes[sp.live].score(tSrc) - 1e-9) sp.live = cand as 0 | 1
    const pipe = sp.pipes[sp.live]
    if (playing) pipe.follow(tSrc)
    else pipe.requestStill(tSrc)
    const s = pipe.cur
    if (!s) {
      if (!playing) return false
      return false
    }
    const r = containRect(cw, ch, s.displayWidth / s.displayHeight)
    try {
      s.draw(ctx, r.left, r.top, r.width, r.height)
    } catch {
      return false
    }
    return true
  }

  dispose(): void {
    for (const [, sp] of this.sources) {
      sp.pipes?.forEach((p) => p.dispose())
      sp.input?.dispose()
    }
    this.sources.clear()
  }
}
