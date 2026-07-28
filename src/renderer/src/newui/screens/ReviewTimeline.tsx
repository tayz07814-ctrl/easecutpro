// ReviewTimeline — the redesign's editor timeline, built ENTIRELY in the new UI.
// It renders its own Text / Video / Audio lanes from the engine's public document
// and paints the staged retake cuts as adjustable RED regions on the video, so
// you see (and tune) every cut before Execute. It never imports or edits the
// shared production TimelinePanel, so main's editor is completely unaffected.
//
// Wiring: reads the live doc (useSharedEngineSnapshot) + playhead (store) + the
// staged cuts (useRetake). Dragging a red region's edge re-selects the transcript
// words inside the new range; clicking "keep" un-stages them — the same selection
// the Transcript drawer and Speech-cleaner cards drive. Pre-Execute the base clip
// is the full source, so cut source-seconds map 1:1 to timeline seconds.

import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { css } from '../css'
import { useStore } from '../../store'
import { useSharedEngineSnapshot, getSharedEngine } from '../../timelineEngine'
import { useRetake } from '../data/useRetake'
import { framesToSeconds } from '@shared/timeline/time'

const RAIL_W = 62 // lane-label gutter
const TOOL = "font-size:11.5px;padding:5px 10px;border-radius:7px;cursor:pointer;white-space:nowrap"

