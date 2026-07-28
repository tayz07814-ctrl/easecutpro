// One track's lane: the horizontal strip that holds its clips.

import { ClipView } from './ClipView'
import { TRACK_COLOR, laneHeight } from './geometry'
import { useStore } from '../../store'
import { getSharedEngine } from '../../timelineEngine'
import { docSourceToEdited, docEditedToSource } from '../../docTime'
import type { Track, Clip } from '@shared/timeline/types'
import type { Timebase } from '@shared/timeline/time'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'

/** True when b picks up exactly where a left off in the SAME source at the same
 *  speed (a split, not a cut) — such joins play seamlessly and get no seam blend. */
function sourceContiguous(a: Clip, b: Clip): boolean {
  return (
    !!a.sourcePath &&
    a.sourcePath === b.sourcePath &&
    Math.abs(a.sourceOut - b.sourceIn) < 0.003 &&
    Math.abs((a.speed || 1) - (b.speed || 1)) < 1e-3
  )
}

export function TrackLane({
  track,
  width,
  zoom,
  tb,
  selection,
  waveSize,
  onClipPointerDown,
  onHandlePointerDown,
  onClipContextMenu
}: {
  track: Track
  width: number
  zoom: number
  tb: Timebase
  selection: string[]
  waveSize: number
  onClipPointerDown: (id: string, e: ReactPointerEvent) => void
  onHandlePointerDown: (id: string, edge: 'in' | 'out', e: ReactPointerEvent) => void
  onClipContextMenu: (id: string, e: ReactMouseEvent) => void
}): JSX.Element {
  const color = TRACK_COLOR[track.kind]
  const seamFade = useStore((s) => s.seamFade)
  // Staged retake cuts → red adjustable regions on the MAIN video lane. Cuts are
  // contiguous runs of struck transcript words in SOURCE seconds; the lane draws
  // clips in EDITED time, so every red band (and the drag) is mapped through
  // docSourceToEdited / docEditedToSource — that's what keeps them locked onto the
  // clips after the base is split (clip 1 / 1 b / 1 b b) instead of drifting. Wired
  // to the SAME selection the Transcript drawer + Speech-cleaner cards drive; they
  // vanish on Execute (the words become committed cuts and the selection clears).
  const selectedWordIds = useStore((s) => s.selectedWordIds)
  const twords = useStore((s) => s.project.transcript?.words)
  const selectWord = useStore((s) => s.selectWord)
  const doc = getSharedEngine()?.document

  interface Cut { id: string; s: number; e: number; ids: string[] }
  const cuts: Cut[] = []
  if (track.isMain && twords && selectedWordIds.size) {
    let run: Cut | null = null
    const flush = (): void => { if (run) { cuts.push(run); run = null } }
    for (const w of twords) {
      if (selectedWordIds.has(w.id)) {
        if (!run) run = { id: 'cut:' + w.id, s: w.start, e: w.end, ids: [w.id] }
        else { run.e = w.end; run.ids.push(w.id) }
      } else flush()
    }
    flush()
  }
  const keepCut = (c: Cut): void => c.ids.forEach((id) => { if (selectedWordIds.has(id)) selectWord(id, true) })
  const setCutRange = (c: Cut, s: number, e: number): void => {
    if (!twords) return
    const target = new Set(twords.filter((w) => w.end > s + 0.01 && w.start < e - 0.01).map((w) => w.id))
    const cur = new Set(c.ids)
    for (const id of cur) if (!target.has(id) && selectedWordIds.has(id)) selectWord(id, true)
    for (const id of target) if (!cur.has(id) && !selectedWordIds.has(id)) selectWord(id, true)
  }
  const dragCutEdge = (ev0: ReactPointerEvent, c: Cut, side: 'l' | 'r'): void => {
    ev0.preventDefault(); ev0.stopPropagation()
    const lane = (ev0.currentTarget as HTMLElement).closest('.ec-tl-lane') as HTMLElement | null
    if (!lane) return
    const rect = lane.getBoundingClientRect()
    const move = (ev: PointerEvent): void => {
      // pointer px → EDITED seconds → SOURCE seconds (words live in source time)
      const t = docEditedToSource(doc, Math.max(0, (ev.clientX - rect.left) / zoom))
      if (side === 'l') setCutRange(c, Math.min(t, c.e - 0.15), c.e)
      else setCutRange(c, c.s, Math.max(t, c.s + 0.15))
    }
    const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // Cut seams on the MAIN lane: a clip that starts right where the previous one
  // ends on the timeline but does NOT continue the same source (a real cut) gets
  // the audio seam blend — mark it so the creator can SEE where blends apply.
  const seamIds = new Set<string>()
  if (track.isMain && seamFade.enabled && seamFade.ms > 0) {
    const ordered = [...track.clips].sort((a, b) => a.start - b.start)
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1]
      const cur = ordered[i]
      const adjacent = Math.abs(prev.end - cur.start) <= 1 // frames
      if (adjacent && !sourceContiguous(prev, cur)) seamIds.add(cur.id)
    }
  }

  return (
    <div
      className={`ec-tl-lane kind-${track.kind} ${track.hidden ? 'hidden' : ''} ${track.locked ? 'locked' : ''}`}
      style={{ width, height: laneHeight(track) }}
    >
      {track.clips.map((c) => (
        <ClipView
          key={c.id}
          clip={c}
          zoom={zoom}
          tb={tb}
          color={color}
          selected={selection.includes(c.id)}
          waveSize={waveSize}
          seamMs={seamIds.has(c.id) ? seamFade.ms : 0}
          onClipPointerDown={onClipPointerDown}
          onHandlePointerDown={onHandlePointerDown}
          onClipContextMenu={onClipContextMenu}
        />
      ))}
      {cuts.map((c) => {
        // SOURCE seconds → EDITED seconds so the band sits on the real clip.
        const es = docSourceToEdited(doc, c.s)
        const ee = docSourceToEdited(doc, c.e)
        if (ee <= es) return null
        return (
          <div
            key={c.id}
            className="ec-tl-cut"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => keepCut(c)}
            title="Staged cut — click to keep it, drag an edge to adjust"
            style={{ left: es * zoom, width: Math.max(3, (ee - es) * zoom) }}
          >
            <div className="ec-tl-cut-edge l" onPointerDown={(e) => dragCutEdge(e, c, 'l')} />
            <div className="ec-tl-cut-edge r" onPointerDown={(e) => dragCutEdge(e, c, 'r')} />
          </div>
        )
      })}
    </div>
  )
}
