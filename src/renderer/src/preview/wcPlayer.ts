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

  /** Coverage by DECODED frames only: ~0 when `cur`/queue can show t right
   *  now, else the distance to the covered window. A parked warm pipe fills the
   *  QUEUE without promoting `cur` yet, so coverage measures from the front of
   *  whatever is decoded (cur, else queue[0]) — judging by `cur` alone reported
   *  a fully-decoded warm pipe as "no coverage" and cold-restarted it at the
   *  seam, wasting the prewarm and freezing the frame during the cold decode. */
  frameScore(t: number): number {
    const front = this.cur ?? (this.queue.length ? this.queue[0] : null)
    if (!front) return Number.POSITIVE_INFINITY
    const lo = front.timestamp - 0.06
    const last = this.queue.length ? this.queue[this.queue.length - 1] : front
    const hi = last.timestamp + last.duration + COVER_SLACK
    if (t >= lo && t <= hi) return Math.abs(t - front.timestamp) / 1e6 // covered; prefer the closer front
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
        this.queue.push(r.value)
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
   *  nearby time (that's what froze the picture). `jump` marks a real cut seam:
   *  land ON `t` (discard anything decoded before it, drop the queue if a warm
   *  swap didn't already put us there) instead of sequentially draining across
   *  the removed span — that catch-up is the "fast-forward through the cut". */
  follow(t: number, jump = false): void {
    // Promote decoded frames up to `t` FIRST (mirrors requestStill): a warm pipe
    // just handed ownership has its landing frame in the queue, not in `cur` —
    // draining before the restart test lets it draw instantly instead of
    // cold-restarting (the frozen frame on a big cut).
    const drain = (): boolean => {
      let moved = false
      while (this.queue.length && this.queue[0].timestamp <= t + 1e-4) {
        this.cur?.close()
        this.cur = this.queue.shift() as VideoSample
        moved = true
      }
      return moved
    }
    // A cut: land ON the in-point. Restart UNLESS the front decoded frame is
    // already essentially at `t` — i.e. the warm pipe was pre-parked here and we
    // can just draw it. Judging by the coverage window (frameScore) is wrong for
    // a seam: the outgoing live pipe's look-ahead can reach into the removed span
    // and "cover" t, and draining that is exactly the fast-forward. Front-frame
    // distance is what tells a ready warm swap from a live pipe mid-removed-span.
    const front = this.cur ?? (this.queue.length ? this.queue[0] : null)
    if (jump && this.pendingStart === null && (!front || Math.abs(front.timestamp - t) > 0.05)) {
      this.restart(t)
    } else if (this.pendingStart !== null) {
      if (Math.abs(t - this.pendingStart) > 2.5) this.restart(t)
    } else if (!this.iter) {
      this.restart(t) // first play after a paused still: begin decoding
    } else if (this.score(t) > 1.5) {
      this.restart(t) // jumped beyond coverage (scrub-then-play, big skip)
    }
    const moved = drain()
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
    this.restart(t)
  }

  /** Paused/scrub: use the SAME sequential iterator playback will consume.
   *  The previous sparse getSample() path created a second decoder; when Play
   *  arrived before it finished, its late still could overwrite streamed frames
   *  and the two decoders contended for hardware. Keeping one iterator means the
   *  paused frame also leaves a ready-made playback runway in `queue`. */
  requestStill(t: number): void {
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
  /** ONE Input per pipe — independent demuxer + decoder each. Sharing a single
   *  Input's track between both pipes serialized their decoding (both pull
   *  packets from the same reader), so the warm pipe could NOT decode the next
   *  in-point while the live pipe was streaming — it only caught up after the
   *  seam, i.e. the frozen frame at every cut. Two Inputs = two real decoders,
   *  the decoder twin of the element path's two <video> elements. */
  inputs: Input[] | null
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
        sp.inputs?.forEach((i) => i.dispose())
        this.sources.delete(src)
      }
    }
    for (const src of want) if (!this.sources.has(src)) this.open(src)
  }

  private open(src: string): void {
    const sp: SourcePipes = { inputs: null, pipes: null, owner: 0, ready: false, dead: false }
    this.sources.set(src, sp)
    void (async () => {
      try {
        const mb = await loadMb()
        const onErr = (e: unknown): void => {
          sp.dead = true
          this.fail(e)
        }
        // One INDEPENDENT Input+decoder per pipe so the warm pipe can decode the
        // next in-point WHILE the live pipe streams (no shared-reader contention).
        const mkPipe = async (): Promise<{ input: Input; pipe: Pipe }> => {
          const input = new mb.Input({ source: await inputSourceFor(mb, src), formats: mb.ALL_FORMATS })
          const track: InputVideoTrack | null = await input.getPrimaryVideoTrack()
          if (!track || !(await track.canDecode())) throw new Error('undecodable video track: ' + src)
          return { input, pipe: new Pipe(new mb.VideoSampleSink(track), onErr) }
        }
        const [p0, p1] = await Promise.all([mkPipe(), mkPipe()])
        sp.inputs = [p0.input, p1.input]
        sp.pipes = [p0.pipe, p1.pipe]
        sp.ready = true
        console.info('[wc-preview] source ready (dual decoder):', src.slice(-24))
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
  render(ctx: CanvasRenderingContext2D, cw: number, ch: number, src: string, tSrc: number, playing: boolean, seam = false): boolean {
    const sp = this.sources.get(src)
    if (!sp?.ready || !sp.pipes || sp.dead) return false
    const [a, b] = sp.pipes
    // Owner = the pipe that best covers tSrc. At a cut seam the warm pipe parked
    // on the in-point wins (its queue covers tSrc); the outgoing live pipe does
    // NOT (its decoded frames end at the previous out-point), so the swap is
    // decisive instead of the live pipe fast-forwarding through the removed span.
    sp.owner = a.score(tSrc) <= b.score(tSrc) ? 0 : 1
    const own = sp.pipes[sp.owner]
    const other = sp.pipes[sp.owner ^ 1]
    if (playing) own.follow(tSrc, seam)
    else own.requestStill(tSrc)
    let s: VideoSample | null = null
    if (own.cur && own.frameScore(tSrc) <= COVER_SLACK) s = own.cur
    else {
      const c1 = own.cur
      const c2 = other.cur
      s = !c1 ? c2 : !c2 ? c1 : Math.abs(c1.timestamp - tSrc) <= Math.abs(c2.timestamp - tSrc) ? c1 : c2
    }
    if (!s) return false
    const r = containRect(cw, ch, s.displayWidth / s.displayHeight)
    try {
      // Clear only once a replacement frame is ready. Clearing in the caller
      // before render() knew that left a black canvas during every cold decode.
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, cw, ch)
      s.draw(ctx, r.left, r.top, r.width, r.height)
    } catch {
      return false
    }
    return true
  }

  dispose(): void {
    for (const [, sp] of this.sources) {
      sp.pipes?.forEach((p) => p.dispose())
      sp.inputs?.forEach((i) => i.dispose())
    }
    this.sources.clear()
  }
}
