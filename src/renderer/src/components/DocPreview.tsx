// Doc-native preview — plays the authoritative timeline document.
//
// REBUILT from scratch to kill the "black preview" class of bugs for good. The
// old player kept a hand-managed mount state machine (mountedSrc / loadedSrc /
// pendingSeek / settle refs) that had to be re-synced after every edit; undo,
// re-drops and lane moves kept finding new ways to wedge it.
//
// This player has NO sticky mount state:
//   * one <video> element PER UNIQUE SOURCE, kept alive for as long as the
//     source appears in the document (keyed by source path — moving clips
//     between lanes, undoing, re-dropping the same file can't unmount it);
//   * ONE reconciliation loop (rAF, always running) that every frame derives
//     "which element should be visible, at which source time, playing or
//     paused" purely from (document, playhead, playing) and nudges the DOM to
//     match. There is nothing to re-sync because nothing is remembered beyond
//     per-element seek-in-flight bookkeeping with an 800 ms watchdog.
//
// Behaviour kept from the old engine (hard-won, do not lose):
//   * gaps (magnet-off dead space) traverse as BLACK in real time;
//   * micro-gaps <0.12 s inside the same file play through (seeking stutters
//     more than the gap itself);
//   * per-clip mute (detached audio), gain, speed, and the Ken Burns transform
//     (ovScale/ovZoomStart..End with ovX/ovY focal point) on the base video;
//   * the shared playClock is driven at 60 fps (timeline playhead + overlay
//     ramps read it), the store playhead is written throttled + forward-only;
//   * ▶ at the very end restarts from the first clip;
//   * a source that errors is skipped instead of wedging playback;
//   * audio-lane clips play via <DocAudio>; overlays + texts composite on top.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { playClock, primePlayback } from '../clock'
import { kenBurnsOrigin, kenBurnsTransform, cropToKenBurns } from '../kenBurns'
import { SeamlessAudio } from '../previewAudio'
import { useSharedEngineSnapshot } from '../timelineEngine'
import { framesToSeconds } from '@shared/timeline/time'
import { mainTrackId } from '@shared/timeline/model'
import type { TimelineDocument, Clip as DocClip } from '@shared/timeline/types'
import { resolveMedia, MISSING_MEDIA_MESSAGE } from '../media/resolver'
import { useIsMobile } from '../useMobile'
import { useNativePreview } from '../useNativePreview'
import OverlayLayer from './OverlayLayer'
import TextLayer from './TextLayer'

function fmt(t: number): string {
  if (!isFinite(t)) t = 0
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}
// Warm the NEXT source's decoder this many seconds before a clip/cut seam so
// crossing it doesn't stall on a cold seek (the "slider sticks + video pauses at
// the seam" bug — a seek issued AT the boundary freezes the clock while it lands).
// Warm the next seam this many seconds ahead. MUST stay small: on a heavily-cut
// video the kept segments are shorter than the lead, so a large value makes the
// decode-ahead buddy re-seek on essentially EVERY segment — on mobile that starves
// the hardware decoder and WEDGES the picture (frozen frame while the clock keeps
// advancing). 1.2 caused exactly that; 0.6 is the known-good value (buddy warms
// once, just before the seam). Do NOT raise this to chase seam flicker — that
// needs a smarter, device-profiled approach, not a bigger lead.
const PREWARM_LEAD_S = 0.6
function containRect(w: number, h: number, aspect: number): { left: number; top: number; width: number; height: number } {
  if (w <= 0 || h <= 0) return { left: 0, top: 0, width: 0, height: 0 }
  if (w / h > aspect) {
    const width = h * aspect
    return { left: (w - width) / 2, top: 0, width, height: h }
  }
  const height = w / aspect
  return { left: 0, top: (h - height) / 2, width: w, height }
}

interface Seg {
  src: string
  url: string
  sourceStart: number
  sourceEnd: number
  /** REAL timeline start (seconds) — the playhead's domain in doc mode. */
  start: number
  len: number
  srcW?: number
  srcH?: number
  muted?: boolean
  ovScale?: number
  ovZoomStart?: number
  ovZoomEnd?: number
  ovX?: number
  ovY?: number
  gain?: number
  speed: number
}

// Anti-click seam MICRO-CROSSFADE for the LIVE preview. A cut splices two non-
// contiguous source points, so the waveform jumps → an audible click/pop at the
// seam (worse because the buddy swap mutes the outgoing element instantly). Ramp
// the outgoing tail DOWN over the last ~18ms before the cut AND the incoming UP
// over ~25ms after it — an equal-power-ish fade centred on the seam. BOTH ramps
// sit on KEPT content (never the removed span), so no cut audio is replayed and
// only a sub-frame sliver of the word edges is touched — inaudible, unlike the
// click it removes. Seamless same-source joins (splits) are untouched. 0..1 gain.
const SEAM_FADE_S = 0.025 // incoming fade-in (post-cut)
const SEAM_FADE_OUT_S = 0.018 // outgoing fade-out (pre-cut tail) — shorter so it barely grazes the last word
function seamContiguous(a: Seg, b: Seg): boolean {
  return a.src === b.src && Math.abs(a.sourceEnd - b.sourceStart) < 0.003
}
function seamGain(t: number, di: number, ss: Seg[], fade = SEAM_FADE_S): number {
  const seg = ss[di]
  if (!seg) return 1
  let g = 1
  const ramp = (x: number, span: number): number => Math.max(0, Math.sin((Math.max(0, x) / span) * (Math.PI / 2)))
  // Fade IN at the start of a post-cut segment.
  const prev = ss[di - 1]
  if (prev && !seamContiguous(prev, seg)) {
    const d = t - seg.start // since this segment's (cut) start
    if (d < fade) g = Math.min(g, ramp(d, fade))
  }
  // Fade OUT the tail just before a real cut (kept content, so no words are lost —
  // only the click is). Skipped for a seamless same-source join.
  const next = ss[di + 1]
  if (next && !seamContiguous(seg, next)) {
    const dEnd = seg.start + seg.len - t // until this segment's (cut) end
    if (dEnd < SEAM_FADE_OUT_S) g = Math.min(g, ramp(dEnd, SEAM_FADE_OUT_S))
  }
  return g
}

