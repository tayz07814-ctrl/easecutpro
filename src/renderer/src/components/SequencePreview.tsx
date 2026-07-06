import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { mediaSrc } from '../platform'
import { computeKeepRanges, virtualKeepsToClipSegments } from '@shared/edit'
import { playClock } from '../clock'
import { useSharedEngineSnapshot } from '../timelineEngine'
import { framesToSeconds } from '@shared/timeline/time'
import { mainTrackId } from '@shared/timeline/model'
import type { TimelineDocument, Clip as DocClip } from '@shared/timeline/types'
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

/** Plays the document's audio-lane clips (music etc.) in sync with the playhead. */
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
    a.volume = Math.min(1, Math.max(0, clip.gain ?? 1))
    const inRange = playhead >= startSec && playhead < endSec
    if (!inRange) {
      if (!a.paused) a.pause()
      return
    }
    const target = clip.sourceIn + (playhead - startSec)
    if (playing) {
      if (Math.abs(a.currentTime - target) > 0.3) a.currentTime = target
      a.play().catch(() => undefined)
    } else {
      a.pause()
      if (Math.abs(a.currentTime - target) > 0.05) a.currentTime = target
    }
  }, [playing, playhead, startSec, endSec, clip.sourceIn, clip.gain])
  return <audio ref={ref} src={mediaSrc(clip.sourcePath as string)} preload="auto" />
}

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
  sourceStart: number
  sourceEnd: number
  /** VIRTUAL-timeline start of this kept segment. The playhead lives in
   *  virtual time everywhere (transcript words, Timeline, chips) — keeping the
   *  preview in the same domain is what keeps them aligned. */
  start: number
  /** EDITED-timeline start (cuts collapsed) — used only for the transport UI. */
  editedStart: number
  len: number
  srcW?: number
  srcH?: number
  /** mute the base <video>'s own audio (its audio was detached to its own lane, or it's muted). */
  muted?: boolean
  /** base-clip transform: size (1 = fill), Ken Burns zoom, pan focal offset, volume. */
  ovScale?: number
  ovZoomStart?: number
  ovZoomEnd?: number
  ovX?: number
  ovY?: number
  gain?: number
  /** playback speed (1 = normal); source time advances `speed`× edited time. */
  speed?: number
}

/**
 * Montage preview: plays the multi-clip base as ONE virtual continuous timeline.
 * It plays the KEPT source segments (project-level cuts already removed via
 * computeKeepRanges + virtualKeepsToClipSegments) back-to-back, switching source
 * files at clip boundaries and skipping cut points, and composites text + overlays
 * on top — so preview matches export and captions/overlays show.
 *
 * Race-free engine (mirrors VideoPreview, hardened by an adversarial review):
 *  - ONE source of truth: the mounted <video> is keyed by `mountedSrc`, and the
 *    playing segment `idxRef` is kept CONSISTENT with it — reseated from the
 *    playhead whenever the segment set changes (an edit while playing) so idxRef
 *    can never name a segment whose file differs from the mounted element (which
 *    was the cause of the "settle guard never clears / stall" class of bugs);
 *  - `seekingRef` holds the target while a seek/switch settles; the rAF loop and
 *    the slider both ignore the video until it lands, and the release is
 *    DIRECTION-AWARE (forward-biased for cut-skips/switches so a forward overshoot
 *    can never wedge the hold);
 *  - the store playhead is only ever advanced FORWARD during playback (self-origin
 *    writes are flagged so a real external scrub is never mistaken for our own);
 *  - the switch decision keys off the MOUNTED src, so setState is never a no-op.
 */
