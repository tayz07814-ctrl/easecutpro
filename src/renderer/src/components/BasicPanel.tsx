import { useStore } from '../store'
import { useSharedEngineSnapshot, getSharedEngine } from '../timelineEngine'
import { mainTrackId } from '@shared/timeline/model'
import * as C from '@shared/timeline/commands'
import type { Clip, Ease } from '@shared/types'
import type { Clip as DocClip, TimelineDocument } from '@shared/timeline/types'

function cropOf(c: Clip): { l: number; t: number; r: number; b: number } {
  return c.crop ?? { l: 0, t: 0, r: 0, b: 0 }
}
const pctIn = (v: string): number => Math.max(0, Math.min(0.9, Number(v) / 100))
const pctIn01 = (v: string): number => Math.max(0, Math.min(1, Number(v) / 100))
const clampN = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
const mnum = (v: unknown, d: number): number => (typeof v === 'number' ? v : d)

/** The selected overlay clip on the authoritative document (non-main video/image lane). */
function findDocOverlay(doc: TimelineDocument, id: string | null): DocClip | null {
  if (!id) return null
  const mainId = mainTrackId(doc)
  for (const t of doc.tracks) {
    if (t.kind !== 'video' || t.isMain || t.id === mainId) continue
    const c = t.clips.find((cl) => cl.id === id)
    if (c) return c
  }
  return null
}