const mmss = (s: number): string => {
  const t = Math.max(0, s)
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`
}
const mmssT = (s: number): string => {
  const v = Math.max(0, s)
  return `${Math.floor(v / 60)}:${(v % 60).toFixed(1).padStart(4, '0')}`
}

interface Word { id: string; start: number; end: number }
interface Clip { id: string; name: string; startS: number; endS: number }
interface CutRegion { id: string; startS: number; endS: number; wordIds: string[] }

export default function ReviewTimeline(): JSX.Element {
  const snap = useSharedEngineSnapshot()
  const playhead = useStore((s) => s.project.playhead)
  const setPlayhead = useStore((s) => s.setPlayhead)
  const setShowCropModal = useStore((s) => s.setShowCropModal)
  const r = useRetake()
  const [px, setPx] = useState(46) // px per second (local zoom)
  const [magnet, setMagnet] = useState(true)
  const [snapOn, setSnapOn] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  const doc = snap?.doc
  const tb = doc?.timebase

  // Group clips into the three design lanes by kind.
  const text: Clip[] = []
  const video: Clip[] = []
  const audio: Clip[] = []
  if (doc && tb) {
    for (const tr of doc.tracks) {
      for (const c of tr.clips) {
        const clip: Clip = { id: c.id, name: c.name || 'clip', startS: framesToSeconds(c.start, tb), endS: framesToSeconds(c.start + c.duration, tb) }
        if (c.kind === 'text') text.push(clip)
        else if (c.kind === 'audio') audio.push(clip)
        else video.push(clip)
      }
    }
  }

  // Flat, time-sorted word list (for edge-drag re-selection).
  const words: Word[] = []
  for (const seg of r.segments) for (const w of seg.words) words.push({ id: w.id, start: w.start, end: w.end })

  // Staged cuts → contiguous runs of selected words (red regions on the video).
  const cuts: CutRegion[] = []
  {
    let run: CutRegion | null = null
    const flush = (): void => { if (run) { cuts.push(run); run = null } }
    for (const w of words) {
      if (r.isSelected(w.id)) {
        if (!run) run = { id: 'c:' + w.id, startS: w.start, endS: w.end, wordIds: [w.id] }
        else { run.endS = w.end; run.wordIds.push(w.id) }
      } else flush()
    }
    flush()
  }

  const totalS = Math.max(
    12,
    ...video.map((c) => c.endS),
    ...audio.map((c) => c.endS),
    ...text.map((c) => c.endS),
    ...words.map((w) => w.end)
  ) + 1.5
  const contentW = totalS * px

  // ----- interactions -----
  function scrubFromEvent(clientX: number): number {
    const el = scrollRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    const x = clientX - rect.left - RAIL_W + el.scrollLeft
    return Math.max(0, x / px)
  }
  function onScrub(e: ReactPointerEvent): void {
    if ((e.target as HTMLElement).dataset.cut) return // let cut handles win
    setPlayhead(scrubFromEvent(e.clientX))
    const move = (ev: PointerEvent): void => setPlayhead(scrubFromEvent(ev.clientX))
    const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const keepCut = (c: CutRegion): void => c.wordIds.forEach((id) => { if (r.isSelected(id)) r.selectWord(id, true) })

  // Re-select the words inside [startS,endS] so the region matches a dragged edge.
  function setRange(c: CutRegion, startS: number, endS: number): void {
    const target = new Set(words.filter((w) => w.end > startS + 0.01 && w.start < endS - 0.01).map((w) => w.id))
    const cur = new Set(c.wordIds)
    for (const id of cur) if (!target.has(id) && r.isSelected(id)) r.selectWord(id, true) // remove
    for (const id of target) if (!cur.has(id) && !r.isSelected(id)) r.selectWord(id, true) // add
  }
  function dragEdge(e: ReactPointerEvent, c: CutRegion, side: 'l' | 'r'): void {
    e.preventDefault(); e.stopPropagation()
    const move = (ev: PointerEvent): void => {
      const t = scrubFromEvent(ev.clientX)
      if (side === 'l') setRange(c, Math.min(t, c.endS - 0.15), c.endS)
      else setRange(c, c.startS, Math.max(t, c.startS + 0.15))
    }
    const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // Ruler ticks — one label per 10s, minor per 2s (scaled to keep them readable).
  const majorStep = px < 30 ? 20 : px < 60 ? 10 : 5
  const ticks: number[] = []
  for (let t = 0; t <= totalS; t += majorStep) ticks.push(t)

  const laneClip = (c: Clip, color: string, overlay?: JSX.Element): JSX.Element => (
    <div key={c.id} style={css(`position:absolute;left:${c.startS * px}px;width:${Math.max(6, (c.endS - c.startS) * px)}px;top:6px;bottom:6px;border-radius:6px;overflow:hidden;${color}`)}>
      <span style={css("position:absolute;left:7px;top:5px;font-family:'Geist Mono',monospace;font-size:9.5px;color:rgba(255,255,255,.6);white-space:nowrap;overflow:hidden;pointer-events:none")}>{c.name}</span>
      {overlay}
    </div>
  )

  return (
    <div style={css('width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden;background:#08080a')}>
      {/* toolbar */}
      <div style={css('flex:none;height:40px;display:flex;align-items:center;gap:6px;padding:0 12px;border-bottom:1px solid rgba(255,255,255,.06)')}>
        <span onClick={() => setMagnet((v) => !v)} style={css(TOOL, magnet ? 'background:rgba(124,107,255,.16);color:#a99bff;font-weight:500' : 'color:#9a9aae')}>Magnet</span>
        <span onClick={() => setSnapOn((v) => !v)} style={css(TOOL, snapOn ? 'background:rgba(124,107,255,.16);color:#a99bff;font-weight:500' : 'color:#9a9aae')}>Snap</span>
        <span style={css('width:1px;height:16px;background:rgba(255,255,255,.1);margin:0 4px')} />
        <span onClick={() => getSharedEngine()?.splitAtPlayhead()} style={css(TOOL, 'color:#c9c9da')}>Split <span style={css('color:#5c5c70')}>S</span></span>
        <span onClick={() => getSharedEngine()?.deleteSelection(true)} style={css(TOOL, 'color:#ff9b9b')}>Delete <span style={css('color:#5c5c70')}>D</span></span>
        <span onClick={() => setShowCropModal(true)} style={css(TOOL, 'color:#c9c9da')}>◱ Crop</span>
        <div style={css('flex:1')} />
        <span style={css("font-family:'Geist Mono',monospace;font-size:10.5px;color:#7a7a8c")}>PLAYHEAD {mmssT(playhead)}</span>
        {cuts.length > 0 && <span style={css("font-family:'Geist Mono',monospace;font-size:10.5px;color:#ff9b9b")}>· {cuts.length} cut{cuts.length === 1 ? '' : 's'} pending</span>}
        <span style={css('width:1px;height:16px;background:rgba(255,255,255,.1);margin:0 6px')} />
        <span onClick={() => setPx((p) => Math.max(14, p / 1.35))} style={css('width:22px;height:22px;display:grid;place-items:center;border-radius:6px;border:1px solid rgba(255,255,255,.12);color:#c9c9da;cursor:pointer;font-size:14px')}>−</span>
        <span onClick={() => setPx((p) => Math.min(240, p * 1.35))} style={css('width:22px;height:22px;display:grid;place-items:center;border-radius:6px;border:1px solid rgba(255,255,255,.12);color:#c9c9da;cursor:pointer;font-size:14px')}>＋</span>
      </div>

      {/* scroll body */}
      <div ref={scrollRef} onPointerDown={onScrub} style={css('flex:1;min-height:0;overflow-x:auto;overflow-y:hidden;position:relative')}>
        <div style={css(`position:relative;height:100%;min-width:${RAIL_W + contentW}px`)}>
          {/* lane labels (sticky gutter) */}
          <div style={css(`position:sticky;left:0;top:0;float:left;width:${RAIL_W}px;height:100%;background:#0a0a0d;border-right:1px solid rgba(255,255,255,.06);z-index:5;display:flex;flex-direction:column`)}>
            <div style={css('height:22px;flex:none;border-bottom:1px solid rgba(255,255,255,.05)')} />
            {[['Text', 34], ['Video', 76], ['Audio', 40]].map(([l, h]) => (
              <div key={l as string} style={css(`height:${h}px;flex:none;display:flex;align-items:center;padding:0 10px;font-size:10.5px;color:#7a7a8c;border-bottom:1px solid rgba(255,255,255,.04)`)}>{l}</div>
            ))}
          </div>

          {/* content */}
          <div style={css(`position:relative;margin-left:${RAIL_W}px;width:${contentW}px;height:100%`)}>
            {/* ruler */}
            <div style={css('height:22px;position:relative;border-bottom:1px solid rgba(255,255,255,.06)')}>
              {ticks.map((t) => (
                <span key={t} style={css(`position:absolute;left:${t * px}px;top:5px;font-family:'Geist Mono',monospace;font-size:9px;color:#5c5c70`)}>{mmss(t)}</span>
              ))}
            </div>
            {/* Text lane */}
            <div style={css('height:34px;position:relative;border-bottom:1px solid rgba(255,255,255,.04)')}>
              {text.map((c) => laneClip(c, 'background:rgba(124,107,255,.22);border:1px solid rgba(124,107,255,.5)'))}
            </div>
            {/* Video lane + red cut regions */}
            <div style={css('height:76px;position:relative;border-bottom:1px solid rgba(255,255,255,.04)')}>
              {video.map((c) => laneClip(c, 'background:repeating-linear-gradient(135deg,#1b1b22 0 7px,#141419 7px 14px);border:1px solid rgba(255,255,255,.09)'))}
              {cuts.map((c) => (
                <div key={c.id} data-cut="1" onClick={() => keepCut(c)} title="Click to keep · drag edges to adjust" style={css(`position:absolute;left:${c.startS * px}px;width:${Math.max(4, (c.endS - c.startS) * px)}px;top:6px;bottom:6px;border-radius:5px;background:repeating-linear-gradient(45deg,rgba(255,107,107,.42) 0 6px,rgba(255,107,107,.24) 6px 12px);border:1px solid #ff6b6b;cursor:pointer;z-index:3`)}>
                  <div data-cut="1" onPointerDown={(e) => dragEdge(e, c, 'l')} style={css('position:absolute;left:-3px;top:0;bottom:0;width:8px;cursor:ew-resize')} />
                  <div data-cut="1" onPointerDown={(e) => dragEdge(e, c, 'r')} style={css('position:absolute;right:-3px;top:0;bottom:0;width:8px;cursor:ew-resize')} />
                </div>
              ))}
            </div>
            {/* Audio lane */}
            <div style={css('height:40px;position:relative')}>
              {audio.map((c) => laneClip(c, 'background:rgba(126,214,166,.16);border:1px solid rgba(126,214,166,.4)'))}
            </div>

            {/* playhead */}
            <div style={css(`position:absolute;left:${playhead * px}px;top:0;bottom:0;width:1px;background:#ededf2;z-index:6;pointer-events:none`)}>
              <div style={css('position:absolute;left:-4px;top:0;width:9px;height:9px;background:#ededf2;border-radius:2px')} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
