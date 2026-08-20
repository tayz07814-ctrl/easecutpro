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

import { getFile, isWebMediaId, mp4AudioStartOffset, padLeadingSilence } from './webmedia'
import { IS_WEB, mediaSrc } from './platform'

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
const CROSSFADE_RAMP = 0.01 // 10ms crossfade between adjacent sources at seams

/**
 * Build an AudioBuffer straight from a PCM WAV we produced ourselves (the
 * desktop preview path — see main/framestream.ts extractPreviewAudioWav).
 *
 * Deliberately NOT decodeAudioData: that always resamples to the context rate,
 * so a deliberately low-rate preview WAV would balloon straight back to
 * 48 kHz float in RAM and the whole saving would vanish. createBuffer keeps the
 * file's own rate — AudioBufferSourceNode resamples during playback instead —
 * which is what makes a long source affordable. It also skips the decode
 * entirely (a typed-array copy instead), so first play is quicker.
 *
 * Returns null for anything that isn't 16-bit PCM; the caller then falls back
 * to decodeAudioData, so an unexpected format still plays.
 */
function wavToAudioBuffer(ctx: AudioContext, bytes: ArrayBuffer): AudioBuffer | null {
  try {
    const dv = new DataView(bytes)
    const tag = (o: number): string =>
      String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3))
    if (bytes.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
    let off = 12
    let channels = 0
    let rate = 0
    let bits = 0
    let format = 0
    let dataOff = -1
    let dataLen = 0
    // Walk the chunks — ffmpeg writes a LIST/INFO chunk before `data`, so the
    // canonical 44-byte header offset would land mid-metadata.
    while (off + 8 <= bytes.byteLength) {
      const id = tag(off)
      const size = dv.getUint32(off + 4, true)
      if (id === 'fmt ') {
        format = dv.getUint16(off + 8, true)
        channels = dv.getUint16(off + 10, true)
        rate = dv.getUint32(off + 12, true)
        bits = dv.getUint16(off + 22, true)
      } else if (id === 'data') {
        dataOff = off + 8
        dataLen = Math.min(size, bytes.byteLength - dataOff)
      }
      off += 8 + size + (size & 1) // chunks are word-aligned
    }
    if (format !== 1 || bits !== 16 || !channels || !rate || dataOff < 0) return null
    const frames = Math.floor(dataLen / 2 / channels)
    if (frames < 1) return null
    // Int16Array needs 2-byte alignment; copy the rare odd-offset case.
    const pcm =
      dataOff % 2 === 0
        ? new Int16Array(bytes, dataOff, frames * channels)
        : new Int16Array(bytes.slice(dataOff, dataOff + frames * channels * 2))
    const buf = ctx.createBuffer(channels, frames, rate)
    for (let c = 0; c < channels; c++) {
      const ch = buf.getChannelData(c)
      for (let i = 0; i < frames; i++) {
        const s = pcm[i * channels + c]
        ch[i] = s < 0 ? s / 0x8000 : s / 0x7fff
      }
    }
    return buf
  } catch {
    return null // malformed — caller falls back to decodeAudioData
  }
}

type AC = typeof AudioContext