/** Basic tab: transform controls for the selected overlay clip / base segment. */
export default function BasicPanel(): JSX.Element {
  const project = useStore((s) => s.project)
  const selectedClipId = useStore((s) => s.selectedClipId)
  const selectedSeg = useStore((s) => s.selectedSeg)
  const updateClip = useStore((s) => s.updateClip)
  const removeClip = useStore((s) => s.removeClip)
  const selectClip = useStore((s) => s.selectClip)
  const selectSeg = useStore((s) => s.selectSeg)
  const deleteBaseRange = useStore((s) => s.deleteBaseRange)
  const setBaseKeepOverride = useStore((s) => s.setBaseKeepOverride)
  const splitBaseAtPlayhead = useStore((s) => s.splitBaseAtPlayhead)
  const splitAtPlayhead = useStore((s) => s.splitAtPlayhead)
  const setBaseZoom = useStore((s) => s.setBaseZoom)
  const addBaseKeyframe = useStore((s) => s.addBaseKeyframe)
  const updateBaseKeyframe = useStore((s) => s.updateBaseKeyframe)
  const removeBaseKeyframe = useStore((s) => s.removeBaseKeyframe)
  const setPlayhead = useStore((s) => s.setPlayhead)

  // DOCUMENT MODE: the selected overlay lives on the timeline document; edit it via
  // undoable engine commands (position/size/crop/zoom), split/delete via the engine.
  const snap = useSharedEngineSnapshot()
  const docMode = !!project.timeline && !!snap?.doc
  const docSel = docMode ? snap!.interaction.selection[0] ?? null : null
  const docClip = docMode ? findDocOverlay(snap!.doc, docSel) : null
  if (docClip) {
    const engine = getSharedEngine()
    const m = docClip.metadata ?? {}
    const crop = docClip.crop
    const place = (patch: { ovX?: number; ovY?: number; ovScale?: number; ovZoomStart?: number; ovZoomEnd?: number }): void =>
      void engine?.dispatch(C.setOverlayPlacement(docClip.id, patch))
    const setCrop = (patch: { left?: number; top?: number; right?: number; bottom?: number }): void =>
      void engine?.dispatch(C.setOverlayCrop(docClip.id, patch))
    return (
      <div className="tool-content">
        <h4>Overlay clip</h4>
        <div className="field-grid">
          <label>Position X<input type="number" min={-30} max={130} step={1}
            value={Math.round(mnum(m.ovX, 0) * 100)} onChange={(e) => place({ ovX: Number(e.target.value) / 100 })} />%</label>
          <label>Position Y<input type="number" min={-30} max={130} step={1}
            value={Math.round(mnum(m.ovY, 0) * 100)} onChange={(e) => place({ ovY: Number(e.target.value) / 100 })} />%</label>
          <label>Size<input type="number" min={5} max={160} step={1}
            value={Math.round(mnum(m.ovScale, 0.45) * 100)} onChange={(e) => place({ ovScale: clampN(Number(e.target.value) / 100, 0.05, 1.6) })} />%</label>
        </div>
        <h4>Crop</h4>
        <div className="slider-grid">
          {([['left', 'Left'], ['right', 'Right'], ['top', 'Top'], ['bottom', 'Bottom']] as const).map(([k, label]) => (
            <label key={k} className="slider-row">
              <span className="slabel">{label}</span>
              <input type="range" min={0} max={90} step={1} value={Math.round(crop[k] * 100)}
                onChange={(e) => setCrop({ [k]: pctIn(e.target.value) })} />
              <span className="val">{Math.round(crop[k] * 100)}%</span>
            </label>
          ))}
        </div>
        <h4>Zoom (Ken Burns)</h4>
        <div className="field-grid">
          <label>Start<input type="number" min={100} max={400} step={5} value={Math.round(mnum(m.ovZoomStart, 1) * 100)}
            onChange={(e) => place({ ovZoomStart: clampN(Number(e.target.value) / 100, 1, 4) })} />%</label>
          <label>End<input type="number" min={100} max={400} step={5} value={Math.round(mnum(m.ovZoomEnd, 1) * 100)}
            onChange={(e) => place({ ovZoomEnd: clampN(Number(e.target.value) / 100, 1, 4) })} />%</label>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button onClick={() => engine?.splitAtPlayhead()}>✂ Split (S)</button>
          <button className="danger" onClick={() => engine?.deleteSelection(false)}>🗑 Delete</button>
        </div>
      </div>
    )
  }

  const clip = selectedClipId
    ? project.tracks.flatMap((t) => t.clips).find((c) => c.id === selectedClipId) ?? null
    : null

  if (clip) {
    const crop = cropOf(clip)
    const set = (patch: Partial<Clip>): void => updateClip(clip.id, patch)
    return (
      <div className="tool-content">
        <h4>Overlay clip</h4>

        <div className="field-grid">
          <label>Position X<input type="number" min={-30} max={130} step={1}
            value={Math.round(clip.x * 100)} onChange={(e) => set({ x: Number(e.target.value) / 100 })} />%</label>
          <label>Position Y<input type="number" min={-30} max={130} step={1}
            value={Math.round(clip.y * 100)} onChange={(e) => set({ y: Number(e.target.value) / 100 })} />%</label>
          <label>Size<input type="number" min={5} max={160} step={1}
            value={Math.round(clip.scale * 100)} onChange={(e) => set({ scale: Math.max(0.05, Math.min(1.6, Number(e.target.value) / 100)) })} />%</label>
        </div>

        <h4>Crop</h4>
        <div className="slider-grid">
          {([['l', 'Left'], ['r', 'Right'], ['t', 'Top'], ['b', 'Bottom']] as const).map(([k, label]) => (
            <label key={k} className="slider-row">
              <span className="slabel">{label}</span>
              <input
                type="range"
                min={0}
                max={90}
                step={1}
                value={Math.round(crop[k] * 100)}
                onChange={(e) => set({ crop: { ...crop, [k]: pctIn(e.target.value) } })}
              />
              <span className="val">{Math.round(crop[k] * 100)}%</span>
            </label>
          ))}
        </div>

        <h4>Zoom (Ken Burns)</h4>
        <div className="field-grid">
          <label>Start<input type="number" min={100} max={400} step={5} value={Math.round((clip.zoomStart ?? 1) * 100)}
            onChange={(e) => set({ zoomStart: Math.max(1, Math.min(4, Number(e.target.value) / 100)) })} />%</label>
          <label>End<input type="number" min={100} max={400} step={5} value={Math.round((clip.zoomEnd ?? 1) * 100)}
            onChange={(e) => set({ zoomEnd: Math.max(1, Math.min(4, Number(e.target.value) / 100)) })} />%</label>
        </div>
        <p className="muted small">Tip: Start 100 → End 130 pushes in; 150 → 100 pulls out.</p>

        <div className="row" style={{ marginTop: 10 }}>
          <button onClick={() => splitAtPlayhead()}>✂ Split (S)</button>
          <button className="danger" onClick={() => { removeClip(clip.id); selectClip(null) }}>🗑 Delete (D)</button>
        </div>
      </div>
    )
  }

  if (selectedSeg) {
    const seg = selectedSeg
    const bz = (project.baseZooms ?? []).find(
      (z) => Math.abs(z.start - seg.start) < 0.03 && Math.abs(z.end - seg.end) < 0.03
    )
    const zStart = bz?.zoomStart ?? 1
    const zEnd = bz?.zoomEnd ?? 1
    const kfs = project.baseKeyframes ?? []
    return (
      <div className="tool-content">
        <h4>Base segment</h4>
        <p className="muted small">{seg.start.toFixed(2)}s – {seg.end.toFixed(2)}s ({seg.kind})</p>
        {seg.kind === 'cut' && (
          <p className="muted small">This part is removed from the edit — <b>Restore</b> brings the footage back.</p>
        )}

        <h4>Zoom (Ken Burns)</h4>
        <div className="field-grid">
          <label>Start<input type="number" min={100} max={400} step={5} value={Math.round(zStart * 100)}
            onChange={(e) => setBaseZoom(seg.start, seg.end, Math.max(1, Math.min(4, Number(e.target.value) / 100)), zEnd)} />%</label>
          <label>End<input type="number" min={100} max={400} step={5} value={Math.round(zEnd * 100)}
            onChange={(e) => setBaseZoom(seg.start, seg.end, zStart, Math.max(1, Math.min(4, Number(e.target.value) / 100)))} />%</label>
        </div>
        <p className="muted small">Punch-in on the main video for this segment. 150 → 100 zooms out.</p>

        <h4>Keyframes (CapCut-style zoom + pan)</h4>
        <p className="muted small">
          Add <b>2+</b> keyframes for a zoom/pan move (a single one is ignored, so it won't disable your
          start/end zoom). Keyframes drive motion only between the first and last; elsewhere the start/end
          zoom applies. Set each keyframe&apos;s zoom &amp; focal point (50% = centre).
        </p>
        <div className="row">
          <button onClick={addBaseKeyframe}>◆ Add keyframe at playhead</button>
          {kfs.length > 0 && (
            <span className="muted small">{kfs.length} keyframe{kfs.length > 1 ? 's' : ''}</span>
          )}
        </div>
        {kfs.map((k, i) => (
          <div
            key={i}
            style={{ display: 'grid', gridTemplateColumns: '48px 1fr 1fr 1fr auto auto', gap: 6, alignItems: 'center', marginTop: 6 }}
          >
            <button onClick={() => setPlayhead(k.t)} title="Jump to this keyframe" style={{ padding: '2px 4px' }}>
              {k.t.toFixed(1)}s
            </button>
            <label className="muted small">Z<input type="number" min={100} max={400} step={5}
              value={Math.round(k.zoom * 100)}
              onChange={(e) => updateBaseKeyframe(i, { zoom: Math.max(1, Math.min(4, Number(e.target.value) / 100)) })} />%</label>
            <label className="muted small">X<input type="number" min={0} max={100} step={1}
              value={Math.round(k.x * 100)}
              onChange={(e) => updateBaseKeyframe(i, { x: pctIn01(e.target.value) })} />%</label>
            <label className="muted small">Y<input type="number" min={0} max={100} step={1}
              value={Math.round(k.y * 100)}
              onChange={(e) => updateBaseKeyframe(i, { y: pctIn01(e.target.value) })} />%</label>
            <select value={k.ease} onChange={(e) => updateBaseKeyframe(i, { ease: e.target.value as Ease })}>
              <option value="linear">Linear</option>
              <option value="in">Ease in</option>
              <option value="out">Ease out</option>
              <option value="inout">Ease in-out</option>
            </select>
            <button className="danger" title="Delete keyframe" onClick={() => removeBaseKeyframe(i)} style={{ padding: '2px 6px' }}>✕</button>
          </div>
        ))}

        <div className="row" style={{ marginTop: 10 }}>
          <button onClick={() => splitBaseAtPlayhead()}>✂ Split (S)</button>
          {seg.kind === 'keep' && (
            <button className="danger" onClick={() => { deleteBaseRange(seg.start, seg.end); selectSeg(null) }}>🗑 Delete (D)</button>
          )}
          {seg.kind === 'cut' && (
            <button
              onClick={() => { setBaseKeepOverride(seg.start, seg.end, { start: seg.start, end: seg.end }); selectSeg(null) }}
              title="Bring this removed segment back into the video"
            >
              ↩ Restore (R)
            </button>
          )}
          <button onClick={() => selectSeg(null)}>Deselect</button>
        </div>
      </div>
    )
  }

  return (
    <div className="tool-content">
      <p className="muted">Select an overlay clip or base segment on the timeline to edit its size, crop, position, and zoom here.</p>
    </div>
  )
}
