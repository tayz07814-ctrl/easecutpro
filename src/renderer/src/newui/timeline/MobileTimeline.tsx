// CapCut-mobile timeline: the playhead is a FIXED centre line; the content
// scrolls under it, so the frame at the centre == the playhead. Scrubbing is
// just horizontal scroll (playhead = scrollLeft -> frames); we never write
// scrollLeft back while the user is scrolling (that caused the old vibration /
// centering glitch). Same engine, model, waveforms and undo as desktop — only
// the layout + interaction differ.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useEngine, useTimeline } from './TimelineContext'
import { useMediaData, clipPeaks, type MediaData } from './MediaData'
import { WaveformCanvas } from './WaveformCanvas'
import { Filmstrip } from './Filmstrip'
import { frameToPx, pxToFrame, TRACK_COLOR, laneHeight } from './geometry'
import { formatTimecode, secondsToFrames, type Timebase } from '@shared/timeline/time'
import type { Clip, TimelineDocument } from '@shared/timeline/types'
import { useStore } from '../../store'
import { playClock } from '../../clock'

/** Timecode readout that ticks off the shared play clock during playback — the
 *  engine playhead only advances on the video's ~4Hz timeupdate and freezes on
 *  iOS, so the counter would stall even while the timeline scrolls. Isolated so
 *  only this element re-renders (~10Hz), not the whole timeline. */
// Mobile timeline palette — the app's purple theme (was CapCut teal/seagreen).
// Waveform: thin, light bright-purple lines. Base + overlay clips: dark-purple
// tint. Base + overlay lanes render 20% shorter than desktop.
const WAVE_PURPLE: [string, string, string] = ['rgba(196,181,253,0.98)', 'rgba(167,139,250,0.82)', 'rgba(196,181,253,0.98)']
function mTrackColor(kind: string): string {
  return kind === 'video' ? '#312a52' : TRACK_COLOR[kind as keyof typeof TRACK_COLOR]
}
function mLaneHeight(t: Parameters<typeof laneHeight>[0]): number {
  return t.kind === 'video' ? Math.round(laneHeight(t) * 0.8) : laneHeight(t)
}