export class SeamlessAudio {
  private ctx: AudioContext | null = null
  private buffers = new Map<string, AudioBuffer>()
  private decoding = new Map<string, Promise<void>>()
  private failed = new Set<string>()
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
    this.failed.delete(src)
    const p = (async () => {
      const ctx = this.ensureCtx()
      // DESKTOP: the bundled ffmpeg extracts the source's full audio to a mono
      // PCM WAV (cached in the main process). `first_pts=0` bakes the phone
      // .mov `elst` delay into the file itself, so the elst re-pad below is not
      // needed on this path, and the browser never decodes AAC. We build the
      // AudioBuffer from the PCM ourselves to keep the file's sample rate (see
      // wavToAudioBuffer) — that is what bounds memory on long sources. Any
      // failure (e.g. a video with no audio stream) falls through to the
      // browser path, whose own failure sets `failed` and keeps element audio.
      if (!IS_WEB && !isWebMediaId(src)) {
        const api = (window as { api?: { previewAudioWav?: (p: string) => Promise<string> } }).api
        if (api?.previewAudioWav) {
          try {
            const wavPath = await api.previewAudioWav(src)
            const wav = await (await fetch(mediaSrc(wavPath))).arrayBuffer()
            const direct = wavToAudioBuffer(ctx, wav)
            // decodeAudioData detaches `wav`, so only reach for it as a fallback.
            this.buffers.set(src, direct ?? (await ctx.decodeAudioData(wav)))
            return
          } catch {
            /* fall through to the browser decode below */
          }
        }
      }
      // Browser-local media is identified by a stable webmedia id while its
      // blob URL may be replaced/revoked after a timeline edit. Read the
      // registered File directly, just like the WebCodecs video path does.
      const file = isWebMediaId(src) ? getFile(src) : undefined
      const bytes = file ? await file.arrayBuffer() : await (await fetch(url)).arrayBuffer()
      // Recover the container's audio start offset BEFORE decoding — parse first,
      // because decodeAudioData both strips the offset AND detaches `bytes`.
      //
      // Phone .mov files delay their audio track with an `elst` empty edit; the
      // <video> element honours it, decodeAudioData throws it away. This engine
      // MUTES the element and drives the sound itself, so without re-padding, its
      // audio runs early by that offset — the .mov lip-sync drift. Every other
      // audio path already does this (webmedia.localWaveform / extractAudioWavBlob,
      // localExport.renderAudio, ffmpeg's first_pts=0); this one was missed.
      const leadSec = mp4AudioStartOffset(bytes)
      let buf = await ctx.decodeAudioData(bytes)
      if (leadSec > 0.001) buf = padLeadingSilence(ctx, buf, leadSec)
      this.buffers.set(src, buf)
    })()
      .catch(() => {
        this.failed.add(src)
        /* leave unloaded → fallback to element audio */
      })
      .finally(() => this.decoding.delete(src))
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

  /** A current audible source finished loading but could not be decoded. */
  failedForCurrentSegments(): boolean {
    return this.segs.some((s) => !s.muted && this.failed.has(s.src))
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
    const schedule = planSchedule(this.segs, t0)
    // Apply crossfades between adjacent sources at seams
    for (let i = 0; i < schedule.length; i++) {
      const p = schedule[i]
      const prev = i > 0 ? schedule[i - 1] : null
      const next = i + 1 < schedule.length ? schedule[i + 1] : null
      const buf = this.buffers.get(p.src)
      if (!buf) continue
      const when = anchor + p.when
      const g = ctx.createGain()
      // Base click-guard ramps at source edges
      const outEnd = when + p.outDur
      const rampInEnd = Math.min(when + EDGE_RAMP, outEnd)
      const rampOutStart = Math.max(rampInEnd, outEnd - EDGE_RAMP)
      // If adjacent to another source in OUTPUT time, apply crossfade
      // Crossfade window: 10ms overlap centered on the seam
      const hasPrev = prev && Math.abs((anchor + prev.when + prev.outDur) - when) < 0.001
      const hasNext = next && Math.abs((anchor + next.when) - outEnd) < 0.001
      if (hasPrev) {
        // Overlap with previous source: start this source's gain ramp EARLIER
        // and let previous source's ramp extend into this one
        g.gain.setValueAtTime(0, when - CROSSFADE_RAMP)
        g.gain.linearRampToValueAtTime(p.gain, when)
      } else {
        g.gain.setValueAtTime(0, when)
        g.gain.linearRampToValueAtTime(p.gain, rampInEnd)
      }
      if (hasNext) {
        // Extend this source's gain ramp to overlap with next source
        g.gain.setValueAtTime(p.gain, outEnd)
        g.gain.linearRampToValueAtTime(0, outEnd + CROSSFADE_RAMP)
      } else {
        g.gain.setValueAtTime(p.gain, rampOutStart)
        g.gain.linearRampToValueAtTime(0, outEnd)
      }
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