export default function SequencePreview(): JSX.Element {
  const project = useStore((s) => s.project)
  const playing = useStore((s) => s.playing)
  const setPlaying = useStore((s) => s.setPlaying)
  const playhead = useStore((s) => s.project.playhead)
  const setPlayhead = useStore((s) => s.setPlayhead)
  const waveform = useStore((s) => s.waveform) // valley-snapped cut edges (matches export)
  const ref = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setStageSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setStageSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // Source segments to play back-to-back. In DOCUMENT mode they come from the
  // authoritative timeline's main lane (gapless = the final edit); in legacy mode
  // from the montage keep-ranges. Both are anchored in edited seconds.
  const snap = useSharedEngineSnapshot()
  const docMode = !!project.timeline && !!snap?.doc
  const segs: Seg[] = []
  let acc = 0
  if (docMode) {
    const doc = snap!.doc
    const mainId = mainTrackId(doc)
    const main = mainId ? doc.tracks.find((t) => t.id === mainId) : undefined
    for (const c of [...(main?.clips ?? [])].sort((a, b) => a.start - b.start)) {
      if (!c.sourcePath) continue
      const speed = typeof c.speed === 'number' && c.speed > 0 ? c.speed : 1
      // EDITED length = the clip's timeline duration (source span / speed), so a
      // re-sped clip occupies its real timeline slot (== source span when speed 1).
      const len = Math.max(0.02, framesToSeconds(c.duration, doc.timebase))
      // Anchor at the clip's REAL timeline position (not packed) so magnet-off GAPS
      // between pieces are honoured — the preview shows black in the dead space
      // instead of playing the previous clip's footage.
      segs.push({
        src: c.sourcePath,
        sourceStart: c.sourceIn,
        sourceEnd: c.sourceOut,
        start: framesToSeconds(c.start, doc.timebase),
        // Doc mode: the transport lives in REAL timeline time (playhead == real
        // seconds), so editedStart == start and magnet-off GAPS count toward the
        // duration — the slider moves through the dead space (shown black) instead
        // of collapsing it. (Montage packs cuts out via `acc` below.)
        editedStart: framesToSeconds(c.start, doc.timebase),
        len,
        srcW: c.srcW,
        srcH: c.srcH,
        muted: c.audioDetached === true || c.muted === true,
        ovScale: typeof c.metadata?.ovScale === 'number' ? c.metadata.ovScale : 1,
        ovZoomStart: typeof c.metadata?.ovZoomStart === 'number' ? c.metadata.ovZoomStart : 1,
        ovZoomEnd: typeof c.metadata?.ovZoomEnd === 'number' ? c.metadata.ovZoomEnd : 1,
        ovX: typeof c.metadata?.ovX === 'number' ? c.metadata.ovX : 0,
        ovY: typeof c.metadata?.ovY === 'number' ? c.metadata.ovY : 0,
        gain: typeof c.gain === 'number' ? c.gain : 1,
        speed
      })
      acc += len
    }
  } else {
    for (const s of virtualKeepsToClipSegments(project, computeKeepRanges(project, waveform))) {
      const len = Math.max(0.02, s.out - s.in)
      segs.push({ src: s.sourcePath, sourceStart: s.in, sourceEnd: s.out, start: s.vStart, editedStart: acc, len, srcW: s.srcW, srcH: s.srcH })
      acc += len
    }
  }
  // virtual/real end of the last segment = the playhead's clamp ceiling
  const total = segs.length ? segs[segs.length - 1].start + segs[segs.length - 1].len : 0
  // Doc mode counts gaps (real timeline); montage packs cuts out (sum of lens).
  const editedTotal = docMode ? total : acc
  // A fingerprint of the segment structure — changes only on a real edit, not
  // during playback, so the reseat effect below fires exactly when segs change.
  const segsKey = segs.map((s) => `${s.src}@${s.sourceStart.toFixed(2)}>${s.sourceEnd.toFixed(2)}`).join('|')

  // Fresh copies for the async handlers (never capture a stale render).
  const segsRef = useRef(segs)
  segsRef.current = segs
  const totalRef = useRef(total)
  totalRef.current = total
  const playheadRef = useRef(playhead)
  playheadRef.current = playhead

  const idxRef = useRef(0) // segment currently playing (authoritative)
  const seekingRef = useRef(-1) // target source time while a seek/switch settles
  const seekBackRef = useRef(false) // is the pending seek BACKWARD? (scrub) — release differs
  const pendingSeekRef = useRef(-1) // desired source time to apply once a src (re)loads
  const loadedSrcRef = useRef('') // the src the mounted <video> has actually loaded
  const selfWriteRef = useRef(false) // the next playhead change is OUR playback write

  const [mountedSrc, setMountedSrc] = useState<string>(() => segs[0]?.src ?? '')
  const mountedSrcRef = useRef(mountedSrc)
  mountedSrcRef.current = mountedSrc

  function segAt(ph: number): number {
    const ss = segsRef.current
    let i = ss.findIndex((s) => ph >= s.start && ph < s.start + s.len)
    if (i < 0) i = Math.max(0, ss.length - 1)
    return i
  }
  // Index of the segment actually COVERING `ph`, or -1 when the playhead sits in a
  // gap (magnet-off dead space) — used to show black / skip seeking there.
  function coveringIdx(ph: number): number {
    return segsRef.current.findIndex((s) => ph >= s.start && ph < s.start + s.len)
  }
  // Which segment to DISPLAY when paused: the covering one, or — when the playhead
  // sits at/past the very end — the LAST clip (show its final frame, not black).
  // Interior gaps still return -1 (magnet-off dead space stays black).
  function displayIdx(ph: number): number {
    const cov = coveringIdx(ph)
    if (cov >= 0) return cov
    const ss = segsRef.current
    if (!ss.length) return -1
    const last = ss[ss.length - 1]
    return ph >= last.start + last.len - 1e-4 ? ss.length - 1 : -1
  }
  // Advance the store playhead from playback; flagged so the external-scrub effect
  // ignores it. Callers only ever pass forward-moving values. Skips no-op writes
  // so the flag can't get stuck set (which would swallow a later real scrub).
  function selfSetPlayhead(nt: number): void {
    if (Math.abs(nt - playheadRef.current) < 1e-4) return
    selfWriteRef.current = true
    setPlayhead(nt)
  }
  // Point the mounted <video> at a source + seek there. If the file is already
  // mounted, seek inline (no remount / no onLoaded needed).
  function gotoSource(src: string, srcT: number, backward: boolean): void {
    seekingRef.current = srcT
    seekBackRef.current = backward
    const v = ref.current
    const mountedLoaded = !!v && src === mountedSrcRef.current && loadedSrcRef.current === src
    if (mountedLoaded) {
      pendingSeekRef.current = -1
      v!.currentTime = srcT
    } else if (src === mountedSrcRef.current) {
      // Right file, but its metadata hasn't loaded yet (writing currentTime now
      // would be dropped) — hand the exact target to onLoaded.
      pendingSeekRef.current = srcT
    } else {
      pendingSeekRef.current = srcT
      setMountedSrc(src)
    }
  }

  // Reseat idxRef (+ source) from the playhead whenever the segment set changes —
  // e.g. an edit (cut / trim / reorder) while playing. Keeps idxRef consistent
  // with the mounted element so the switch logic can't wedge.
  useEffect(() => {
    const ph = playheadRef.current
    const i = segAt(ph)
    idxRef.current = i
    const seg = segsRef.current[i]
    if (seg && seg.src !== mountedSrcRef.current) {
      pendingSeekRef.current = seg.sourceStart + Math.max(0, ph - seg.start) * (seg.speed ?? 1)
      seekingRef.current = pendingSeekRef.current
      seekBackRef.current = false
      setMountedSrc(seg.src)
    } else if (seg && loadedSrcRef.current !== seg.src) {
      // SAME src re-appearing on a fresh element (clip moved off the main lane
      // and back) — nothing changes mountedSrc, and if the browser already had
      // the metadata cached the load events can fire before our handlers attach.
      // Hand the target to onLoaded and force a reload so an event ALWAYS fires.
      pendingSeekRef.current = seg.sourceStart + Math.max(0, ph - seg.start) * (seg.speed ?? 1)
      seekingRef.current = pendingSeekRef.current
      seekBackRef.current = false
      ref.current?.load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segsKey])

  // EXTERNAL playhead change (scrub / segment click) -> reseat idxRef + seek.
  // Our own playback writes are flagged and skipped here.
  useEffect(() => {
    if (selfWriteRef.current) {
      selfWriteRef.current = false
      return
    }
    const i = segAt(playhead)
    idxRef.current = i
    const seg = segsRef.current[i]
    if (!seg) return
    const srcT = seg.sourceStart + Math.max(0, playhead - seg.start) * (seg.speed ?? 1)
    const v = ref.current
    gotoSource(seg.src, srcT, v ? srcT < v.currentTime : false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playhead])

  useEffect(() => {
    const v = ref.current
    if (!v) return
    if (playing) {
      // Restart from the top if we're sitting at the end (▶ would otherwise be a
      // dead button after playback finishes).
      if (playheadRef.current >= totalRef.current - 0.05 && segsRef.current.length) {
        idxRef.current = 0
        const seg = segsRef.current[0]
        selfSetPlayhead(seg.start) // first KEPT virtual moment (0 may be cut)
        gotoSource(seg.src, seg.sourceStart, false)
      }
      v.play().catch(() => undefined)
    } else {
      v.pause()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, mountedSrc])

  // rAF loop: precise cut-skip + source-switch with a settle guard (60fps so we
  // never play visibly into a deleted region before jumping).
  useEffect(() => {
    const v = ref.current
    if (!v || !playing) return
    let raf = 0
    let holdSince = -1 // wall-clock when the current settle hold began (watchdog)
    // Gap traversal (magnet-off dead space between main-lane clips): while active,
    // the <video> is paused and the playhead advances through the gap on the wall
    // clock so it plays as BLACK for the gap's real duration, then resumes at `next`.
    let gapMode = false
    let gapWall = 0
    let gapPh = 0
    let gapNextIdx = -1
    const loop = (): void => {
      const ss = segsRef.current
      if (gapMode) {
        const next = ss[gapNextIdx]
        const nph = gapPh + (performance.now() - gapWall) / 1000
        if (!next || nph >= next.start) {
          gapMode = false
          if (!next) {
            v.pause()
            setPlaying(false)
            selfSetPlayhead(totalRef.current)
            playClock.t = totalRef.current
            return
          }
          idxRef.current = gapNextIdx
          selfSetPlayhead(next.start + 0.0005)
          playClock.t = next.start
          gotoSource(next.src, next.sourceStart, false)
          v.play().catch(() => undefined)
        } else {
          selfSetPlayhead(nph)
          playClock.t = nph
        }
        raf = requestAnimationFrame(loop)
        return
      }
      // Playback started (or scrubbed) INSIDE a gap: traverse the dead space to the
      // next clip as black rather than snapping to a neighbouring segment.
      if (ss.length && coveringIdx(playheadRef.current) < 0) {
        const ni = ss.findIndex((s) => s.start > playheadRef.current)
        if (ni < 0) {
          v.pause()
          setPlaying(false)
          selfSetPlayhead(totalRef.current)
          playClock.t = totalRef.current
          return
        }
        if (!v.paused) v.pause()
        gapMode = true
        gapWall = performance.now()
        gapPh = playheadRef.current
        gapNextIdx = ni
        raf = requestAnimationFrame(loop)
        return
      }
      // Defensive: if idxRef fell out of range (edit shrank segs), re-derive it.
      if (idxRef.current >= ss.length || idxRef.current < 0) idxRef.current = segAt(playheadRef.current)
      const active = ss[idxRef.current]
      if (!active) {
        raf = requestAnimationFrame(loop)
        return
      }
      const ct = v.currentTime
      // Hold until a pending seek/switch actually lands. Direction-aware release:
      // forward seeks release once reached-or-passed (a forward overshoot can't
      // wedge the hold); backward scrubs release once dropped back to the target.
      if (seekingRef.current >= 0) {
        const reached = seekBackRef.current ? ct <= seekingRef.current + 0.06 : ct >= seekingRef.current - 0.06
        if (reached) {
          seekingRef.current = -1
          seekBackRef.current = false
          holdSince = -1
        } else {
          // Watchdog: a seek/switch that never lands (e.g. a target clamped past
          // the file's real duration, or a decoder stall) would otherwise wedge
          // the hold forever. After ~0.8s, force-release and re-derive the segment
          // from the playhead so playback self-heals instead of freezing.
          const now = performance.now()
          if (holdSince < 0) holdSince = now
          else if (now - holdSince > 800) {
            seekingRef.current = -1
            seekBackRef.current = false
            holdSince = -1
            idxRef.current = segAt(playheadRef.current)
          }
          if (seekingRef.current >= 0) {
            raf = requestAnimationFrame(loop)
            return
          }
        }
      }
      // Drive the shared clock in EDITED time every frame so the Timeline playhead
      // line + overlay progress glide (they read playClock at 60fps) instead of
      // freezing while the store playhead only ticks ~4Hz via onTimeUpdate.
      playClock.t = active.start + Math.min(active.len, Math.max(0, (ct - active.sourceStart) / (active.speed ?? 1)))
      if (ct >= active.sourceEnd - 0.04) {
        const nextIdx = idxRef.current + 1
        const next = ss[nextIdx]
        if (!next) {
          v.pause()
          setPlaying(false)
          selfSetPlayhead(totalRef.current)
          playClock.t = totalRef.current
          return
        }
        // Magnet-off dead space before the next clip → traverse it as BLACK in real
        // time (video paused, playhead advances on the wall clock), then resume at
        // `next`. Only a real gap on the timeline; contiguous clips fall through.
        const gapStart = active.start + active.len
        if (next.start - gapStart > 0.08) {
          if (!v.paused) v.pause()
          gapMode = true
          gapWall = performance.now()
          gapPh = Math.max(gapStart, playheadRef.current)
          gapNextIdx = nextIdx
          selfSetPlayhead(gapPh)
          playClock.t = gapPh
          raf = requestAnimationFrame(loop)
          return
        }
        idxRef.current = nextIdx
        selfSetPlayhead(next.start + 0.0005) // forward only
        // Micro-gap within the SAME contiguous file (<0.12s, e.g. a shortened
        // silence): let it play through — a seek stutters more. Still arm the
        // settle hold so the slider doesn't blip until we reach next.sourceStart.
        const gap = next.sourceStart - active.sourceEnd
        const contiguousMicro = next.src === mountedSrcRef.current && next.src === active.src && gap >= 0 && gap <= 0.12
        if (contiguousMicro) {
          seekingRef.current = next.sourceStart
          seekBackRef.current = false
        } else {
          // A later montage segment can map to an EARLIER spot in the same file
          // (reordered / reused ranges) → the seek is physically backward, so the
          // settle release must wait for currentTime to DROP (not rise). For a
          // cross-file switch the fresh element loads forward, so pass false.
          const back = next.src === mountedSrcRef.current && next.sourceStart < ct
          gotoSource(next.src, next.sourceStart, back)
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, mountedSrc])

  // While paused / scrubbing, keep the shared clock (and thus the Timeline
  // playhead line) pinned to the playhead.
  useEffect(() => {
    if (!playing) playClock.t = playhead
  }, [playing, playhead])

  // While PAUSED, park the mounted <video> on the frame under the playhead. Mount
  // and edits (splits, new segments) can otherwise leave it on a stale/black frame
  // because the rAF play loop isn't running to seek it.
  useEffect(() => {
    if (playing) return
    const v = ref.current
    if (!v) return
    const i = displayIdx(playhead)
    if (i < 0) return // interior gap: the video is hidden, nothing to seek
    const seg = segsRef.current[i]
    // clamp the edited offset to the clip so a past-the-end playhead lands on the
    // clip's LAST frame instead of leaving the element black.
    const editedOff = Math.max(0, Math.min(seg.len, playhead - seg.start))
    let target = seg.sourceStart + editedOff * (seg.speed ?? 1)
    if (seg.src !== mountedSrcRef.current) {
      pendingSeekRef.current = target
      setMountedSrc(seg.src)
      return
    }
    if (loadedSrcRef.current !== seg.src) return // not loaded yet — onLoaded seeks it
    if (isFinite(v.duration) && v.duration > 0) target = Math.min(target, v.duration - 0.05)
    // Writing the SAME currentTime is a no-op (no 'seeked' → a fresh element stays
    // BLACK), so nudge a hair when we're already there to force a decode.
    if (Math.abs(v.currentTime - target) < 0.02) v.currentTime = target > 0.05 ? target - 0.03 : target + 0.03
    else v.currentTime = target
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, playhead, segsKey, mountedSrc])

  // Mute the base <video>'s OWN audio when the active clip's audio was detached (it
  // now plays on its own audio lane via <DocAudio>) or the clip is muted — otherwise
  // you'd hear the source audio AND the detached copy (double audio).
  useEffect(() => {
    const v = ref.current
    if (!v) return
    const i = coveringIdx(playhead)
    const seg = i >= 0 ? segsRef.current[i] : undefined
    v.muted = docMode && seg ? seg.muted === true : false
    // per-clip volume (gain) + speed — the Basic-tab Volume/Speed controls.
    v.volume = Math.min(1, Math.max(0, seg?.gain ?? 1))
    v.playbackRate = Math.min(4, Math.max(0.25, seg?.speed ?? 1))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, playhead, segsKey, docMode])

  // Base-clip transform: size (ovScale, 1 = fill) × Ken Burns zoom (ovZoomStart..End)
  // with a pan focal point (ovX/ovY), applied to the base <video>. Doc-native base
  // motion driven off the active main clip's metadata; ramps on the shared clock.
  useEffect(() => {
    const v = ref.current
    if (!v) return
    const applyAt = (): void => {
      const i = coveringIdx(playheadRef.current)
      const seg = segsRef.current[i >= 0 ? i : idxRef.current]
      if (!seg) {
        v.style.transform = ''
        return
      }
      const size = seg.ovScale ?? 1
      const zs = seg.ovZoomStart ?? 1
      const ze = seg.ovZoomEnd ?? 1
      const prog = seg.len > 0 ? Math.min(1, Math.max(0, (playClock.t - seg.start) / seg.len)) : 0
      const scale = size * (zs + (ze - zs) * prog)
      v.style.transformOrigin = `${50 + (seg.ovX ?? 0) * 100}% ${50 + (seg.ovY ?? 0) * 100}%`
      v.style.transform = Math.abs(scale - 1) > 0.001 ? `scale(${scale})` : ''
    }
    if (playing) {
      let raf = 0
      const loop = (): void => {
        applyAt()
        raf = requestAnimationFrame(loop)
      }
      raf = requestAnimationFrame(loop)
      return () => cancelAnimationFrame(raf)
    }
    applyAt()
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, playhead, segsKey])

  // Guarantee the first frame decodes after a (re)mount — the classic "black
  // preview" on reopen or after moving the base clip off→onto the main lane. Two
  // traps: (1) cached media fires 'loadedmetadata' before this handler attaches, so
  // the seek never runs; (2) the element can REMOUNT with the SAME src (segs went
  // empty then repopulated), where nothing changes mountedSrc. We reset loadedSrcRef
  // when the video unmounts (segs empty) so a same-src remount is detected, re-run on
  // segsKey, and — with onLoadedData/onCanPlay below — seek from whichever load event
  // fires after the handler is live.
  useEffect(() => {
    if (segsRef.current.length === 0) {
      loadedSrcRef.current = '' // video unmounted → force a fresh seek on remount
      return
    }
    const v = ref.current
    if (!v) return
    if (v.readyState >= 1 /* HAVE_METADATA */ && loadedSrcRef.current !== mountedSrcRef.current) {
      onLoaded()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mountedSrc, segsKey])

  // Coarse (~4Hz) slider update while inside a kept segment; ignored while a seek
  // settles, and never allowed to write BACKWARD during playback.
  function onTimeUpdate(): void {
    const v = ref.current
    if (!v || !playing) return
    if (seekingRef.current >= 0) return
    const active = segsRef.current[idxRef.current]
    if (!active) return
    const ct = v.currentTime
    if (ct < active.sourceStart - 0.05 || ct > active.sourceEnd + 0.05) return
    const ph = active.start + Math.max(0, ct - active.sourceStart) / (active.speed ?? 1)
    if (ph + 0.0005 < playheadRef.current) return // monotonic: never step back
    selfSetPlayhead(ph)
  }

  // A source (re)loaded (remount on clip switch): seek to the desired spot.
  function onLoaded(): void {
    const v = ref.current
    if (!v) return
    // Called from loadedmetadata / loadeddata / canplay + the readyState effect —
    // idempotent per mount: once we've seeked THIS element, later events skip.
    if (loadedSrcRef.current === mountedSrcRef.current && pendingSeekRef.current < 0) return
    loadedSrcRef.current = mountedSrcRef.current
    // Seek a freshly-(re)mounted element to the frame under the CURRENT playhead
    // (not just the segment start), so re-dropping / reselecting a source shows the
    // right frame instead of a black one.
    let want = pendingSeekRef.current
    if (want < 0) {
      const ph = playheadRef.current
      const ci = coveringIdx(ph)
      const seg = segsRef.current[ci >= 0 ? ci : idxRef.current]
      want = seg ? seg.sourceStart + Math.max(0, Math.min(seg.len, ph - seg.start)) * (seg.speed ?? 1) : 0
    }
    // The decoded file can be slightly SHORTER than the trim metadata's nominal
    // duration; the browser clamps currentTime to the real duration, so an
    // unclamped target could sit past it and the forward settle release would
    // never fire. Clamp so the hold always becomes satisfiable.
    if (isFinite(v.duration) && v.duration > 0) want = Math.min(want, v.duration - 0.05)
    // A freshly-mounted <video> sits at currentTime 0 showing NO decoded frame, and
    // writing 0 again is a no-op (no 'seeked' fires → the preview stays BLACK until
    // you scrub — the classic "black on open"). Nudge a hair past 0 so a seek always
    // fires and the first frame decodes. Imperceptible (~1 frame).
    if (want <= 0.001) want = Math.min(0.033, Math.max(0.001, (v.duration || 1) - 0.05))
    v.currentTime = want
    seekingRef.current = want
    seekBackRef.current = false // freshly-loaded start is a forward target
    pendingSeekRef.current = -1
    if (playing) v.play().catch(() => undefined)
  }

  // A source that can't decode (missing / moved / corrupt file, or a still image
  // mounted in <video>) fires 'error' instead of 'loadedmetadata'. Skip past it
  // (and any following segments from the same file) so it can't wedge playback.
  function onMediaError(): void {
    seekingRef.current = -1
    seekBackRef.current = false
    pendingSeekRef.current = -1
    const ss = segsRef.current
    const badSrc = ss[idxRef.current]?.src
    let ni = idxRef.current + 1
    while (ni < ss.length && ss[ni].src === badSrc) ni++
    const next = ss[ni]
    if (next) {
      idxRef.current = ni
      selfSetPlayhead(next.start + 0.0005)
      gotoSource(next.src, next.sourceStart, false)
    } else if (playing) {
      const v = ref.current
      if (v) v.pause()
      setPlaying(false)
    }
  }

  const t = clamp(playhead, 0, total)
  // Transport shows EDITED time (cuts collapsed): map virtual playhead -> edited.
  const segShown = segs[segAt(t)]
  const editedT = segShown ? clamp(segShown.editedStart + (t - segShown.start), 0, editedTotal) : 0
  const first = segs[0]
  const srcAspect = first?.srcW && first?.srcH ? first.srcW / first.srcH : 9 / 16
  const aspect = project.aspectW && project.aspectH ? project.aspectW / project.aspectH : srcAspect
  const frame = containRect(stageSize.w, stageSize.h, aspect)
  const shownSrc = mountedSrc || first?.src || ''
  const inGap = docMode && displayIdx(t) < 0 // interior magnet-off dead space → show black (past-end shows last frame)

  // A project saved by an older build can reference browser-local media that no
  // longer exists after a reload (dead `webmedia:` ids). Say so instead of
  // rendering a silent black frame.
  const deadMedia = segs.length > 0 && segs.every((s) => mediaSrc(s.src) === '')

  if (!segs.length || deadMedia) {
    return (
      <div className="preview">
        <div className="video-wrap">
          <div className="stage">
            <div className="video-empty">
              {deadMedia
                ? 'This project’s media isn’t available anymore (saved before upload finished). Re-import the clip to continue — your edits are intact.'
                : 'No clips in the sequence'}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="preview">
      {docMode && <DocAudio doc={snap!.doc} playing={playing} playhead={playhead} />}
      <div className="video-wrap">
        <div className="stage" ref={stageRef}>
          <div className="frame" style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height, backgroundColor: '#000' }}>
            <video
              key={shownSrc}
              ref={ref}
              src={mediaSrc(shownSrc)}
              onLoadedMetadata={onLoaded}
              onLoadedData={onLoaded}
              onCanPlay={onLoaded}
              onTimeUpdate={onTimeUpdate}
              onError={onMediaError}
              onClick={() => setPlaying(!playing)}
              style={{ visibility: inGap ? 'hidden' : 'visible' }}
            />
            {frame.width > 0 && <OverlayLayer frame={{ left: 0, top: 0, width: frame.width, height: frame.height }} />}
            {frame.width > 0 && <TextLayer frame={{ left: 0, top: 0, width: frame.width, height: frame.height }} />}
          </div>
        </div>
      </div>
      <div className="transport">
        <button onClick={() => setPlaying(!playing)}>{playing ? '⏸' : '▶'}</button>
        <button onClick={() => { setPlaying(false); setPlayhead(segs[0]?.start ?? 0) }}>⏮</button>
        <span className="time">{fmt(editedT)} <span className="muted">/ {fmt(editedTotal)}</span></span>
        <input
          type="range"
          min={0}
          max={Math.max(0.1, editedTotal)}
          step={0.05}
          value={Math.min(editedT, editedTotal)}
          onChange={(e) => {
            setPlaying(false)
            const v = Number(e.target.value)
            // Doc mode: the slider IS real timeline time (gaps included), so it maps
            // straight to the playhead — dragging into dead space parks on black.
            if (docMode) {
              setPlayhead(v)
              return
            }
            // Montage: slider is packed EDITED time -> map back to the virtual domain.
            let seg = segs[segs.length - 1]
            for (const s of segs) {
              if (v < s.editedStart + s.len) {
                seg = s
                break
              }
            }
            setPlayhead(seg.start + Math.max(0, Math.min(seg.len, v - seg.editedStart)))
          }}
          style={{ flex: 1, marginLeft: 10 }}
        />
      </div>
    </div>
  )
}
