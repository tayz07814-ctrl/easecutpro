// PROXY PLAYER — plays a flattened render of the current edit as ONE file.
//
// The live engine has to make a cut HAPPEN at playback time: at every seam it
// changes source position, which means a seek (find keyframe, decode forward,
// resync audio). That is why heavily cut timelines stutter no matter how fast
// the machine is — the work scales with the number of cuts, not with the CPU.
// A proxy removes the problem instead of optimising it: the removed footage is
// not in the file, so there is nothing to seek over. One decode, start to
// finish. It is the same trick Media3's CompositionPlayer uses on mobile, which
// is why that build is smooth.
//
// Deliberately a SIBLING of DocPreview, never a modification of it. This either
// takes over completely or does not mount at all, so a proxy problem can never
// degrade the engine that already works. That isolation is the whole design and
// it is worth its one real cost: the transport below duplicates DocPreview's.
// If you change one, change both — or better, only ever change DocPreview's and
// let this follow, since DocPreview is what everyone actually sees.
//
// What the proxy already contains (baked by exportProject, so NOT drawn again
// here): the cuts, B-roll overlays, Ken Burns/zoom, per-clip speed and gain,
// clip audio and music. What it does NOT contain: text overlays — those stay
// live so editing text doesn't cost a re-render.

import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { playClock, primePlayback } from '../clock'
import { previewClickSuppressed } from '../previewClickGuard'
import { mediaSrc } from '../platform'
import TextLayer from './TextLayer'

function fmt(t: number): string {
  if (!isFinite(t)) t = 0
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** Largest `aspect` box that fits in w×h, centred — the letterboxed picture. */
function containRect(w: number, h: number, aspect: number): { left: number; top: number; width: number; height: number } {
  if (!w || !h || !isFinite(aspect) || aspect <= 0) return { left: 0, top: 0, width: 0, height: 0 }
  let width = w
  let height = w / aspect
  if (height > h) {
    height = h
    width = h * aspect
  }
  return { left: (w - width) / 2, top: (h - height) / 2, width, height }
}

/** Store playhead is written at ~8 Hz (same as DocPreview) — React can't take 60. */
const STORE_HZ_MS = 125

export function ProxyPlayer({
  path,
  total,
  onFailed
}: {
  /** absolute path of the flattened render */
  path: string
  /** edited duration in seconds — proxy time IS timeline time */
  total: number
  /** decode/load failure — the caller drops back to the live engine */
  onFailed: () => void
}): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const playing = useStore((s) => s.playing)
  const setPlaying = useStore((s) => s.setPlaying)
  const playhead = useStore((s) => s.project.playhead)
  const setPlayhead = useStore((s) => s.setPlayhead)
  const setAspect = useStore((s) => s.setAspect)
  const aspectW = useStore((s) => s.project.aspectW)
  const aspectH = useStore((s) => s.project.aspectH)

  const [stageSize, setStageSize] = useState({ w: 0, h: 0 })
  const [vidAspect, setVidAspect] = useState(0)
  // The last time WE reported, so the seek effect below doesn't chase the
  // element back to a position the element itself just produced.
  const wroteRef = useRef(-1)

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setStageSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setStageSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // Play / pause follows the transport.
  useEffect(() => {
    const v = ref.current
    if (!v) return
    if (playing) void v.play().catch(() => onFailed())
    else v.pause()
  }, [playing, onFailed])

  // EXTERNAL scrubs only (timeline drag, word click). Proxy time is timeline
  // time, so this is a direct assignment with no segment mapping at all — that
  // is the entire point of flattening.
  useEffect(() => {
    const v = ref.current
    if (!v) return
    if (Math.abs(playhead - wroteRef.current) < 0.02) return // our own report, echoed back
    if (Math.abs(v.currentTime - playhead) < 0.08) return // already there
    v.currentTime = Math.max(0, Math.min(playhead, Math.max(0, total - 0.05)))
  }, [playhead, total])

  // Drive the clock FROM the element: one continuous timebase, nothing to
  // reconcile, because there are no seams left to reconcile across. playClock
  // runs at 60 Hz for the timeline's red line; the store gets ~8 Hz.
  useEffect(() => {
    const v = ref.current
    if (!v) return
    let raf = 0
    let lastStore = 0
    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick)
      const t = v.currentTime
      playClock.t = t
      if (v.paused || v.ended) return
      if (now - lastStore < STORE_HZ_MS) return
      lastStore = now
      wroteRef.current = t
      setPlayhead(t)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [setPlayhead])

  const t = Math.min(Math.max(playhead, 0), total || 0)
  // Aspect comes from the proxy itself once it loads: the file was rendered at
  // the project's aspect, so trusting it keeps picture and text in agreement.
  const frame = containRect(stageSize.w, stageSize.h, vidAspect || 16 / 9)

  return (
    <div className="preview">
      <div className="video-wrap">
        <div
          className="stage"
          ref={stageRef}
          onClick={() => {
            if (previewClickSuppressed()) return
            if (!playing) primePlayback()
            setPlaying(!playing)
          }}
        >
          <div
            className="frame"
            style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height, backgroundColor: '#000' }}
          >
            <video
              ref={ref}
              src={mediaSrc(path)}
              preload="auto"
              playsInline
              onLoadedMetadata={(e) => {
                const v = e.currentTarget
                if (v.videoWidth && v.videoHeight) setVidAspect(v.videoWidth / v.videoHeight)
                // Land where the creator was looking, not at zero.
                if (playhead > 0.05) v.currentTime = Math.min(playhead, Math.max(0, total - 0.05))
              }}
              onEnded={() => setPlaying(false)}
              onError={onFailed}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
            />
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
                className={'mini' + (aspectW === aw && aspectH === ah ? ' on toggle' : '')}
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
            setPlayhead(0)
          }}
        >
          ⏮
        </button>
        <span className="time">
          {fmt(t)} <span className="muted">/ {fmt(total)}</span>
        </span>
        <input
          type="range"
          min={0}
          max={Math.max(total, 0.1)}
          step={0.01}
          value={t}
          onChange={(e) => setPlayhead(parseFloat(e.currentTarget.value))}
        />
      </div>
    </div>
  )
}