/** Main-lane clips -> playable segments, sorted by timeline position. Pure. */
function docSegments(doc: TimelineDocument): { segs: Seg[]; missing: number } {
  const mainId = mainTrackId(doc)
  const main = mainId ? doc.tracks.find((t) => t.id === mainId) : undefined
  const segs: Seg[] = []
  let missing = 0
  for (const c of [...(main?.clips ?? [])].sort((a, b) => a.start - b.start)) {
    if (!c.sourcePath) continue
    const r = resolveMedia(c.sourcePath)
    if (r.missing || !r.url) {
      missing++
      continue
    }
    const speed = typeof c.speed === 'number' && c.speed > 0 ? c.speed : 1
    // Base-clip crop → equivalent cover-zoom + focal pan, folded into the Ken Burns
    // scale/focal the renderer already applies (so the base video actually crops).
    const cb = cropToKenBurns(c.crop)
    segs.push({
      src: c.sourcePath,
      url: r.url,
      sourceStart: c.sourceIn,
      sourceEnd: c.sourceOut,
      start: framesToSeconds(c.start, doc.timebase),
      len: Math.max(0.02, framesToSeconds(c.duration, doc.timebase)),
      srcW: c.srcW,
      srcH: c.srcH,
      muted: c.audioDetached === true || c.muted === true,
      ovScale: (typeof c.metadata?.ovScale === 'number' ? c.metadata.ovScale : 1) * cb.scale,
      ovZoomStart: typeof c.metadata?.ovZoomStart === 'number' ? c.metadata.ovZoomStart : 1,
      ovZoomEnd: typeof c.metadata?.ovZoomEnd === 'number' ? c.metadata.ovZoomEnd : 1,
      ovX: (typeof c.metadata?.ovX === 'number' ? c.metadata.ovX : 0) + cb.ovX,
      ovY: (typeof c.metadata?.ovY === 'number' ? c.metadata.ovY : 0) + cb.ovY,
      gain: typeof c.gain === 'number' ? c.gain : 1,
      speed
    })
  }
  return { segs, missing }
}

/** Audio-lane clips (music / detached voice) played in sync with the playhead. */
function DocAudio({ doc, playing, playhead }: { doc: TimelineDocument; playing: boolean; playhead: number }): JSX.Element {
  const clips: DocClip[] = []
  for (const t of doc.tracks) {
    if (t.kind !== 'audio' || t.muted || t.hidden) continue
    for (const c of t.clips) if (c.sourcePath) clips.push(c)
  }
  return (
    <>
      {clips.map((c) => (
        <DocAudioClip key={c.id} clip={c} tb={doc.timebase} playing={playing} playhead={playhead} />
      ))}
    </>
  )
}

function DocAudioClip({
  clip,
  tb,
  playing,
  playhead
}: {
  clip: DocClip
  tb: TimelineDocument['timebase']
  playing: boolean
  playhead: number
}): JSX.Element {
  const ref = useRef<HTMLAudioElement>(null)
  const startSec = framesToSeconds(clip.start, tb)
  const endSec = framesToSeconds(clip.end, tb)
  useEffect(() => {
    const a = ref.current
    if (!a) return
    a.volume = clamp(clip.gain ?? 1, 0, 1)
    if (playing) {
      // Follow the 60fps play clock: the store playhead is throttled ~8Hz and
      // stalls over a main-lane gap, which left detached / music audio silent.
      let raf = 0
      const loop = (): void => {
        const tt = playClock.t
        if (tt < startSec || tt >= endSec) {
          if (!a.paused) a.pause()
        } else {
          const target = clip.sourceIn + (tt - startSec)
          if (Math.abs(a.currentTime - target) > 0.3) a.currentTime = target
          if (a.paused) a.play().catch(() => undefined)
        }
        raf = requestAnimationFrame(loop)
      }
      raf = requestAnimationFrame(loop)
      return () => cancelAnimationFrame(raf)
    }
    a.pause()
    if (playhead >= startSec && playhead < endSec) {
      const target = clip.sourceIn + (playhead - startSec)
      if (Math.abs(a.currentTime - target) > 0.05) a.currentTime = target
    }
    return undefined
  }, [playing, playhead, startSec, endSec, clip.sourceIn, clip.gain])
  return <audio ref={ref} src={resolveMedia(clip.sourcePath as string).url} preload="auto" />
}

/** Per-element seek in flight: don't re-issue every frame; watchdog re-derives. */
interface Pending {
  target: number
  since: number
}