function MobileTimecode({ playing, staticFrame, tb }: { playing: boolean; staticFrame: number; tb: Timebase }): JSX.Element {
  const [, force] = useState(0)
  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = 0
    const loop = (t: number): void => {
      if (t - last > 100) {
        force((n) => n + 1)
        last = t
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [playing])
  const frame = playing ? secondsToFrames(playClock.t, tb) : staticFrame
  return <div className="ec-mtl-tc">{formatTimecode(frame, tb)}</div>
}

function MobileClip({
  clip,
  zoom,
  tb,
  color,
  selected,
  onSelect,
  onTrim,
  media
}: {
  clip: Clip
  zoom: number
  tb: Timebase
  color: string
  selected: boolean
  onSelect: (id: string) => void
  onTrim: (id: string, edge: 'in' | 'out', e: React.PointerEvent) => void
  media: MediaData | null
}): JSX.Element {
  const left = frameToPx(clip.start, zoom, tb)
  const width = Math.max(3, frameToPx(clip.duration, zoom, tb))
  const isVideo = clip.kind === 'video' || clip.kind === 'gif'
  const isImage = clip.kind === 'image'
  const isAudio = clip.kind === 'audio'
  const isText = clip.kind === 'text' || clip.kind === 'title'
  const showWave = clip.hasAudio && !clip.audioDetached && (isVideo || isAudio)
  const wf = showWave ? media?.getWaveform(clip) ?? null : null
  const frames = isVideo || isImage ? media?.getFrames(clip) ?? null : null

  return (
    <div
      className={`ec-mtl-clip kind-${clip.kind} ${selected ? 'sel' : ''}`}
      style={{ left, width, backgroundColor: color }}
      onClick={(e) => {
        e.stopPropagation() // don't let it bubble to the background (which deselects)
        onSelect(clip.id)
      }}
    >
      {isText ? (
        <span className="ec-mtl-clip-label">{clip.name || 'Text'}</span>
      ) : (
        <>
          {(isVideo || isImage) && (
            // With a waveform below, the filmstrip takes the TOP half (`split`);
            // without audio it fills the clip.
            <div className={`ec-mtl-film ${showWave ? 'split' : ''} ${frames && frames.length ? '' : 'tex'}`}>
              {frames && frames.length > 0 && (
                <Filmstrip frames={frames} srcIn={clip.sourceIn} srcOut={clip.sourceOut} aspect={clip.srcW && clip.srcH ? clip.srcW / clip.srcH : 16 / 9} />
              )}
            </div>
          )}
          {showWave && (
            // Audio clips: waveform fills. Video clips: waveform in the BOTTOM half,
            // under the filmstrip (no overlap).
            <div className={`ec-mtl-wave ${isAudio ? 'full' : ''}`}>
              {wf && <WaveformCanvas peaks={clipPeaks(wf, clip.sourceIn, clip.sourceOut)} colors={WAVE_PURPLE} barW={1.4} step={3} />}
            </div>
          )}
        </>
      )}
      {/* Trim handles belong to the SELECTED clip only — otherwise every clip
          shows white grips, which reads as clutter (and invites mis-trims). */}
      {selected && (
        <>
          <div className="ec-mtl-handle l" onPointerDown={(e) => onTrim(clip.id, 'in', e)} />
          <div className="ec-mtl-handle r" onPointerDown={(e) => onTrim(clip.id, 'out', e)} />
        </>
      )}
    </div>
  )
}

/** Mobile lane set, CapCut-style: main video first, then populated lanes
 *  (overlays etc. with content), then ONE text lane and ONE audio lane —
 *  extra empty lanes don't exist on a phone until something needs them. */
function mobileLanes(tracks: TimelineDocument['tracks']): TimelineDocument['tracks'] {
  const main = tracks.filter((t) => t.isMain)
  const populated = tracks.filter((t) => !t.isMain && t.clips.length > 0)
  const order = (k: string): number => (k === 'text' ? 1 : k === 'audio' ? 2 : 0)
  const out = [...main, ...[...populated].sort((a, b) => order(a.kind) - order(b.kind))]
  if (!populated.some((t) => t.kind === 'text')) {
    const firstText = tracks.find((t) => t.kind === 'text' && !t.clips.length)
    if (firstText) out.push(firstText)
  }
  if (!populated.some((t) => t.kind === 'audio')) {
    const firstAudio = tracks.find((t) => t.kind === 'audio' && !t.clips.length)
    if (firstAudio) out.push(firstAudio)
  }
  return out
}

export default function MobileTimeline(): JSX.Element {
  const engine = useEngine()
  const { doc, session, interaction } = useTimeline()
  const tb = doc.timebase
  const zoom = session.zoom
  const media = useMediaData()

  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewW, setViewW] = useState(360)
  const programmatic = useRef(false)
  const didInit = useRef(false)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = (): void => setViewW(el.clientWidth)
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])

  const pad = viewW / 2
  // While trimming, render the engine's live preview so the edge follows the finger.
  const activeDoc = interaction.drag?.preview ?? doc
  const laneWidth = Math.max(frameToPx(doc.duration + secondsToFrames(2, tb), zoom, tb), 200)
  const contentWidth = pad * 2 + laneWidth

  // Touch-drag a clip edge to trim it (drives the engine's trim; commits on release).
  const beginTrim = useCallback(
    (clipId: string, edge: 'in' | 'out', e: React.PointerEvent): void => {
      e.stopPropagation()
      e.preventDefault()
      const el = scrollRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const frameAt = (clientX: number): number =>
        pxToFrame(clientX - rect.left + el.scrollLeft - pad, engine.sessionState.zoom, engine.document.timebase)
      engine.beginDrag(edge === 'in' ? 'trimIn' : 'trimOut', clipId, frameAt(e.clientX))
      const onMove = (ev: PointerEvent): void => engine.updateDrag(frameAt(ev.clientX))
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        engine.endDrag()
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [engine, pad]
  )

  const playing = useStore((s) => s.playing)

  // scroll -> playhead — rAF-throttled so a fast swipe (100+ scroll events/s)
  // doesn't hammer the engine/store/DocPreview with a seek per pixel. The
  // latest scrollLeft is latched and flushed once per frame; pause is coalesced.
  const scrubRaf = useRef(0)
  const pendingScroll = useRef<number | null>(null)
  const didPauseForScrub = useRef(false)
  const flushScrub = useCallback((): void => {
    scrubRaf.current = 0
    const left = pendingScroll.current
    pendingScroll.current = null
    if (left == null) return
    if (!didPauseForScrub.current && useStore.getState().playing) {
      useStore.getState().setPlaying(false)
      didPauseForScrub.current = true
    }
    engine.setPlayhead(Math.max(0, pxToFrame(left, engine.sessionState.zoom, engine.document.timebase)))
  }, [engine])
  const onScroll = useCallback((): void => {
    if (programmatic.current) {
      programmatic.current = false
      return
    }
    const el = scrollRef.current
    if (!el) return
    pendingScroll.current = el.scrollLeft
    if (scrubRaf.current) return
    scrubRaf.current = requestAnimationFrame(flushScrub)
  }, [flushScrub])
  // reset pause-coalesce when playback resumes via button
  useEffect(() => { if (playing) didPauseForScrub.current = false }, [playing])
  useEffect(() => () => { if (scrubRaf.current) cancelAnimationFrame(scrubRaf.current) }, [])

  // During PLAYBACK, scroll the timeline so the centre line tracks the playing
  useEffect(() => {
    if (!playing) return
    const el = scrollRef.current
    if (!el) return
    let raf = 0
    const loop = (): void => {
      const target = frameToPx(secondsToFrames(playClock.t, tb), zoom, tb)
      if (Math.abs(el.scrollLeft - target) > 0.5) {
        programmatic.current = true
        el.scrollLeft = target
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [playing, zoom, tb])

  // iOS fallback: also follow the STORE playhead (updated by the video's
  // timeupdate) so the timeline still tracks if the 60fps rAF above is starved
  // during inline video playback on Safari.
  useEffect(() => {
    if (!playing) return
    const el = scrollRef.current
    if (!el) return
    const target = frameToPx(session.playhead, zoom, tb)
    if (Math.abs(el.scrollLeft - target) > 0.5) {
      programmatic.current = true
      el.scrollLeft = target
    }
  }, [playing, session.playhead, zoom, tb])

  // Re-anchor scroll to the playhead ONLY when zoom changes (keeps the centred
  // frame put across a pinch). Never fires from a plain scroll.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const target = frameToPx(session.playhead, zoom, tb)
    if (Math.abs(el.scrollLeft - target) > 1.5) {
      programmatic.current = true
      el.scrollLeft = target
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom])

  // Initial centre once the viewport is measured.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || viewW === 0 || didInit.current) return
    didInit.current = true
    programmatic.current = true
    el.scrollLeft = frameToPx(engine.sessionState.playhead, engine.sessionState.zoom, engine.document.timebase)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewW])

  const px = useStore((s) => s.project.pxPerSec)

  return (
    <div className="ec-mtl">
      <MobileTimecode playing={playing} staticFrame={session.playhead} tb={tb} />
      <div
        className="ec-mtl-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        // Tapping empty space (a click that didn't hit a clip — clips stopPropagation)
        // drops the selection, so the dock falls back to Import + Cut Lord.
        onClick={() => engine.clearSelection()}
      >
        <div className="ec-mtl-content" style={{ width: contentWidth }}>
          {mobileLanes(activeDoc.tracks).map((t) => (
            <div className="ec-mtl-lane" key={t.id} style={{ height: mLaneHeight(t), marginLeft: pad, width: laneWidth }}>
              {!t.clips.length && (t.kind === 'text' || t.kind === 'audio') && (
                <button
                  className="ec-mtl-addlane"
                  style={{ marginLeft: -pad }}
                  onClick={(e) => {
                    e.stopPropagation()
                    window.dispatchEvent(new CustomEvent('ec:sheet', { detail: t.kind === 'text' ? 'text' : 'music' }))
                  }}
                >
                  ＋ {t.kind === 'text' ? 'Add text' : 'Add music'}
                </button>
              )}
              {t.clips.map((c) => (
                <MobileClip
                  key={c.id}
                  clip={c}
                  zoom={zoom}
                  tb={tb}
                  color={mTrackColor(t.kind)}
                  selected={interaction.selection.includes(c.id)}
                  onSelect={(id) => engine.select([id])}
                  onTrim={beginTrim}
                  media={media}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="ec-mtl-centerline" />
    </div>
  )
}
