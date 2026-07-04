// The playhead line + head. Reads the (non-undoable) session playhead so it can
// move without disturbing the document or history.

import { frameToPx, HEADER_W } from './geometry'
import { useTimeline } from './TimelineContext'
import type { Timebase } from '@shared/timeline/time'

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
  const x = HEADER_W + frameToPx(session.playhead, zoom, tb)
  return (
    <div className="ec-tl-playhead" style={{ left: x, height }}>
      <div className="ec-tl-playhead-head" />
    </div>
  )
}
