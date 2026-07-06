// The playhead line + head. Reads the (non-undoable) session playhead so it can
// move without disturbing the document or history.
//
// While PLAYING it follows the shared playClock via rAF, writing style.left
// directly on the element — the store playhead only ticks at the <video>
// element's coarse ~4 Hz timeupdate cadence, which reads as a jumping slider.
// The clock is updated every frame by the preview's own rAF loop, so this stays
// perfectly in sync with what the viewer shows.

import { useEffect, useRef } from 'react'
import { frameToPx, HEADER_W } from './geometry'
import { useTimeline } from './TimelineContext'
import { playClock } from '../../clock'
import { secondsToFrames, type Timebase } from '@shared/timeline/time'
import { useStore } from '../../store'

export function Playhead({
  zoom,
  tb,
  height
}: {
  zoom: number
  tb: Timebase
  height: number
}): JSX.Element {
  const { session } = useTimeline()
  const playing = useStore((s) => s.playing)
  const el = useRef<HTMLDivElement>(null)
  const x = HEADER_W + frameToPx(session.playhead, zoom, tb)

  useEffect(() => {
    if (!playing || !el.current) return
    let raf = 0
    const loop = (): void => {
      const node = el.current
      if (node) {
        const fx = HEADER_W + frameToPx(secondsToFrames(playClock.t, tb), zoom, tb)
        node.style.left = `${fx}px`
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [playing, zoom, tb])

  return (
    <div ref={el} className="ec-tl-playhead" style={{ left: x, height }}>
      <div className="ec-tl-playhead-head" />
    </div>
  )
}
