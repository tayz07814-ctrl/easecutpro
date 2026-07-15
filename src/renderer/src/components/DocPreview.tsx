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
import { playClock, easeInOut, primePlayback } from '../clock'
import { useSharedEngineSnapshot } from '../timelineEngine'
import { framesToSeconds } from '@shared/timeline/time'
import { mainTrackId } from '@shared/timeline/model'
import type { TimelineDocument, Clip as DocClip } from '@shared/timeline/types'
import { resolveMedia, MISSING_MEDIA_MESSAGE } from '../media/resolver'
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

// Anti-click seam fade for the LIVE preview — matches the export: a SINGLE, very
// subtle fade-in (~8ms) only at the START of the clip that follows a real cut, and
// NEVER a fade-out on the outgoing tail. Fading both sides audibly eats the words on
// either edge of the cut; a short incoming ramp is enough to soften the splice/seek
// click. Seamless same-source joins (splits) are left untouched. Returns 0..1 gain.
const SEAM_FADE_S = 0.008
// TEMP (retake testing): omit the seam fade entirely — the preview plays hard cuts
// with NO volume ramp so the raw retake cuts can be judged on their own. Flip back
// to true to re-enable the subtle post-cut fade-in.
const SEAM_FADE_ENABLED = false
function seamContiguous(a: Seg, b: Seg): boolean {
  return a.src === b.src && Math.abs(a.sourceEnd - b.sourceStart) < 0.003
}
function seamGain(t: number, di: number, ss: Seg[], fade = SEAM_FADE_S): number {
  const seg = ss[di]
  if (!seg) return 1
  const prev = ss[di - 1]
  // Fade IN only, at the start of a post-cut segment. No outgoing-tail fade.
  if (SEAM_FADE_ENABLED && prev && !seamContiguous(prev, seg)) {
    const d = t - seg.start // seconds since this segment's (cut) start
    if (d < fade) return Math.max(0, Math.sin((Math.max(0, d) / fade) * (Math.PI / 2)))
  }
  return 1
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
      ovScale: typeof c.metadata?.ovScale === 'number' ? c.metadata.ovScale : 1,
      ovZoomStart: typeof c.metadata?.ovZoomStart === 'number' ? c.metadata.ovZoomStart : 1,
      ovZoomEnd: typeof c.metadata?.ovZoomEnd === 'number' ? c.metadata.ovZoomEnd : 1,
      ovX: typeof c.metadata?.ovX === 'number' ? c.metadata.ovX : 0,
      ovY: typeof c.metadata?.ovY === 'number' ? c.metadata.ovY : 0,
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
  return <audio ref={ref} src={resolveMedia(clip.sourcePath as string).url} preload="auto" />
}

/** Per-element seek in flight: don't re-issue every frame; watchdog re-derives. */
interface Pending {
  target: number
  since: number
}

