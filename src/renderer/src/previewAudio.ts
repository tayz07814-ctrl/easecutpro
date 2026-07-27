// Seamless preview audio (0.01). Plays the EDITED main-lane audio as ONE gapless,
// sample-accurate Web Audio stream so cut seams have NO click and NO decoder gap —
// unlike a <video> element, which must SEEK at every cut (100-800ms + a decode
// stall) and, on heavily-cut clips where seams fall closer than the decode-ahead
// buddy can pre-warm, cold-seeks every seam. The video elements stay for PICTURE
// only (muted) while this drives the sound.
//
// Robustness: if a source can't be decoded, the engine reports NOT ready and the
// caller keeps the old element-audio path — audio can never go silent from a
// decode failure. Every AudioBufferSource is scheduled ahead on the AudioContext
// clock, so seam transitions are sample-adjacent in OUTPUT time (gapless); a 6ms
// gain ramp at each scheduled edge guards the splice click from a non-zero sample.

/** A main-lane segment as the audio engine needs it (subset of the preview Seg). */
export interface AudioSeg {
  src: string
  url: string
  sourceStart: number
  sourceEnd: number
  start: number // timeline seconds
  len: number // timeline seconds
  gain?: number
  speed: number
  muted?: boolean
}

/** One scheduled buffer playback (pure plan; no Web Audio objects). */
export interface ScheduledSource {
  src: string
  when: number // seconds from the schedule anchor (ctx.currentTime + lead)
  offset: number // source in-point (seconds)
  duration: number // source seconds to play (already speed-scaled)
  gain: number
  playbackRate: number
  outDur: number // OUTPUT seconds this source occupies (for the gain-ramp envelope)
}

/**
 * PURE scheduler — map the edited segments to buffer-source plays starting at
 * timeline position `t0`. Extracted so the timing math is unit-testable without a
 * browser. `when` is relative to the schedule anchor; the engine adds
 * ctx.currentTime + lead.
 */
export function planSchedule(segs: AudioSeg[], t0: number): ScheduledSource[] {
  const out: ScheduledSource[] = []
  for (const seg of segs) {
    if (seg.muted) continue
    const segEnd = seg.start + seg.len
    if (segEnd <= t0 + 1e-4) continue // already fully behind the playhead
    const outWhen = Math.max(seg.start, t0) // timeline time this source begins
    const outDur = segEnd - outWhen // OUTPUT seconds it plays
    if (outDur <= 1e-4) continue
    const into = outWhen - seg.start // how far into the segment we begin
    const speed = seg.speed > 0 ? seg.speed : 1
    out.push({
      src: seg.src,
      when: outWhen - t0,
      offset: Math.max(0, seg.sourceStart + into * speed),
      duration: outDur * speed,
      gain: Math.max(0, seg.gain ?? 1),
      playbackRate: speed,
      outDur
    })
  }
  return out
}

const LEAD_S = 0.04 // tiny scheduling lead so the first start isn't in the past
const EDGE_RAMP = 0.006 // 6ms click-guard ramp at each scheduled source edge

type AC = typeof AudioContext

export class SeamlessAudio {
  private ctx: AudioContext | null = null
  private buffers = new Map<string, AudioBuffer>()
  private decoding = new Map<string, Promise<void>>()
  private nodes: AudioBufferSourceNode[] = []
  private segs: AudioSeg[] = []
  private startCtx = 0
  private startTl = 0
  private playing = false

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      const Ctor: AC = window.AudioContext || (window as unknown as { webkitAudioContext: AC }).webkitAudioContext
      this.ctx = new Ctor()
    }
    return this.ctx
  }

  /** Decode a source's audio once (idempotent). No-throw: a failure just leaves it
   *  unloaded so `ready()` returns false and the caller keeps element audio. */
  load(src: string, url: string): void {
    if (this.buffers.has(src) || this.decoding.has(src)) return
    const p = (async () => {
      const ctx = this.ensureCtx()
      const bytes = await (await fetch(url)).arrayBuffer()
      const buf = await ctx.decodeAudioData(bytes)
      this.buffers.set(src, buf)
    })().catch(() => {
      /* leave unloaded → fallback to element audio */
    })
    this.decoding.set(src, p)
  }

  setSegments(segs: AudioSeg[]): void {
    this.segs = segs
    for (const s of segs) if (!s.muted) this.load(s.src, s.url)
  }

  /** Every audible segment's source is decoded → safe to drive the audio. */
  ready(): boolean {
    return this.segs.length > 0 && this.segs.every((s) => s.muted || this.buffers.has(s.src))
  }

  private clearNodes(): void {
    for (const n of this.nodes) {
      try {
        n.onended = null
        n.stop()
      } catch {
        /* already stopped */
      }
      try {
        n.disconnect()
      } catch {
        /* already disconnected */
      }
    }
    this.nodes = []
  }

  private schedule(t0: number): void {
    const ctx = this.ensureCtx()
    this.clearNodes()
    const anchor = ctx.currentTime + LEAD_S
    this.startCtx = anchor
    this.startTl = t0
    for (const p of planSchedule(this.segs, t0)) {
      const buf = this.buffers.get(p.src)
      if (!buf) continue
      const when = anchor + p.when
      const g = ctx.createGain()
      // Click-guard: 0→gain over 6ms at the source edge, gain→0 over 6ms at its end.
      const outEnd = when + p.outDur
      const rampInEnd = Math.min(when + EDGE_RAMP, outEnd)
      const rampOutStart = Math.max(rampInEnd, outEnd - EDGE_RAMP)
      g.gain.setValueAtTime(0, when)
      g.gain.linearRampToValueAtTime(p.gain, rampInEnd)
      g.gain.setValueAtTime(p.gain, rampOutStart)
      g.gain.linearRampToValueAtTime(0, outEnd)
      const node = ctx.createBufferSource()
      node.buffer = buf
      node.playbackRate.value = p.playbackRate
      node.connect(g).connect(ctx.destination)
      try {
        node.start(when, p.offset, p.duration)
        this.nodes.push(node)
      } catch {
        /* clamped/invalid range — skip this one */
      }
    }
  }

  /** Start (or restart) playback from timeline position `t0`. */
  play(t0: number): void {
    const ctx = this.ensureCtx()
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
    this.playing = true
    this.schedule(t0)
  }

  pause(): void {
    this.playing = false
    this.clearNodes()
  }

  /** Re-anchor to a new timeline position (scrub) while playing. */
  seek(t0: number): void {
    if (this.playing) this.schedule(t0)
  }

  /** Where the audio clock currently is on the timeline (for scrub detection). */
  expected(): number {
    if (!this.playing || !this.ctx) return this.startTl
    return this.startTl + (this.ctx.currentTime - this.startCtx)
  }

  isPlaying(): boolean {
    return this.playing
  }

  /** TRUE only when the engine is actually producing sound (playing, sources
   *  decoded, and the AudioContext running). The preview mutes the <video>
   *  elements ONLY while this is true, so a decode failure or a suspended context
   *  can never leave the preview silent — element audio keeps playing. */
  active(): boolean {
    return this.playing && this.ready() && this.ctx?.state === 'running'
  }

  dispose(): void {
    this.clearNodes()
    if (this.ctx) {
      try {
        void this.ctx.close()
      } catch {
        /* already closed */
      }
      this.ctx = null
    }
  }
}