export default function DocPreview({ doc }: { doc: TimelineDocument }): JSX.Element {
  const project = useStore((s) => s.project)
  // Phones effectively have ONE hardware video-decode pipeline (iOS Safari), so a
  // decode-ahead buddy can't truly decode ahead — it just contends for that single
  // decoder and its prewarm seeks stall the LIVE picture (the frozen-frame bug).
  // On mobile we run the plain single-decoder path (no buddy); same-source seams
  // cold-seek the one element (a brief stall) instead of wedging.
  const isMobile = useIsMobile()
  const playing = useStore((s) => s.playing)
  const setPlaying = useStore((s) => s.setPlaying)
  const playhead = useStore((s) => s.project.playhead)
  const setPlayhead = useStore((s) => s.setPlayhead)
  const setAspect = useStore((s) => s.setAspect)

  const stageRef = useRef<HTMLDivElement>(null)
  // Native ExoPlayer preview (Android): when active it owns the picture + clock and
  // the HTML base <video>s are hidden. `frameRef` positions the native surface under
  // the preview frame. Both are inert on web/desktop (useNativePreview no-ops there).
  const frameRef = useRef<HTMLDivElement>(null)
  const nativeActiveRef = useRef(false)
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setStageSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setStageSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const { segs, missing } = docSegments(doc)
  const sources = useMemo(() => [...new Set(segs.map((s) => s.src))], [segs.map((s) => s.src).join('|')])
  const urlOf = new Map(segs.map((s) => [s.src, s.url]))
  const total = segs.length ? segs[segs.length - 1].start + segs[segs.length - 1].len : 0

  // Android native player: takes over PLAYBACK of a plain cut (natively-imported base
  // video, no speed/mute/gain/KenBurns/crop/gaps) for CapCut-smooth playback with the
  // HTML captions composited on top. No-op on web/desktop or any ineligible timeline;
  // on any failure it disables itself and the HTML player below runs unchanged.
  useNativePreview({
    segs,
    frameRef,
    playing,
    playhead,
    totalSec: total,
    setPlaying,
    setPlayhead,
    nativeActiveRef
  })
  // Sources with at least one SAME-SOURCE cut seam (adjacent same-source clips
  // joined gaplessly with a real source jump) get a decode-ahead buddy; montages of
  // distinct one-shot clips have none and pay nothing extra.
  const buddySig = segs.map((s) => `${s.src}:${s.sourceStart}:${s.sourceEnd}:${s.start}`).join('|')
  const buddySrcs = useMemo(() => {
    // Mobile: no buddy at all (single-decoder path) — see isMobile note above.
    if (isMobile) return new Set<string>()
    const count = new Map<string, number>()
    for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1]
      const b = segs[i]
      if (a.src !== b.src) continue
      const jump = b.sourceStart - a.sourceEnd
      const micro = jump >= 0 && jump <= 0.12
      const contiguous = b.start - (a.start + a.len) <= 0.08
      if (!micro && contiguous) count.set(b.src, (count.get(b.src) ?? 0) + 1)
    }
    // Cap to the SINGLE most-cut source: one decode-ahead buddy (+1 decoder) makes
    // the common single-source retake seamless without risking mobile hardware
    // decoder limits on multi-source montages (every other source keeps the plain
    // one-decoder path, which the reconciler falls back to automatically).
    let best = ''
    let bestN = 0
    for (const [src, n] of count) if (n > bestN) [best, bestN] = [src, n]
    return best ? new Set([best]) : new Set<string>()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buddySig, isMobile])

  // ---- refs the reconciler reads (fresh every render) ----
  const segsRef = useRef(segs)
  segsRef.current = segs
  const totalRef = useRef(total)
  totalRef.current = total
  const playingRef = useRef(playing)
  playingRef.current = playing

  // Seamless decoupled AUDIO (0.01): play the EDITED main-lane audio as one gapless
  // Web Audio stream so cut seams have no click / decoder-gap. Videos become
  // picture-only (muted) ONLY while the engine is truly running — a decode failure
  // or suspended context falls back to element audio, so sound is never lost.
  const audioEngineRef = useRef<SeamlessAudio | null>(null)
  if (!audioEngineRef.current) audioEngineRef.current = new SeamlessAudio()

  // Element pool: each source gets one or — for a CUT source that has a same-source
  // seam — TWO <video> slots: a live one and a "buddy" kept decoded ONE seam ahead
  // so crossing a same-source cut is a hot SWAP, not a cold seek (which froze the
  // picture). React owns both slots by stable key; we only flip which slot is LIVE,
  // so the callback refs never fight the swap. liveVideo()/warmVideo() read through
  // the live index.
  const slotsRef = useRef(new Map<string, (HTMLVideoElement | null)[]>())
  const liveSlotRef = useRef(new Map<string, number>())
  // Per-ELEMENT seek-in-flight (two elements can share a src, so a src key would
  // collide); a WeakMap drops entries automatically when React unmounts an element.
  const pendingRef = useRef(new WeakMap<HTMLVideoElement, Pending>())
  const badRef = useRef(new Set<string>()) // sources that fired 'error'
  // Tracks the ACTIVE element's currentTime + the wall time it last CHANGED, so the
  // reconciler can tell a LIVE decoder (new frames arriving) from a stalled/seeking one
  // and keep the playhead advancing on the wall clock instead of freezing on a stall.
  const ctTrackRef = useRef<{ src: string; ct: number; wall: number }>({ src: '', ct: -1, wall: 0 })

  // DESKTOP: composite the base picture into a <canvas> instead of revealing/hiding
  // the <video> elements. drawImage samples the LIVE decoder's CURRENT frame every
  // rAF, so there is no element "reveal" — the compositor stale-frame flash at a cut
  // seam (and the paused-buddy 1-frame hold) are impossible by construction, and the
  // buddy can be PRE-ROLLED (already playing) for a hold-free swap. The zoom is the
  // SAME kenBurns CSS transform, applied to the canvas (identical box) so it is
  // pixel-equivalent to the element path. Mobile keeps the single-decoder element
  // path (iOS video→canvas is finicky and it has no buddy anyway).
  const useCanvas = !isMobile
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dpr = Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)
  // Edge-detects play→pause so we can ADOPT the picture's real position into the
  // playhead on pause (the decoder is allowed to drift up to ~0.34s from the clock
  // while playing; snapping it to the clock on pause jumped the frame — a visible
  // "flicker on pause"). Adopting keeps the picture perfectly still when pausing.
  const wasPlayingRef = useRef(playing)

  // Local continuous time `t` — what the viewer shows. Store playhead is
  // written FROM it (throttled) while playing; adopted INTO it when it changes
  // externally (scrub) or while paused.
  const tRef = useRef(playhead)
  const lastWroteRef = useRef(playhead)
  const lastStoreWriteAt = useRef(0)

  // External playhead changes (scrub / word click / transcript double-click).
  useEffect(() => {
    if (Math.abs(playhead - lastWroteRef.current) > 0.0005) {
      tRef.current = playhead // adopt: the user moved the playhead
      audioEngineRef.current?.seek(playhead) // re-anchor the decoupled audio to the scrub
    }
  }, [playhead])

  // Feed the audio engine the current edited segments (decodes each new source
  // once); keyed on a content signature so it only re-runs on a real edit.
  const audioSig = segs
    .map((s) => `${s.src}:${s.sourceStart}:${s.sourceEnd}:${s.start}:${s.len}:${s.gain}:${s.speed}:${s.muted ? 1 : 0}`)
    .join('|')
  useEffect(() => {
    audioEngineRef.current?.setSegments(segs)
    // segs is rebuilt every render; audioSig captures its content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioSig])

  // Start/stop the decoupled audio with playback. On play it schedules the whole
  // edited timeline from the live playhead (gapless); on pause it stops. If sources
  // aren't decoded / the context won't start, active() stays false and the <video>
  // elements keep their own audio — sound is never lost.
  useEffect(() => {
    const eng = audioEngineRef.current
    if (!eng) return
    if (playing) eng.play(tRef.current)
    else eng.pause()
  }, [playing])

  // Tear down the AudioContext on unmount.
  useEffect(() => () => audioEngineRef.current?.dispose(), [])

  function segAtTime(t: number): number {
    return segsRef.current.findIndex((s) => t >= s.start && t < s.start + s.len)
  }
  /** Segment to DISPLAY at t: covering, else (at/past the end) the last one. */
  function displayIdxAt(t: number): number {
    const cov = segAtTime(t)
    if (cov >= 0) return cov
    const ss = segsRef.current
    if (!ss.length) return -1
    const last = ss[ss.length - 1]
    return t >= last.start + last.len - 1e-4 ? ss.length - 1 : -1
  }

  /** The LIVE <video> currently showing/decoding `src` (falls back to the other slot). */
  function liveVideo(src: string): HTMLVideoElement | undefined {
    const pair = slotsRef.current.get(src)
    if (!pair) return undefined
    const s = liveSlotRef.current.get(src) ?? 0
    return pair[s] ?? pair[s ^ 1] ?? undefined
  }
  /** The standby ("buddy") <video> for `src`, decoded one seam ahead (if any). */
  function warmVideo(src: string): HTMLVideoElement | undefined {
    const pair = slotsRef.current.get(src)
    if (!pair) return undefined
    const s = liveSlotRef.current.get(src) ?? 0
    return pair[s ^ 1] ?? undefined
  }
  /** Callback-ref sink: park each <video> in its STABLE [slot0, slot1] position. */
  function setSlot(src: string, slot: number, el: HTMLVideoElement | null): void {
    const pair = slotsRef.current.get(src) ?? [null, null]
    pair[slot] = el
    if (el) {
      slotsRef.current.set(src, pair)
    } else if (!pair[0] && !pair[1]) {
      slotsRef.current.delete(src)
      liveSlotRef.current.delete(src)
      badRef.current.delete(src)
    } else if ((liveSlotRef.current.get(src) ?? 0) === slot) {
      liveSlotRef.current.set(src, slot ^ 1) // the live slot unmounted → fall back
    }
  }

  /** Issue a seek on `v` toward `want`, once, with first-frame-decode nudges. */
  function seek(v: HTMLVideoElement, want: number): void {
    if (isFinite(v.duration) && v.duration > 0) want = Math.min(want, v.duration - 0.05)
    // A fresh element at 0 shows NO decoded frame and writing 0 again is a
    // no-op (no 'seeked' → black until scrub) — nudge a hair past 0.
    if (want <= 0.001) want = Math.min(0.033, Math.max(0.001, (v.duration || 1) - 0.05))
    const p = pendingRef.current.get(v)
    if (p && Math.abs(p.target - want) < 0.05) return // that seek is in flight
    if (Math.abs(v.currentTime - want) < 0.02) {
      // Same position: force a decode anyway (fresh element parked on its own
      // currentTime still needs a real seek to paint).
      v.currentTime = want > 0.05 ? want - 0.03 : want + 0.03
    }
    pendingRef.current.set(v, { target: want, since: performance.now() })
    v.currentTime = want
  }

  /** Has the in-flight seek (if any) on `v` landed? Watchdog clears stalls. */
  function settled(v: HTMLVideoElement): boolean {
    const p = pendingRef.current.get(v)
    if (!p) return true
    if (Math.abs(v.currentTime - p.target) <= 0.08 || v.currentTime >= p.target - 0.06) {
      pendingRef.current.delete(v)
      return true
    }
    if (performance.now() - p.since > 800) {
      pendingRef.current.delete(v) // decoder stall / clamped target: self-heal
      return true
    }
    return false
  }

  // ---- THE reconciler: one always-running rAF loop ----
  useEffect(() => {
    let raf = 0
    let lastWall = performance.now()
    const loop = (): void => {
      const now = performance.now()
      const dt = Math.min(0.1, (now - lastWall) / 1000)
      lastWall = now
      // Native player active: it owns the picture + drives playClock/playhead
      // (useNativePreview). Keep every HTML base element paused + hidden so there's
      // no double decode or a stale frame occluding the native surface, then bail.
      if (nativeActiveRef.current) {
        for (const [, pair] of slotsRef.current) {
          for (const v of pair) {
            if (!v) continue
            if (!v.muted) v.muted = true // native owns the audio — never let HTML double it
            if (!v.paused) v.pause()
            if (v.style.visibility !== 'hidden') v.style.visibility = 'hidden'
          }
        }
        const cv = canvasRef.current // native surface shows — keep the canvas out of the way
        if (cv && cv.style.visibility !== 'hidden') cv.style.visibility = 'hidden'
        raf = requestAnimationFrame(loop)
        return
      }
      const ss = segsRef.current
      const isPlaying = playingRef.current

      if (!ss.length) {
        playClock.t = tRef.current
        raf = requestAnimationFrame(loop)
        return
      }

      // ADOPT-ON-PAUSE: on the play→pause edge, snap the PLAYHEAD to where the
      // picture actually is (not the picture to the playhead). While playing, the
      // decoder is allowed to drift up to ~0.34s from the clock; the old paused
      // branch then seeked the element back to the clock — a visible frame jump
      // ("flicker when pausing"). Adopting the element's real position keeps the
      // frame perfectly still through a pause.
      const wasPlaying = wasPlayingRef.current
      wasPlayingRef.current = isPlaying
      if (wasPlaying && !isPlaying) {
        const di0 = displayIdxAt(tRef.current)
        if (di0 >= 0) {
          const seg = ss[di0]
          const v = liveVideo(seg.src)
          if (v && !badRef.current.has(seg.src) && settled(v)) {
            const elemT = seg.start + clamp((v.currentTime - seg.sourceStart) / seg.speed, 0, seg.len)
            if (isFinite(elemT)) {
              tRef.current = elemT
              lastWroteRef.current = elemT
              setPlayhead(elemT)
            }
          }
        }
      }

      let t = tRef.current
      const covIdx = segAtTime(t)
      const active = covIdx >= 0 ? ss[covIdx] : undefined

      if (isPlaying) {
        if (active && !badRef.current.has(active.src)) {
          const v = liveVideo(active.src)
          if (v) {
            if (v.paused) v.play().catch(() => undefined)
            // TIMELINE DRIVES, DECODER CHASES — kills "the red line / slider sticks at
            // every cut". At a SAME-SOURCE cut seam the one shared <video> must cold-seek
            // from the previous clip's out-point to this clip's in-point; on long-GOP
            // H.264 that seek takes 100-800 ms AND the decoder then STALLS briefly
            // delivering the first post-seek frames (currentTime sits still). The old
            // code derived `t` from the element whenever a seek was "settled", so that
            // stall PINNED the playhead — the red line froze at every cut. Fix: the
            // playhead is ALWAYS driven by the wall clock (forward only, clamped to the
            // clip) and is only *re-anchored* to the element while the decoder is provably
            // LIVE — its currentTime produced a NEW value within the last ~80 ms. A seek
            // or a decode stall (no new frame) can therefore never freeze the clock, while
            // healthy playback still locks A/V exactly. (~1 video-frame gaps between rAF
            // ticks stay under the 80 ms window, so normal 24-30 fps playback still locks.)
            const ctNow = v.currentTime
            const trk = ctTrackRef.current
            if (trk.src !== active.src || Math.abs(ctNow - trk.ct) > 1e-4) {
              trk.src = active.src
              trk.ct = ctNow
              trk.wall = now
            }
            const decoderLive = settled(v) && now - trk.wall < 80
            const elemT = active.start + clamp((ctNow - active.sourceStart) / active.speed, 0, active.len)
            let nt = Math.min(t + dt, active.start + active.len) // forward-only wall clock
            // Re-anchor to the decoder only when it is live AND within a tight window of
            // the wall clock — corrects drift without ever pulling the playhead backward
            // or letting a stalled/seeking element hold it still.
            if (decoderLive && elemT >= t - 1.5 / 30 && elemT <= nt + 1 / 30) nt = Math.max(nt, elemT)
            t = nt
            // Chase: pull the element toward the timeline with ONE seek per seam. It is
            // suppressed while a prior seek is still settling (settled() false) so the
            // decoder is never thrashed frame-by-frame (which stutters the picture); the
            // threshold is generous so a decoder catching up by playing isn't re-seeked.
            const want = active.sourceStart + (t - active.start) * active.speed
            if (settled(v) && Math.abs(v.currentTime - want) > 0.34) {
              seek(v, want)
            }
            // DECODE-AHEAD: warm the upcoming seam BEFORE reaching it so crossing it is
            // seamless. A DIFFERENT file → warm the next source's live element toward
            // its in-point. A SAME-SOURCE cut → warm THIS source's buddy element to the
            // next in-point so the seam becomes a hot swap instead of a cold seek that
            // freezes the picture. (Micro-joins need no seek and are skipped.)
            {
              const up = ss[covIdx + 1]
              if (up && !badRef.current.has(up.src) && t >= active.start + active.len - PREWARM_LEAD_S) {
                if (up.src !== active.src) {
                  const uv = liveVideo(up.src)
                  if (uv && settled(uv) && Math.abs(uv.currentTime - up.sourceStart) > 0.12) seek(uv, up.sourceStart)
                } else {
                  const jump = up.sourceStart - active.sourceEnd
                  const micro = jump >= 0 && jump <= 0.12
                  const wv = warmVideo(active.src)
                  if (!micro && wv && settled(wv) && Math.abs(wv.currentTime - up.sourceStart) > 0.06) {
                    seek(wv, up.sourceStart)
                  }
                  // CANVAS pre-roll: start the buddy MOVING a hair before the seam so
                  // the swap has it already advancing (kills the 1-frame hold). Only
                  // safe on the canvas path — the buddy is never DRAWN until it goes
                  // live, so the ~2 frames of pre-seam (removed) content it plays are
                  // invisible; on the element path a played-hidden buddy would flash a
                  // stale frame on reveal, so it stays paused there.
                  if (
                    useCanvas &&
                    !micro &&
                    wv &&
                    wv.paused &&
                    settled(wv) &&
                    Math.abs(wv.currentTime - up.sourceStart) < 0.2 &&
                    t >= active.start + active.len - 0.08
                  ) {
                    wv.play().catch(() => undefined)
                  }
                }
              }
            }
            // clip end -> next segment / gap / stop
            if (v.currentTime >= active.sourceEnd - 0.04 || t >= active.start + active.len - 0.005) {
              const ni = covIdx + 1
              const next = ss[ni]
              if (!next) {
                v.pause()
                playingRef.current = false
                setPlaying(false)
                t = totalRef.current
              } else {
                const gapStart = active.start + active.len
                if (next.start - gapStart > 0.08) {
                  t = Math.max(t, gapStart) + 0.001 // enter the gap; wall clock takes over
                  v.pause()
                } else {
                  t = next.start + 0.0005
                  const jump = next.sourceStart - active.sourceEnd
                  const microSameFile = next.src === active.src && jump >= 0 && jump <= 0.12
                  if (!microSameFile) {
                    if (next.src === active.src) {
                      // SAME-SOURCE cut: swap to the pre-warmed buddy (already decoded at
                      // next.sourceStart) so the picture is seamless — no cold seek. If the
                      // buddy isn't ready (clip too short to warm in time), fall back to
                      // cold-seeking the live element, exactly the old single-decoder path.
                      const wv = warmVideo(active.src)
                      const buddyReady = !!wv && settled(wv) && Math.abs(wv.currentTime - next.sourceStart) < 0.15
                      if (buddyReady && wv) {
                        const cur = liveSlotRef.current.get(active.src) ?? 0
                        liveSlotRef.current.set(active.src, cur ^ 1) // flip live ↔ buddy
                        if (wv.paused) wv.play().catch(() => undefined)
                        // Canvas path: the OLD live is now the buddy — pause it so it
                        // stops decoding past its out-point; prewarm re-seeks it to the
                        // NEXT seam. (Element path keeps its own visibility handling.)
                        if (useCanvas && !v.paused) v.pause()
                      } else {
                        // Buddy not ready → cold-seek the live element (old path). Pause
                        // any buddy we pre-rolled so it can't drift on into removed
                        // content; prewarm re-seeks it for the next seam.
                        if (useCanvas && wv && !wv.paused) wv.pause()
                        seek(v, next.sourceStart)
                      }
                    } else {
                      const nv = liveVideo(next.src)
                      // Already pre-warmed at the seam? just play it — a redundant
                      // re-seek would re-stall the freshly-decoded element.
                      const warm = !!nv && settled(nv) && Math.abs(nv.currentTime - next.sourceStart) < 0.15
                      if (nv && !warm) seek(nv, next.sourceStart)
                      if (nv && warm && nv.paused) nv.play().catch(() => undefined)
                    }
                  }
                }
              }
            }
          }
        } else {
          // gap (or bad source): traverse as black in real time
          t += dt
          const ni = ss.findIndex((s) => s.start > t - 0.0001)
          const nxt = segAtTime(t) >= 0 ? segAtTime(t) : -1
          if (nxt >= 0) {
            const seg = ss[nxt]
            const nv = liveVideo(seg.src)
            if (nv && !badRef.current.has(seg.src)) seek(nv, seg.sourceStart + (t - seg.start) * seg.speed)
          } else if (ni < 0 && t >= totalRef.current) {
            playingRef.current = false
            setPlaying(false)
            t = totalRef.current
          }
        }
        // store playhead: throttled ~8 Hz, forward-only (scrubs adopt separately)
        if (t > lastWroteRef.current + 0.0005 && now - lastStoreWriteAt.current > 120) {
          lastWroteRef.current = t
          lastStoreWriteAt.current = now
          setPlayhead(t)
        }
      } else {
        // PAUSED: park every element; the LIVE one of the shown source on the exact frame.
        const di = displayIdxAt(t)
        const showSrc = di >= 0 ? ss[di].src : null
        for (const [src, pair] of slotsRef.current) {
          const li = liveSlotRef.current.get(src) ?? 0
          for (let slot = 0; slot < pair.length; slot++) {
            const v = pair[slot]
            if (!v) continue
            if (!v.paused) v.pause()
            if (slot === li && src === showSrc && di >= 0 && !badRef.current.has(src)) {
              const seg = ss[di]
              const want = seg.sourceStart + clamp(t - seg.start, 0, seg.len) * seg.speed
              if (settled(v) && Math.abs(v.currentTime - want) > 0.03) seek(v, want)
            }
          }
        }
      }

      tRef.current = t
      playClock.t = t

      // Keep the decoupled audio locked to the video clock. The AudioContext resume
      // is async (first play) and clocks can drift over long runs, so if the audio
      // position diverges from the timeline by > ~0.25s, re-anchor it. The threshold
      // keeps this a rare correction, not a per-frame reschedule (which would blip).
      {
        const eng = audioEngineRef.current
        if (isPlaying && eng && eng.active() && Math.abs(eng.expected() - t) > 0.25) eng.seek(t)
      }

      // ---- DISPLAY + per-clip properties, every frame (cheap, idempotent) ----
      const di = displayIdxAt(t)
      const shown = di >= 0 ? ss[di] : undefined
      // Creator-configured seam blend ("overlap"): 0 = hard cuts. Read live so the
      // preview reflects the Silence Settings toggle/slider immediately.
      const sf = useStore.getState().seamFade
      const seamFadeS = sf.enabled ? sf.ms / 1000 : 0
      const kbTransform = (s: Seg): string =>
        kenBurnsTransform({
          size: s.ovScale ?? 1,
          zoomStart: s.ovZoomStart,
          zoomEnd: s.ovZoomEnd,
          progress: s.len > 0 ? (t - s.start) / s.len : 0
        })

      if (useCanvas) {
        // ── DESKTOP: composite the LIVE decoder's current frame into the <canvas>.
        // No element is ever shown/hidden, so the compositor stale-frame flash at a
        // seam is impossible; the pre-rolled buddy makes the swap hold-free too.
        const cv = canvasRef.current
        const liveEl = shown && !badRef.current.has(shown.src) ? liveVideo(shown.src) : undefined
        if (cv) {
          if (cv.style.visibility === 'hidden') cv.style.visibility = 'visible' // (native hid it)
          const ctx = cv.getContext('2d')
          if (ctx) {
            const cw = cv.width
            const ch = cv.height
            if (liveEl && liveEl.readyState >= 2 && liveEl.videoWidth > 0 && liveEl.videoHeight > 0 && shown) {
              // Reproduce `object-fit: contain` (the element path's CSS): letterbox the
              // source inside the canvas, then apply the SAME kenBurns transform to the
              // whole canvas — pixel-equivalent to transforming the <video> element.
              const cr = containRect(cw, ch, liveEl.videoWidth / liveEl.videoHeight)
              ctx.fillStyle = '#000'
              ctx.fillRect(0, 0, cw, ch)
              try {
                ctx.drawImage(liveEl, cr.left, cr.top, cr.width, cr.height)
              } catch {
                /* frame momentarily not decodable — leave the black fill this tick */
              }
              cv.style.transformOrigin = kenBurnsOrigin(shown.ovX, shown.ovY)
              cv.style.transform = kbTransform(shown)
            } else {
              ctx.fillStyle = '#000' // gap / bad / not-yet-decoded → black
              ctx.fillRect(0, 0, cw, ch)
            }
          }
        }
        // The <video>s stay hidden (decode-only). Manage AUDIO + keep OFF-screen
        // sources idle. The SHOWN source's slots have their play/pause driven by the
        // playing/paused branches above (live plays, buddy paused / pre-rolled /
        // swapped) — don't fight that here.
        const audioEngineOwns = !!audioEngineRef.current?.active()
        for (const [src, pair] of slotsRef.current) {
          const li = liveSlotRef.current.get(src) ?? 0
          for (let slot = 0; slot < pair.length; slot++) {
            const v = pair[slot]
            if (!v) continue
            if (v.style.visibility !== 'hidden') v.style.visibility = 'hidden'
            if (src !== shown?.src) {
              if (!v.muted) v.muted = true
              if (isPlaying && !v.paused) v.pause() // an off-screen source: stop its decoder
              continue
            }
            const isLive = slot === li
            v.muted = audioEngineOwns || !isLive || shown?.muted === true
            if (isLive && shown) {
              v.volume = clamp((shown.gain ?? 1) * seamGain(t, di, ss, seamFadeS), 0, 1)
              v.playbackRate = clamp(shown.speed, 0.25, 4)
            }
          }
        }
      } else {
        // ── MOBILE / no-canvas: the original element-visibility path (single decoder,
        // no buddy). Same-source seams cold-seek the one element (a brief stall) — the
        // canvas path above is desktop-only (iOS video→canvas is finicky).
        for (const [src, pair] of slotsRef.current) {
          const li = liveSlotRef.current.get(src) ?? 0
          for (let slot = 0; slot < pair.length; slot++) {
            const v = pair[slot]
            if (!v) continue
            if (slot !== li) {
              v.style.visibility = 'hidden'
              if (!v.muted) v.muted = true
              if (!v.paused) v.pause()
              continue
            }
            const isShown = !!shown && shown.src === src && !badRef.current.has(src)
            v.style.visibility = isShown ? 'visible' : 'hidden'
            if (isShown && shown) {
              const audioEngineOwns = !!audioEngineRef.current?.active()
              v.muted = shown.muted === true || audioEngineOwns
              v.volume = clamp((shown.gain ?? 1) * seamGain(t, di, ss, seamFadeS), 0, 1)
              v.playbackRate = clamp(shown.speed, 0.25, 4)
              v.style.transformOrigin = kenBurnsOrigin(shown.ovX, shown.ovY)
              v.style.transform = kbTransform(shown)
            } else if (!isShown && !v.paused && isPlaying && shown?.src !== src) {
              v.pause() // never let a hidden element keep playing audio
            }
          }
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ▶ at the very end restarts from the first clip.
  useEffect(() => {
    if (!playing) return
    if (tRef.current >= totalRef.current - 0.05 && segsRef.current.length) {
      const first = segsRef.current[0]
      tRef.current = first.start
      lastWroteRef.current = first.start
      setPlayhead(first.start)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing])

  const t = clamp(playhead, 0, total)
  const segShown = segs[Math.max(0, displayIdxAt(t))]
  const first = segs[0]
  const srcAspect = first?.srcW && first?.srcH ? first.srcW / first.srcH : 9 / 16
  const aspect = project.aspectW && project.aspectH ? project.aspectW / project.aspectH : srcAspect
  const frame = containRect(stageSize.w, stageSize.h, aspect)

  if (!segs.length) {
    return (
      <div className="preview">
        <div className="video-wrap">
          <div className="stage">
            <div className="video-empty">{missing > 0 ? MISSING_MEDIA_MESSAGE : 'No clips in the sequence'}</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="preview">
      <DocAudio doc={doc} playing={playing} playhead={playhead} />
      <div className="video-wrap">
        <div className="stage" ref={stageRef} onClick={() => { if (!playing) primePlayback(); setPlaying(!playing) }}>
          <div
            ref={frameRef}
            className="frame"
            style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height, backgroundColor: '#000' }}
          >
            {sources.flatMap((src) =>
              (buddySrcs.has(src) ? [0, 1] : [0]).map((slot) => (
                <video
                  key={src + '#' + slot}
                  src={urlOf.get(src)}
                  preload="auto"
                  playsInline
                  data-ec-base
                  // will-change keeps the element on its own GPU layer so the
                  // Ken Burns transform composites without a per-frame CPU repaint.
                  style={{ visibility: 'hidden', position: 'absolute', inset: 0, width: '100%', height: '100%', willChange: 'transform', backfaceVisibility: 'hidden' }}
                  onError={() => badRef.current.add(src)}
                  ref={(el) => setSlot(src, slot, el)}
                />
              ))
            )}
            {useCanvas && frame.width > 0 && frame.height > 0 && (
              // Desktop base-picture compositor. Sits ABOVE the (hidden, decode-only)
              // <video>s and BELOW the overlays by DOM order. Backing store is frame×dpr
              // for crispness; the reconciler drawImages the live decoder here each rAF.
              <canvas
                ref={canvasRef}
                width={Math.round(frame.width * dpr)}
                height={Math.round(frame.height * dpr)}
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', willChange: 'transform', backfaceVisibility: 'hidden' }}
              />
            )}
            {frame.width > 0 && <OverlayLayer frame={{ left: 0, top: 0, width: frame.width, height: frame.height }} />}
            {frame.width > 0 && <TextLayer frame={{ left: 0, top: 0, width: frame.width, height: frame.height }} />}
          </div>
        </div>
      </div>
      <div className="transport">
        <span className="aspect-pick">
          {([['Src', 0, 0], ['16:9', 16, 9], ['9:16', 9, 16], ['4:3', 4, 3], ['3:4', 3, 4], ['1:1', 1, 1]] as const).map(
            ([label, aw, ah]) => (
              <button
                key={label}
                className={'mini' + (project.aspectW === aw && project.aspectH === ah ? ' on toggle' : '')}
                onClick={() => setAspect(aw, ah)}
              >
                {label}
              </button>
            )
          )}
        </span>
        <span className="sep" />
        <button onClick={() => setPlaying(!playing)}>{playing ? '⏸' : '▶'}</button>
        <button
          onClick={() => {
            setPlaying(false)
            setPlayhead(segs[0]?.start ?? 0)
          }}
        >
          ⏮
        </button>
        <span className="time">
          {fmt(segShown ? clamp(t, 0, total) : t)} <span className="muted">/ {fmt(total)}</span>
        </span>
        <input
          type="range"
          min={0}
          max={Math.max(0.1, total)}
          step={0.05}
          value={Math.min(t, total)}
          onChange={(e) => {
            setPlaying(false)
            setPlayhead(Number(e.target.value)) // doc mode: slider IS timeline time
          }}
          style={{ flex: 1, marginLeft: 10 }}
        />
      </div>
    </div>
  )
}
