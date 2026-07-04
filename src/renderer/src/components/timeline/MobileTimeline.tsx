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
import { frameToPx, pxToFrame, TRACK_COLOR } from './geometry'
import { formatTimecode, secondsToFrames, type Timebase } from '@shared/timeline/time'
import type { Clip } from '@shared/timeline/types'

function MobileClip({
  clip,
  zoom,
  tb,
  color,
  selected,
  onSelect,
  media
}: {
  clip: Clip
  zoom: number
  tb: Timebase
  color: string
  selected: boolean
  onSelect: (id: string) => void
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
      onClick={() => onSelect(clip.id)}
    >
      {isText ? (
        <span className="ec-mtl-clip-label">{clip.name || 'Text'}</span>
      ) : (
        <>
          {(isVideo || isImage) && (
            <div className={`ec-mtl-film ${frames && frames.length ? '' : 'tex'}`}>
              {frames && frames.length > 0 && (
                <Filmstrip frames={frames} srcIn={clip.sourceIn} srcOut={clip.sourceOut} aspect={clip.srcW && clip.srcH ? clip.srcW / clip.srcH : 16 / 9} />
              )}
            </div>
          )}
          {showWave && (
            <div className={`ec-mtl-wave ${isAudio ? 'full' : ''}`}>
              {wf && <WaveformCanvas peaks={clipPeaks(wf, clip.sourceIn, clip.sourceOut)} />}
            </div>
          )}
        </>
      )}
    </div>
  )
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
  const laneWidth = Math.max(frameToPx(doc.duration + secondsToFrames(2, tb), zoom, tb), 200)
  const contentWidth = pad * 2 + laneWidth

  // scroll -> playhead. No scrollLeft write-back here (avoids the vibration loop).
  const onScroll = useCallback((): void => {
    if (programmatic.current) {
      programmatic.current = false
      return
    }
    const el = scrollRef.current
    if (!el) return
    engine.setPlayhead(Math.max(0, pxToFrame(el.scrollLeft, engine.sessionState.zoom, engine.document.timebase)))
  }, [engine])

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

  return (
    <div className="ec-mtl">
      <div className="ec-mtl-tc">{formatTimecode(session.playhead, tb)}</div>
      <div className="ec-mtl-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="ec-mtl-content" style={{ width: contentWidth }}>
          {doc.tracks.map((t) => (
            <div className="ec-mtl-lane" key={t.id} style={{ height: t.height, marginLeft: pad, width: laneWidth }}>
              {t.clips.map((c) => (
                <MobileClip
                  key={c.id}
                  clip={c}
                  zoom={zoom}
                  tb={tb}
                  color={TRACK_COLOR[t.kind]}
                  selected={interaction.selection.includes(c.id)}
                  onSelect={(id) => engine.select([id])}
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
