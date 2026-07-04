import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { computeKeepRanges, editedDuration, isMultiBase } from '@shared/edit'
import { baseMotionAt } from '@shared/motion'
import OverlayLayer from './OverlayLayer'
import TextLayer from './TextLayer'
import SequencePreview from './SequencePreview'
import { playClock } from '../clock'
import { mediaSrc } from '../platform'

/**
 * Plays the source media but skips over cut (deleted/removed-silence) regions,
 * so the preview reflects the edited result. Playhead is tracked in SOURCE time.
 */
export default function VideoPreview(): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)
  const mediaUrl = useStore((s) => s.mediaUrl)
  const project = useStore((s) => s.project)
  const playing = useStore((s) => s.playing)
  const setPlaying = useStore((s) => s.setPlaying)
  const setPlayhead = useStore((s) => s.setPlayhead)
  const setAspect = useStore((s) => s.setAspect)

  // Keep ranges recomputed on edit changes; used to skip during playback.
  // The waveform makes cut edges snap to energy valleys (matches the export).
  const waveform = useStore((s) => s.waveform)
  const keeps = computeKeepRanges(project, waveform)
  const keepsRef = useRef(keeps)
  keepsRef.current = keeps

  // Background music: a hidden <audio> played in EDITED time (continuous across
  // cut-skips, since the preview skips instantly).
  const music = project.music
  const audioRef = useRef<HTMLAudioElement>(null)
  const musicUrl = music?.path ? mediaSrc(music.path) : null

  // Tracks the last playhead value that ORIGINATED from the video element,
  // so the sync-effect below doesn't seek the video back to a stale playhead
  // (which previously made playback snap to the start when skipping a cut).
  const lastSyncRef = useRef(0)

  // Sync EXTERNAL playhead changes (scrub, segment click) -> video element.
  useEffect(() => {
    const v = ref.current
    if (!v) return
    if (Math.abs(project.playhead - lastSyncRef.current) < 0.05) return // video-origin
    if (Math.abs(v.currentTime - project.playhead) > 0.15) {
      v.currentTime = project.playhead
    }
    lastSyncRef.current = project.playhead
  }, [project.playhead])

  useEffect(() => {
    const v = ref.current
    if (!v) return
    if (playing) v.play().catch(() => undefined)
    else v.pause()
  }, [playing])

  function onTimeUpdate(): void {
    const v = ref.current
    if (!v) return
    // When paused/scrubbing the playhead is user-controlled; ignore stray
    // timeupdate events (e.g. mid-seek currentTime≈0) so it doesn't snap back.
    if (!playing) return
    // Cut-SKIPS are handled precisely in the rAF loop (below) now — this coarse
    // ~4Hz event only nudges the store playhead while inside kept footage.
    const t = v.currentTime
    const ranges = keepsRef.current
    const inKeep = ranges.length === 0 || ranges.find((k) => t >= k.start - 0.001 && t < k.end)
    if (inKeep) {
      lastSyncRef.current = t
      setPlayhead(t)
    }
  }

  const edited = editedDuration(project)

  // Music position within the (looped) source for a given EDITED time; <0 = silent.
  function musicPos(editedT: number): number {
    if (!music) return -1
    if (music.endAt != null && editedT >= music.endAt) return -1
    const te = editedT - music.startAt
    if (te < 0) return -1
    if (music.loop && music.duration > 0) return te % music.duration
    if (!music.loop && music.duration > 0 && te > music.duration) return -1
    return te
  }

  // Drive the music while PLAYING: follow the video's edited time at native fps.
  useEffect(() => {
    const a = audioRef.current
    const v = ref.current
    if (!a || !v || !music || !playing) return
    a.volume = Math.min(1, Math.max(0, music.gain))
    let raf = 0
    const loop = (): void => {
      const pos = musicPos(sourceToEdited(keepsRef.current, v.currentTime))
      if (pos < 0) {
        if (!a.paused) a.pause()
      } else {
        if (Math.abs(a.currentTime - pos) > 0.3) a.currentTime = pos
        if (a.paused) a.play().catch(() => undefined)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      a.pause()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, music])

  // While PAUSED / scrubbing: keep the music anchored to the playhead, silent.
  useEffect(() => {
    const a = audioRef.current
    if (!a || !music || playing) return
    a.pause()
    const pos = musicPos(sourceToEdited(keepsRef.current, project.playhead))
    if (pos >= 0) a.currentTime = pos
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, project.playhead, music])

  // Measure the stage so overlays can be positioned over the contained frame.
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

  const srcAspect =
    project.media && project.media.width && project.media.height
      ? project.media.width / project.media.height
      : 16 / 9
  const aspect = project.aspectW && project.aspectH ? project.aspectW / project.aspectH : srcAspect
  const frame = containRect(stageSize.w, stageSize.h, aspect)

  // Base Ken Burns zoom. While playing we interpolate a CONTINUOUS time from the
  // wall clock (performance.now) between the video's currentTime samples — the
  // source is often only 24–30 fps, so reading currentTime alone makes the zoom
  // step once per video frame. This re-anchors whenever currentTime advances, so
  // it tracks the real playback (and seeks) but moves smoothly every frame.
  // Deps deliberately exclude project.playhead so the rAF loop isn't torn down
  // ~4x/sec by the timeupdate-driven playhead updates.
  useEffect(() => {
    const v = ref.current
    if (!v || !playing) return
    let raf = 0
    let anchorMedia = v.currentTime
    let anchorWall = performance.now()
    let lastCt = v.currentTime
    let seekingTo = -1 // >=0 while a cut-skip seek is settling
    const loop = (): void => {
      const now = performance.now()
      const ct = v.currentTime
      const ranges = keepsRef.current

      // While a skip seek settles, hold the clock steady at the target so the
      // slider never shows the in-between (it used to overshoot then snap back).
      if (seekingTo >= 0) {
        if (ct >= seekingTo - 0.06) {
          seekingTo = -1
          anchorMedia = ct
          anchorWall = now
          lastCt = ct
        } else {
          playClock.t = seekingTo
          raf = requestAnimationFrame(loop)
          return
        }
      }

      // Precise cut skip at 60fps (vs the coarse 'timeupdate'): the instant we
      // enter a cut, jump to the next keep — no audible/visible overshoot.
      const inKeep = ranges.length === 0 ? true : ranges.find((k) => ct >= k.start - 0.001 && k.end > ct)
      if (!inKeep) {
        const next = ranges.find((k) => k.start > ct)
        if (next) {
          // Micro-gaps (<100ms, e.g. silence trims): a seek would stutter MORE
          // than just letting it play through, so only seek for real cuts.
          if (next.start - ct > 0.1) {
            lastSyncRef.current = next.start
            v.currentTime = next.start
            seekingTo = next.start
            playClock.t = next.start
            setPlayhead(next.start)
            raf = requestAnimationFrame(loop)
            return
          }
          // else fall through: keep playing, the clock follows real time.
        } else {
          v.pause()
          setPlaying(false)
          return
        }
      }

      if (ct !== lastCt) {
        anchorMedia = ct
        anchorWall = now
        lastCt = ct
      }
      let t = anchorMedia + ((now - anchorWall) / 1000) * (v.playbackRate || 1)
      if (t < ct) t = ct
      else if (t > ct + 0.06) t = ct + 0.06 // never run far ahead of real time
      // Don't let the smooth interpolation slide into a cut before the skip fires.
      if (typeof inKeep === 'object' && t > inKeep.end) t = inKeep.end
      playClock.t = t
      const m = baseMotionAt(project, t)
      v.style.transformOrigin = `${m.x * 100}% ${m.y * 100}%`
      v.style.transform = `scale(${m.zoom})`
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [playing, project.baseZooms, project.baseKeyframes])

  // Paused / scrubbing: set the zoom + pan exactly from the playhead.
  useEffect(() => {
    const v = ref.current
    if (!v || playing) return
    playClock.t = project.playhead
    const m = baseMotionAt(project, project.playhead)
    v.style.transformOrigin = `${m.x * 100}% ${m.y * 100}%`
    v.style.transform = `scale(${m.zoom})`
  }, [playing, project.playhead, project.baseZooms, project.baseKeyframes])

  // Document mode (authoritative timeline) or montage mode: use the multi-clip
  // player, which renders the document's main lane + overlays + text + audio.
  if (project.timeline || isMultiBase(project)) {
    return <SequencePreview />
  }

  return (
    <div className="preview">
      {musicUrl && <audio key={musicUrl} ref={audioRef} src={musicUrl} preload="auto" />}
      <div className="video-wrap">
        <div className="stage" ref={stageRef}>
          {mediaUrl ? (
            <div
              className="frame"
              style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
            >
              <video
                key={mediaUrl}
                ref={ref}
                src={mediaUrl}
                onTimeUpdate={onTimeUpdate}
                onClick={() => setPlaying(!playing)}
                style={{ transformOrigin: 'center center' }}
              />
              {frame.width > 0 && (
                <OverlayLayer frame={{ left: 0, top: 0, width: frame.width, height: frame.height }} />
              )}
              {frame.width > 0 && (
                <TextLayer frame={{ left: 0, top: 0, width: frame.width, height: frame.height }} />
              )}
            </div>
          ) : (
            <div className="video-empty">No media imported</div>
          )}
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
                disabled={!mediaUrl}
              >
                {label}
              </button>
            )
          )}
        </span>
        <span className="sep" />
        <button onClick={() => setPlaying(!playing)} disabled={!mediaUrl}>
          {playing ? '⏸' : '▶'}
        </button>
        <button onClick={() => setPlayhead(0)} disabled={!mediaUrl}>
          ⏮
        </button>
        <span className="time">
          {fmt(project.playhead)} <span className="muted">/ src {fmt(project.media?.duration ?? 0)}</span>
        </span>
        <span className="spacer" />
        <span className="edited">Edited length: <b>{fmt(edited)}</b></span>
      </div>
    </div>
  )
}

/** Map a SOURCE time to its position on the EDITED timeline (sum of kept ranges). */
function sourceToEdited(keeps: { start: number; end: number }[], t: number): number {
  let acc = 0
  for (const k of keeps) {
    if (t < k.start) return acc
    if (t < k.end) return acc + (t - k.start)
    acc += k.end - k.start
  }
  return acc
}

/** Rect of a `contain`-fitted frame of the given aspect inside w×h. */
function containRect(
  w: number,
  h: number,
  aspect: number
): { left: number; top: number; width: number; height: number } {
  if (w <= 0 || h <= 0) return { left: 0, top: 0, width: 0, height: 0 }
  if (w / h > aspect) {
    const width = h * aspect
    return { left: (w - width) / 2, top: 0, width, height: h }
  }
  const height = w / aspect
  return { left: 0, top: (h - height) / 2, width: w, height }
}

function fmt(t: number): string {
  if (!isFinite(t)) t = 0
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  const cs = Math.floor((t % 1) * 100)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}
