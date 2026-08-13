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
import { previewClickSuppressed } from '../previewClickGuard'
import { playClock, primePlayback } from '../clock'
import { kenBurnsOrigin, kenBurnsTransform, cropToKenBurns } from '../kenBurns'
import { SeamlessAudio } from '../previewAudio'
import { useSharedEngineSnapshot } from '../timelineEngine'
import { framesToSeconds } from '@shared/timeline/time'
import { mainTrackId, documentDuration } from '@shared/timeline/model'
import type { TimelineDocument, Clip as DocClip } from '@shared/timeline/types'
import { resolveMedia, MISSING_MEDIA_MESSAGE } from '../media/resolver'
import { WcPlayer, wcSupported } from '../preview/wcPlayer'
import { FfPlayer, ffSupported } from '../preview/ffPlayer'
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
  /** A still image sitting on the MAIN lane (a base segment between video clips):
   *  it has no frames and no audio, so it's drawn to the canvas as an <img> and
   *  kept OUT of the <video>/seam machinery + contributes silence to the audio. */
  isImage?: boolean
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
      // An image has no audio; mark it muted so the seamless audio engine keeps it
      // as a timed-silent slot (no decode failure, elements stay muted → no echo).
      muted: c.audioDetached === true || c.muted === true || c.kind === 'image',
      ovScale: (typeof c.metadata?.ovScale === 'number' ? c.metadata.ovScale : 1) * cb.scale,
      ovZoomStart: typeof c.metadata?.ovZoomStart === 'number' ? c.metadata.ovZoomStart : 1,
      ovZoomEnd: typeof c.metadata?.ovZoomEnd === 'number' ? c.metadata.ovZoomEnd : 1,
      ovX: (typeof c.metadata?.ovX === 'number' ? c.metadata.ovX : 0) + cb.ovX,
      ovY: (typeof c.metadata?.ovY === 'number' ? c.metadata.ovY : 0) + cb.ovY,
      gain: typeof c.gain === 'number' ? c.gain : 1,
      speed,
      isImage: c.kind === 'image'
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
  // Only VIDEO sources get a <video> slot + the seam/decode-ahead machinery. Image
  // segments have no frames, so they're excluded here and drawn straight to canvas.
  const sources = useMemo(
    () => [...new Set(segs.filter((s) => !s.isImage).map((s) => s.src))],
    [segs.filter((s) => !s.isImage).map((s) => s.src).join('|')]
  )
  const urlOf = new Map(segs.map((s) => [s.src, s.url]))
  // Runtime spans EVERY lane. Measuring only the main-lane segments stopped the
  // transport at the last base clip, so an overlay (or text/music) running past
  // it was unreachable — and equally, the playhead could wander into dead space
  // past the real end of the edit.
  const total = framesToSeconds(documentDuration(doc), doc.timebase)

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

  // Miss-driven adaptive prewarm lead: stays at the known-good PREWARM_LEAD_S and
  // only GROWS (bounded) after a seam where the buddy was not ready in time; a run
  // of clean swaps decays it back. Fast machines never pay more than today; slow
  // ones buy just enough lead. The use site also caps it at half the kept segment,
  // so the buddy always idles between seams (the frozen-frame guard the fixed-lead
  // comment above warns about).
  const prewarmLeadRef = useRef(PREWARM_LEAD_S)
  const swapHitsRef = useRef(0)

  // ---- refs the reconciler reads (fresh every render) ----
  // POSTER FRAMES. The library already holds a decoded first-frame thumbnail per
  // source (built at import, cached in the main process). Painting it while the
  // decoder spins up is what stops a freshly opened project showing black —
  // decoding a real first frame takes a keyframe seek, this takes nothing.
  const library = useStore((s) => s.library)
  const posterElsRef = useRef(new Map<string, HTMLImageElement>())
  const posterFor = (src: string): HTMLImageElement | null => {
    const cached = posterElsRef.current.get(src)
    if (cached) return cached.complete && cached.naturalWidth > 0 ? cached : null
    const url = library.find((it) => it.path === src)?.thumb
    if (!url) return null
    const img = new Image()
    img.src = url
    posterElsRef.current.set(src, img)
    return null // available from the next frame on
  }
  const drawPoster = (ctx: CanvasRenderingContext2D, cw: number, ch: number, src: string): void => {
    const img = posterFor(src)
    if (!img) return
    const aspect = img.naturalWidth / img.naturalHeight
    const rw = cw / ch > aspect ? ch * aspect : cw
    const rh = cw / ch > aspect ? ch : cw / aspect
    try {
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, cw, ch)
      ctx.drawImage(img, (cw - rw) / 2, (ch - rh) / 2, rw, rh)
    } catch {
      /* not decodable yet — the real frame will land shortly anyway */
    }
  }

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
  const imgRef = useRef<HTMLImageElement | null>(null) // overlay <img> for a still-image main clip
  // Tracks the ACTIVE element's currentTime + the wall time it last CHANGED, so the
  // reconciler can tell a LIVE decoder (new frames arriving) from a stalled/seeking one
  // and keep the playhead advancing on the wall clock instead of freezing on a stall.
  const ctTrackRef = useRef<{ src: string; ct: number; wall: number }>({ src: '', ct: -1, wall: 0 })

  // WEBCODECS canvas compositor (desktop): the promised rVFC/WebCodecs redo of
  // the old (removed) drawImage-a-hidden-<video> canvas path, which returned
  // BLACK frames from hardware-decoded elements. Mediabunny demuxes each source
  // and WebCodecs decodes straight to VideoSamples the reconciler paints onto
  // the canvas — a cut seam is "draw from a different queue", NO seeks, so it
  // cannot stutter by construction. Sound comes from the SeamlessAudio engine
  // (the elements stay paused). Mobile keeps the element path (single hardware
  // decode pipeline), and ANY engine failure — including audio that won't start
  // — flips wcOn off, handing back to the untouched element machinery below.
  // ENGINE LADDER (desktop): WebCodecs first, native ffmpeg second, elements last.
  //
  // WcPlayer decodes through Chromium's WebCodecs, which on Windows is HARDWARE
  // decode (D3D11VA/QuickSync) — the frames never cost CPU, which is what keeps
  // playback smooth on modest machines. FfPlayer decodes with the bundled ffmpeg
  // in the MAIN process and copies raw frames over a pipe: that is real CPU work
  // plus a process spawn per seek, so on an older laptop it stutters, races
  // through cut footage instead of jumping, and holds the picture at every seam.
  // It therefore runs ONLY where WebCodecs cannot open the file at all (exotic
  // HEVC/ProRes) — the one thing it is genuinely better at.
  //
  // `wcOn` = "a canvas engine is driving"; `engineKind` = which one. A decode
  // failure DEMOTES one rung (wc → ff → elements) instead of dropping straight
  // to the element path, so an unsupported codec still gets a picture.
  const [engineKind, setEngineKind] = useState<'wc' | 'ff'>(() => (wcSupported() ? 'wc' : 'ff'))
  const engineKindRef = useRef(engineKind)
  engineKindRef.current = engineKind
  const [wcOn, setWcOn] = useState(() => !isMobile && (wcSupported() || ffSupported()))
  const wcOnRef = useRef(wcOn)
  wcOnRef.current = wcOn
  const wcRef = useRef<WcPlayer | FfPlayer | null>(null)
  if (wcOn && !wcRef.current) {
    wcRef.current = engineKindRef.current === 'wc' && wcSupported() ? new WcPlayer() : new FfPlayer()
  }
  useEffect(() => () => wcRef.current?.dispose(), [])
  // Demote one rung. Held in a ref so the rAF reconciler can call it without
  // re-subscribing every render.
  const demoteRef = useRef<() => void>(() => undefined)
  demoteRef.current = () => {
    if (engineKindRef.current === 'wc' && ffSupported()) {
      console.warn('[preview] WebCodecs could not decode — switching to native ffmpeg')
      wcRef.current?.dispose()
      wcRef.current = null
      engineKindRef.current = 'ff'
      setEngineKind('ff')
      return
    }
    setWcOn(false)
  }
  // Fallback frees the decoders immediately (the element path never reads them).
  useEffect(() => {
    if (!wcOn && wcRef.current) {
      wcRef.current.dispose()
      wcRef.current = null
    }
  }, [wcOn])
  // Waiting-for-audio bookkeeping: on the WC path the videos are paused, so
  // until the audio engine can actually sound we HOLD the clock (a brief
  // "buffering" beat right after open/apply on long videos) — and if it still
  // can't start after a generous window, fall back to the element path.
  const wcAudioWaitRef = useRef(0)
  // A play edge must not release the audio/master clock until WebCodecs has the
  // current frame AND a decoded frame ahead. Otherwise a long-GOP source holds
  // its paused still while audio/playhead run, then visibly catches up later.
  const wcVideoReadyRef = useRef(false)
  const wcVideoWaitRef = useRef(0)
  const srcSig = sources.join('|')
  useEffect(() => {
    if (!wcOn) return
    // engineKind is a dep: a demotion builds a NEW player that owns no sources.
    wcRef.current?.setSources(segsRef.current.filter((s) => !s.isImage).map((s) => ({ src: s.src })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcSig, wcOn, engineKind])

  // POLISHING phase: executeCuts bumps polishReq. Decode every cut's landing
  // frame ONCE (the seam cache), driving the % bar, then clear it so the editor
  // unlocks — the first playback is then armed at every seam. Keyed on polishReq
  // (not the boolean) so it re-fires on EVERY Apply even if a prior build got
  // stuck active. Seams come from the AUTHORITATIVE post-cut doc (segsRef can lag
  // a render behind an Apply). A minimum visible window makes a fast build
  // perceptible; a hard timeout guarantees the lock always releases.
  const polishReq = useStore((s) => s.polishReq)
  const setPolishing = useStore((s) => s.setPolishing)
  useEffect(() => {
    if (!polishReq) return // initial mount (req 0) — nothing applied yet
    let cancelled = false
    const MIN_MS = 900
    const start = performance.now()
    const finish = (): void => {
      if (cancelled) return
      const wait = Math.max(0, MIN_MS - (performance.now() - start))
      window.setTimeout(() => {
        if (!cancelled) setPolishing({ active: false, percent: 100 })
      }, wait)
    }
    const wc = wcRef.current
    // Seams from the post-cut doc prop (executeCuts bumped polishReq in the same
    // update, so this render's `doc` is already the cut timeline).
    const ss = docSegments(doc).segs
    const seams: { src: string; t: number }[] = []
    if (ss[0] && !ss[0].isImage) seams.push({ src: ss[0].src, t: ss[0].sourceStart })
    for (let i = 1; i < ss.length; i++) {
      const a = ss[i - 1]
      const b = ss[i]
      if (b.isImage) continue
      const contiguous = a.src === b.src && Math.abs(a.sourceEnd - b.sourceStart) < 0.05
      if (!contiguous) seams.push({ src: b.src, t: b.sourceStart })
    }
    console.info('[wc-preview] polishing:', { wcOn, hasPlayer: !!wc, seams: seams.length })
    if (!wcOn || !wc || !seams.length) {
      finish()
      return () => { cancelled = true }
    }
    const safety = window.setTimeout(() => { if (!cancelled) setPolishing({ active: false, percent: 100 }) }, 30000)
    void wc
      .cacheSeams(seams, (d, total) => {
        if (!cancelled) setPolishing({ active: true, percent: total ? Math.round((d / total) * 100) : 100 })
      })
      .finally(() => {
        window.clearTimeout(safety)
        console.info('[wc-preview] polishing done')
        finish()
      })
    return () => {
      cancelled = true
      window.clearTimeout(safety)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polishReq, wcOn, engineKind])
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
      // This accepted external position is now the synchronization baseline.
      // Without updating it, scrubbing back to the player's previous write
      // (especially rewind to 0 after editing at 3s) looked like an echoed
      // internal write and was ignored, leaving the private clock at 3s.
      lastWroteRef.current = playhead
      audioEngineRef.current?.seek(playhead) // re-anchor the decoupled audio to the scrub
      if (!playingRef.current) {
        wcVideoReadyRef.current = false
        wcVideoWaitRef.current = 0
      }
    }
  }, [playhead])

  // Feed the audio engine the current edited segments (decodes each new source
  // once); keyed on a content signature so it only re-runs on a real edit.
  const audioSig = segs
    .map((s) => `${s.src}:${s.sourceStart}:${s.sourceEnd}:${s.start}:${s.len}:${s.gain}:${s.speed}:${s.muted ? 1 : 0}`)
    .join('|')
  useEffect(() => {
    audioEngineRef.current?.setSegments(segs)
    wcVideoReadyRef.current = false
    wcVideoWaitRef.current = 0
    // segs is rebuilt every render; audioSig captures its content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioSig])

  // True while the audio engine was audible on the previous reconciler tick — the
  // reconciler uses the RISING edge to re-anchor a schedule that was built before
  // the engine could actually sound (see the audio-lock block below).
  const engActiveRef = useRef(false)

  // Start/stop the decoupled audio with playback. On play it schedules the whole
  // edited timeline from the live playhead (gapless); on pause it stops. If sources
  // aren't decoded / the context won't start, active() stays false and the <video>
  // elements keep their own audio — sound is never lost.
  useEffect(() => {
    const eng = audioEngineRef.current
    if (!eng) return
    if (playing) {
      if (wcOnRef.current) {
        // The reconciler starts this only after wc.prime() has decoded a frame
        // ahead. Starting it here made audio outrun a cold video iterator.
        eng.pause()
        wcVideoReadyRef.current = false
        wcVideoWaitRef.current = 0
        engActiveRef.current = false
      } else {
        eng.play(tRef.current)
        // Engine already audible at ▶ → the reconciler's first tick is NOT a rising
        // edge (a re-anchor there would rebuild the just-built schedule for nothing).
        engActiveRef.current = eng.active()
      }
    } else {
      eng.pause()
      wcVideoReadyRef.current = false
      wcVideoWaitRef.current = 0
      engActiveRef.current = false
    }
  }, [playing])

  // Tear down the AudioContext on unmount.
  useEffect(() => () => audioEngineRef.current?.dispose(), [])

  // ---- FIRST-PASS SEAM PRE-WARM (desktop) ----
  // "The first play through a cut stutters; after passing it once (or scrubbing
  // over it) the same cut is smooth": the FIRST seek to any landing point pays
  // demux + keyframe-decode + paging the blob's bytes off disk; every later seek
  // to the same spot is warm and lands in tens of ms — which is exactly why the
  // second pass (and scrub-back) is clean. So make that first visit HERE, while
  // paused, as soon as the cut list changes: walk every seam landing point in
  // playback order starting at the playhead (an early ▶ meets warmed seams
  // first). Seeks go to the element that will actually perform them at play time
  // whenever it's hidden (the same-source buddy, other sources' live slots); the
  // SHOWN source without a buddy gets a DETACHED warmer element instead so the
  // visible paused frame never moves — the page/media-cache warmth transfers.
  // The queue aborts the moment playback starts and re-arms on the next pause or
  // edit; a fully-warmed signature is remembered so pause toggles don't re-walk.
  // Mobile is skipped: one hardware decode pipeline — a warmer would contend
  // with the live picture (the frozen-frame class of bugs).
  const warmedSigRef = useRef('')
  useEffect(() => {
    // Element-path only: the WebCodecs compositor needs no element seek warm-up.
    if (isMobile || wcOn || playing || warmedSigRef.current === buddySig) return
    let cancelled = false
    const detached = new Map<string, HTMLVideoElement>()
    const settleWait = (v: HTMLVideoElement, target: number): Promise<void> =>
      new Promise((res) => {
        const t0 = performance.now()
        const tick = (): void => {
          if (cancelled || Math.abs(v.currentTime - target) < 0.1 || performance.now() - t0 > 1200) res()
          else setTimeout(tick, 50)
        }
        tick()
      })
    const run = async (): Promise<void> => {
      const ss = segsRef.current
      const seams: { src: string; sameSrc: boolean; at: number; landing: number }[] = []
      for (let i = 1; i < ss.length; i++) {
        const a = ss[i - 1]
        const b = ss[i]
        if (b.isImage) continue // no <video> to seek
        const jump = b.sourceStart - a.sourceEnd
        if (a.src === b.src && jump >= 0 && jump <= 0.12) continue // micro-join: plays through, no seek
        seams.push({ src: b.src, sameSrc: a.src === b.src, at: b.start, landing: b.sourceStart })
      }
      const t = tRef.current
      const ordered = [...seams.filter((s) => s.at >= t), ...seams.filter((s) => s.at < t)]
      for (const s of ordered) {
        if (cancelled || playingRef.current || nativeActiveRef.current) return
        if (badRef.current.has(s.src)) continue
        const di = displayIdxAt(tRef.current)
        const shownSrc = di >= 0 ? segsRef.current[di].src : null
        const wv = s.sameSrc ? warmVideo(s.src) : undefined
        const v = wv ?? (s.src !== shownSrc ? liveVideo(s.src) : undefined)
        if (v) {
          if (Math.abs(v.currentTime - s.landing) < 0.06) continue // already parked there
          seek(v, s.landing)
          await settleWait(v, s.landing)
        } else {
          let w = detached.get(s.src)
          if (!w) {
            w = document.createElement('video')
            w.preload = 'auto'
            w.muted = true
            w.src = urlOf.get(s.src) ?? ''
            detached.set(s.src, w)
          }
          w.currentTime = Math.max(0.033, s.landing)
          await settleWait(w, s.landing)
        }
      }
      // Park the buddy back at the FIRST upcoming seam so the play-time prewarm
      // finds it already in place (no seek at all at the first crossing).
      const first = ordered.find((s) => s.sameSrc && warmVideo(s.src))
      if (!cancelled && !playingRef.current && first) {
        const wv = warmVideo(first.src)
        if (wv && Math.abs(wv.currentTime - first.landing) > 0.06) seek(wv, first.landing)
      }
      if (!cancelled) warmedSigRef.current = buddySig
    }
    void run()
    return () => {
      cancelled = true
      for (const w of detached.values()) {
        w.removeAttribute('src')
        w.load() // release the detached decoder immediately
      }
    }
    // buddySig captures the seam content; the helpers/refs are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buddySig, playing, isMobile, wcOn])

  // ---- FIRST-PASS SEAM PRE-WARM (WebCodecs) ----
  // The decoder twin of the element warm-up above, which skips this path on the
  // assumption that a compositor needs no seek warm-up. It doesn't need an
  // ELEMENT seek — but the first decode at a landing point still pays
  // mediabunny's demux/index walk, the OS paging in that part of the file, and
  // a keyframe decode. That is the reported "the first two or three cuts freeze
  // for a second, after that it's smooth", and why pass two is always clean.
  // Same shape as the element version: paused only, playback order from the
  // playhead, one landing at a time, and the warm pipe only — never the one
  // holding the visible frame.
  useEffect(() => {
    const wc = wcRef.current
    if (isMobile || !wcOn || !wc || !('warmSeams' in wc)) return
    if (playing) {
      wc.cancelWarm()
      return
    }
    const ss = segsRef.current
    const seams: { src: string; tSrc: number; at: number }[] = []
    for (let i = 1; i < ss.length; i++) {
      const a = ss[i - 1]
      const b = ss[i]
      if (b.isImage) continue
      const jump = b.sourceStart - a.sourceEnd
      if (a.src === b.src && jump >= 0 && jump <= 0.12) continue // micro-join: plays through
      seams.push({ src: b.src, tSrc: b.sourceStart, at: b.start })
    }
    const t = tRef.current
    const ordered = [...seams.filter((s) => s.at >= t), ...seams.filter((s) => s.at < t)]
    if (!ordered.length) return
    wc.warmSeams(ordered, () => !playingRef.current)
    return () => wc.cancelWarm()
    // buddySig captures the seam content; the refs are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buddySig, playing, isMobile, wcOn])

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
        const cv = canvasRef.current // native surface shows — keep the canvas + image overlay out of the way
        if (cv && cv.style.visibility !== 'hidden') cv.style.visibility = 'hidden'
        const im0 = imgRef.current
        if (im0 && im0.style.visibility !== 'hidden') im0.style.visibility = 'hidden'
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
      if (!isPlaying) wcAudioWaitRef.current = 0
      // (element path only — the WC clock has no decoder drift to adopt)
      if (wasPlaying && !isPlaying && !wcOnRef.current) {
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

      if (isPlaying && wcOnRef.current) {
        // ---- WEBCODECS clock: pure wall clock, re-anchored to the AUDIO
        // engine (the authoritative clock — sample-accurate, runs through
        // main-thread hitches). No decoder chasing: frames are drawn from the
        // decode queues in the display section below, never seeked.
        const eng = audioEngineRef.current
        const wc = wcRef.current
        if (wc?.failed) demoteRef.current() // decode broke → next engine down the ladder

        // First prime the CURRENT source while the timeline is held. A paused
        // still is not sufficient: require one queued future frame so playback
        // cannot start with a frozen first picture on long-GOP media.
        if (!wcVideoReadyRef.current) {
          let videoReady = !active || active.isImage
          if (active && !active.isImage && wc) {
            const tSrc = active.sourceStart + clamp(t - active.start, 0, active.len) * active.speed
            videoReady = wc.prime(active.src, Math.min(tSrc, active.sourceEnd - 0.001))
          }
          if (videoReady) {
            wcVideoReadyRef.current = true
            wcVideoWaitRef.current = 0
          } else {
            if (!wcVideoWaitRef.current) wcVideoWaitRef.current = now
            if (eng?.isPlaying()) eng.pause()
            if (now - wcVideoWaitRef.current > 6000) setWcOn(false)
          }
        }

        if (wcVideoReadyRef.current) {
          // Do not mark the audio clock as playing until decoded buffers exist;
          // expected() must never advance on a schedule containing no nodes.
          if (eng?.failedForCurrentSegments()) {
            // A revoked/unsupported source must not leave the canvas frozen for
            // the full buffering timeout; hand back to element A/V immediately.
            eng.pause()
            setWcOn(false)
          } else if (eng?.ready() && !eng.isPlaying()) eng.play(t)
          const engActive = !!(eng && eng.active())
          if (engActive) {
            wcAudioWaitRef.current = 0
            const ex = eng!.expected()
            // follow the audio clock, never backward, never a wild jump forward
            t = Math.max(t, Math.min(ex, t + Math.max(0.25, dt * 3)))
          } else {
            // Audio can't sound yet (decoding / context resuming): HOLD the
            // clock — a silent picture running ahead of its own sound is worse
            // than a beat of buffering. If it still can't start, fall back to
            // the element path (which has element audio).
            if (!wcAudioWaitRef.current) wcAudioWaitRef.current = now
            if (now - wcAudioWaitRef.current > 6000) {
              console.warn('[wc-preview] audio engine never started — falling back to element path')
              setWcOn(false)
            }
          }
        } else {
          wcAudioWaitRef.current = 0
        }
        if (t >= totalRef.current - 1e-4) {
          playingRef.current = false
          setPlaying(false)
          t = totalRef.current
        }
        if (t > lastWroteRef.current + 0.0005 && now - lastStoreWriteAt.current > 120) {
          lastWroteRef.current = t
          lastStoreWriteAt.current = now
          setPlayhead(t)
        }
      } else if (isPlaying) {
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
            else if (decoderLive && elemT > nt) {
              // A main-thread hitch (GC, heavy re-render, focus loss) stalls THIS rAF
              // loop while the decoder AND the audio keep running in real time — dt is
              // clamped to 0.1s, so t falls behind and the decoder reads as "way
              // ahead". The chase below then used to SEEK IT BACKWARD to the stale
              // clock: a random mid-clip jump/stutter with no cut anywhere near. A
              // LIVE decoder that ran ahead is the truth (it stayed in sync with the
              // audio, which also kept real time) — adopt its position forward.
              nt = elemT
            }
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
              const lead = Math.min(prewarmLeadRef.current, Math.max(0.35, active.len / 2))
              if (up && !badRef.current.has(up.src) && t >= active.start + active.len - lead) {
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
                      // Adapt the prewarm lead from the swap OUTCOME (only where a
                      // buddy exists — growing the lead can't help a source that has
                      // no second slot): a miss grows it, 3 clean swaps shrink it.
                      if (wv) {
                        if (buddyReady) {
                          if (++swapHitsRef.current >= 3) {
                            swapHitsRef.current = 0
                            prewarmLeadRef.current = Math.max(PREWARM_LEAD_S, prewarmLeadRef.current - 0.15)
                          }
                        } else {
                          swapHitsRef.current = 0
                          prewarmLeadRef.current = Math.min(1.6, prewarmLeadRef.current + 0.3)
                        }
                      }
                      if (buddyReady && wv) {
                        const cur = liveSlotRef.current.get(active.src) ?? 0
                        liveSlotRef.current.set(active.src, cur ^ 1) // flip live ↔ buddy
                        if (wv.paused) wv.play().catch(() => undefined)
                      } else {
                        // Buddy not ready → cold-seek the live element (old path);
                        // prewarm re-seeks the buddy for the next seam.
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
        // PAUSED: park every element; the LIVE one of the shown source on the exact
        // frame (element path only — the WC compositor fetches its own stills).
        const di = displayIdxAt(t)
        const showSrc = di >= 0 ? ss[di].src : null
        for (const [src, pair] of slotsRef.current) {
          const li = liveSlotRef.current.get(src) ?? 0
          for (let slot = 0; slot < pair.length; slot++) {
            const v = pair[slot]
            if (!v) continue
            if (!v.paused) v.pause()
            if (!wcOnRef.current && slot === li && src === showSrc && di >= 0 && !badRef.current.has(src)) {
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
        const engActive = !!(isPlaying && eng && eng.active())
        if (eng && engActive && !engActiveRef.current) {
          // RISING EDGE: the engine just became audible MID-play — the decode
          // finished (or the context finally resumed) after ▶. Its schedule was
          // built while buffers were missing / the clock was frozen, and the
          // <video>s mute right now, so without an immediate re-anchor the
          // preview goes SILENT (or keeps a permanent lip-sync offset). Rebuild
          // the schedule from the live timeline position.
          eng.seek(t)
        } else if (eng && engActive && Math.abs(eng.expected() - t) > 0.25) {
          eng.seek(t)
        }
        engActiveRef.current = engActive
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

      if (wcOnRef.current) {
        // ── DESKTOP WEBCODECS: paint the decoded frame for `t` into the canvas.
        // No element is ever shown/hidden/seeked, so seam flashes and seek stalls
        // are impossible by construction; the warm pipe makes same-source cuts a
        // queue swap. Elements stay paused+hidden+muted (SeamlessAudio owns sound).
        const cv = canvasRef.current
        const wc = wcRef.current
        if (cv && wc) {
          if (cv.style.visibility === 'hidden') cv.style.visibility = 'visible' // (native hid it)
          const ctx = cv.getContext('2d')
          if (ctx) {
            const cw = cv.width
            const ch = cv.height
            if (shown && !shown.isImage) {
              const tSrc = shown.sourceStart + clamp(t - shown.start, 0, shown.len) * shown.speed
              const painted = wc.render(ctx, cw, ch, shown.src, Math.min(tSrc, shown.sourceEnd - 0.001), isPlaying)
              // POSTER: nothing decoded yet (a freshly opened project, before the
              // first keyframe lands). Paint the source's already-decoded library
              // thumbnail so the preview opens on a picture instead of black —
              // the real frame replaces it as soon as it arrives.
              if (!painted) drawPoster(ctx, cw, ch, shown.src)
              // Decode-ahead: park the warm pipe on the upcoming seam's in-point.
              const up = ss[di + 1]
              if (up && !up.isImage && t >= shown.start + shown.len - 1.0) wc.prewarm(up.src, up.sourceStart)
              cv.style.transformOrigin = kenBurnsOrigin(shown.ovX, shown.ovY)
              cv.style.transform = kbTransform(shown)
            } else {
              // Gaps are intentionally black. For video segments render() keeps
              // the previous painted frame until its replacement is decoded,
              // avoiding a black flash at cold cut landings.
              ctx.fillStyle = '#000'
              ctx.fillRect(0, 0, cw, ch)
              if (cv.style.transform !== '') cv.style.transform = ''
            }
          }
        }
        // Keep every element idle — the compositor owns the picture, the audio
        // engine owns the sound.
        for (const [, pair] of slotsRef.current) {
          for (const v of pair) {
            if (!v) continue
            if (v.style.visibility !== 'hidden') v.style.visibility = 'hidden'
            if (!v.muted) v.muted = true
            if (!v.paused) v.pause()
          }
        }
        // Still-image main-lane segment: same <img> overlay as the element path.
        const im = imgRef.current
        if (im && shown?.isImage) {
          if (im.getAttribute('data-src') !== shown.src) {
            im.setAttribute('data-src', shown.src)
            im.src = shown.url
          }
          im.style.visibility = 'visible'
          im.style.transformOrigin = kenBurnsOrigin(shown.ovX, shown.ovY)
          im.style.transform = kbTransform(shown)
        } else if (im && im.style.visibility !== 'hidden') {
          im.style.visibility = 'hidden'
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
        // Still-image main-lane segment: no <video> exists for its source, so drive
        // the <img> overlay instead — show it (contain + Ken Burns) over the image's
        // span, hide it otherwise. Every video slot above is hidden while it shows.
        const im = imgRef.current
        if (im && shown?.isImage) {
          if (im.getAttribute('data-src') !== shown.src) {
            im.setAttribute('data-src', shown.src)
            im.src = shown.url
          }
          im.style.visibility = 'visible'
          im.style.transformOrigin = kenBurnsOrigin(shown.ovX, shown.ovY)
          im.style.transform = kbTransform(shown)
        } else if (im && im.style.visibility !== 'hidden') {
          im.style.visibility = 'hidden'
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
        <div className="stage" ref={stageRef} onClick={() => { if (previewClickSuppressed()) return; if (!playing) primePlayback(); setPlaying(!playing) }}>
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
            {/* Still-image main-lane clips have no <video>; this overlay shows the
                image (contain + Ken Burns) during its span — the reconciler toggles
                its visibility/src/transform. Sits above the videos, below overlays. */}
            <img
              ref={imgRef}
              alt=""
              style={{ visibility: 'hidden', position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', willChange: 'transform', backfaceVisibility: 'hidden' }}
            />
            {wcOn && frame.width > 0 && frame.height > 0 && (
              // Desktop WebCodecs compositor. Sits ABOVE the (hidden, idle)
              // <video>s and BELOW the overlays by DOM order. Backing store is frame×dpr
              // for crispness; the reconciler paints decoded VideoSamples here each rAF.
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