export default function DocPreview({ doc }: { doc: TimelineDocument }): JSX.Element {
  const project = useStore((s) => s.project)
  const playing = useStore((s) => s.playing)
  const setPlaying = useStore((s) => s.setPlaying)
  const playhead = useStore((s) => s.project.playhead)
  const setPlayhead = useStore((s) => s.setPlayhead)
  const setAspect = useStore((s) => s.setAspect)

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

  const { segs, missing } = docSegments(doc)
  const sources = useMemo(() => [...new Set(segs.map((s) => s.src))], [segs.map((s) => s.src).join('|')])
  const urlOf = new Map(segs.map((s) => [s.src, s.url]))
  const total = segs.length ? segs[segs.length - 1].start + segs[segs.length - 1].len : 0

  // ---- refs the reconciler reads (fresh every render) ----
  const segsRef = useRef(segs)
  segsRef.current = segs
  const totalRef = useRef(total)
  totalRef.current = total
  const playingRef = useRef(playing)
  playingRef.current = playing

  // element pool: source path -> <video> (callback refs fill it)
  const poolRef = useRef(new Map<string, HTMLVideoElement>())
  const pendingRef = useRef(new Map<string, Pending>())
  const badRef = useRef(new Set<string>()) // sources that fired 'error'

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
    }
  }, [playhead])

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

  /** Issue a seek on `v` toward `want`, once, with first-frame-decode nudges. */
  function seek(v: HTMLVideoElement, src: string, want: number): void {
    if (isFinite(v.duration) && v.duration > 0) want = Math.min(want, v.duration - 0.05)
    // A fresh element at 0 shows NO decoded frame and writing 0 again is a
    // no-op (no 'seeked' → black until scrub) — nudge a hair past 0.
    if (want <= 0.001) want = Math.min(0.033, Math.max(0.001, (v.duration || 1) - 0.05))
    const p = pendingRef.current.get(src)
    if (p && Math.abs(p.target - want) < 0.05) return // that seek is in flight
    if (Math.abs(v.currentTime - want) < 0.02) {
      // Same position: force a decode anyway (fresh element parked on its own
      // currentTime still needs a real seek to paint).
      v.currentTime = want > 0.05 ? want - 0.03 : want + 0.03
    }
    pendingRef.current.set(src, { target: want, since: performance.now() })
    v.currentTime = want
  }

  /** Has the in-flight seek (if any) on src landed? Watchdog clears stalls. */
  function settled(v: HTMLVideoElement, src: string): boolean {
    const p = pendingRef.current.get(src)
    if (!p) return true
    if (Math.abs(v.currentTime - p.target) <= 0.08 || v.currentTime >= p.target - 0.06) {
      pendingRef.current.delete(src)
      return true
    }
    if (performance.now() - p.since > 800) {
      pendingRef.current.delete(src) // decoder stall / clamped target: self-heal
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
      const ss = segsRef.current
      const pool = poolRef.current
      const isPlaying = playingRef.current

      if (!ss.length) {
        playClock.t = tRef.current
        raf = requestAnimationFrame(loop)
        return
      }

      let t = tRef.current
      const covIdx = segAtTime(t)
      const active = covIdx >= 0 ? ss[covIdx] : undefined

      if (isPlaying) {
        if (active && !badRef.current.has(active.src)) {
          const v = pool.get(active.src)
          if (v) {
            const want = active.sourceStart + (t - active.start) * active.speed
            // element far from where the timeline says we are → seek it
            if (settled(v, active.src) && Math.abs(v.currentTime - want) > 0.25) {
              seek(v, active.src, want)
            }
            if (v.paused) v.play().catch(() => undefined)
            if (settled(v, active.src)) {
              // element is the clock: map its time back to the timeline
              t = active.start + clamp((v.currentTime - active.sourceStart) / active.speed, 0, active.len)
            } else {
              const p = pendingRef.current.get(active.src)
              if (p) t = active.start + clamp((p.target - active.sourceStart) / active.speed, 0, active.len)
            }
            // Pre-warm the NEXT source's decoder BEFORE the seam so crossing to a
            // different file plays through instead of stalling on a cold seek.
            {
              const up = ss[covIdx + 1]
              if (
                up &&
                up.src !== active.src &&
                !badRef.current.has(up.src) &&
                t >= active.start + active.len - PREWARM_LEAD_S
              ) {
                const uv = pool.get(up.src)
                if (uv && settled(uv, up.src) && Math.abs(uv.currentTime - up.sourceStart) > 0.12) {
                  seek(uv, up.src, up.sourceStart)
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
                  const microSameFile =
                    next.src === active.src &&
                    next.sourceStart - active.sourceEnd >= 0 &&
                    next.sourceStart - active.sourceEnd <= 0.12
                  if (!microSameFile) {
                    const nv = pool.get(next.src)
                    // Already pre-warmed at the seam? just play it — a redundant
                    // re-seek would re-stall the freshly-decoded element.
                    const warm =
                      !!nv && settled(nv, next.src) && Math.abs(nv.currentTime - next.sourceStart) < 0.15
                    if (nv && !warm) seek(nv, next.src, next.sourceStart)
                    if (nv && warm && nv.paused) nv.play().catch(() => undefined)
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
            const nv = pool.get(seg.src)
            if (nv && !badRef.current.has(seg.src)) seek(nv, seg.src, seg.sourceStart + (t - seg.start) * seg.speed)
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
        // PAUSED: park every element; the active one on the exact frame
        const di = displayIdxAt(t)
        for (const [src, v] of pool) {
          if (!v.paused) v.pause()
          if (di >= 0 && ss[di].src === src && !badRef.current.has(src)) {
            const seg = ss[di]
            const want = seg.sourceStart + clamp(t - seg.start, 0, seg.len) * seg.speed
            if (settled(v, src) && Math.abs(v.currentTime - want) > 0.03) seek(v, src, want)
          }
        }
      }

      tRef.current = t
      playClock.t = t

      // ---- visibility + per-clip properties, every frame (cheap, idempotent) ----
      const di = displayIdxAt(t)
      const shown = di >= 0 ? ss[di] : undefined
      for (const [src, v] of pool) {
        const isShown = !!shown && shown.src === src && !badRef.current.has(src)
        v.style.visibility = isShown ? 'visible' : 'hidden'
        if (isShown && shown) {
          v.muted = shown.muted === true
          // Anti-click: dip the volume toward 0 across each real cut seam.
          v.volume = clamp((shown.gain ?? 1) * seamGain(t, di, ss), 0, 1)
          v.playbackRate = clamp(shown.speed, 0.25, 4)
          const size = shown.ovScale ?? 1
          const zs = shown.ovZoomStart ?? 1
          const ze = shown.ovZoomEnd ?? 1
          const prog = shown.len > 0 ? clamp((t - shown.start) / shown.len, 0, 1) : 0
          const scale = size * (zs + (ze - zs) * easeInOut(prog))
          v.style.transformOrigin = `${50 + (shown.ovX ?? 0) * 100}% ${50 + (shown.ovY ?? 0) * 100}%`
          v.style.transform = Math.abs(scale - 1) > 0.001 ? `scale(${scale})` : ''
        } else if (!isShown && !v.paused && isPlaying && shown?.src !== src) {
          v.pause() // never let a hidden element keep playing audio
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
            className="frame"
            style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height, backgroundColor: '#000' }}
          >
            {sources.map((src) => (
              <video
                key={src}
                src={urlOf.get(src)}
                preload="auto"
                playsInline
                data-ec-base
                style={{ visibility: 'hidden', position: 'absolute', inset: 0, width: '100%', height: '100%' }}
                onError={() => badRef.current.add(src)}
                ref={(el) => {
                  if (el) poolRef.current.set(src, el)
                  else {
                    poolRef.current.delete(src)
                    pendingRef.current.delete(src)
                    badRef.current.delete(src)
                  }
                }}
              />
            ))}
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
