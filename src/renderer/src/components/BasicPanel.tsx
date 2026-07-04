import { useStore } from '../store'
import { useSharedEngineSnapshot, getSharedEngine } from '../timelineEngine'
import { mainTrackId } from '@shared/timeline/model'
import { framesToSeconds } from '@shared/timeline/time'
import * as C from '@shared/timeline/commands'
import type { Clip } from '@shared/types'
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

/** The selected clip on the MAIN (base) lane, if the selection is one. */
function findDocMainClip(doc: TimelineDocument, id: string | null): DocClip | null {
  if (!id) return null
  const mainId = mainTrackId(doc)
  const main = mainId ? doc.tracks.find((t) => t.id === mainId) : undefined
  return main?.clips.find((c) => c.id === id) ?? null
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

  // DOCUMENT MODE: the selected overlay lives on the timeline document; edit it via
  // undoable engine commands (position/size/crop/zoom), split/delete via the engine.
  const snap = useSharedEngineSnapshot()
  const docMode = !!project.timeline && !!snap?.doc
  const docSel = docMode ? snap!.interaction.selection[0] ?? null : null
  const docClip = docMode ? findDocOverlay(snap!.doc, docSel) : null
  const docMain = docMode && !docClip ? findDocMainClip(snap!.doc, docSel) : null
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

  if (docMain) {
    const engine = getSharedEngine()
    const tb = snap!.doc.timebase
    const dur = framesToSeconds(docMain.duration, tb)
    const canDetach = docMain.hasAudio && !docMain.audioDetached
    const m = docMain.metadata ?? {}
    const place = (patch: { ovX?: number; ovY?: number; ovScale?: number; ovZoomStart?: number; ovZoomEnd?: number }): void =>
      void engine?.dispatch(C.setOverlayPlacement(docMain.id, patch))
    return (
      <div className="tool-content">
        <h4>Base clip</h4>
        <p className="muted small">
          Source {docMain.sourceIn.toFixed(2)}s – {docMain.sourceOut.toFixed(2)}s · {dur.toFixed(2)}s on the timeline
        </p>

        <h4>Size &amp; Zoom</h4>
        <div className="field-grid">
          <label>Size<input type="number" min={10} max={300} step={5}
            value={Math.round(mnum(m.ovScale, 1) * 100)}
            onChange={(e) => place({ ovScale: clampN(Number(e.target.value) / 100, 0.1, 3) })} />%</label>
          <label>Zoom start<input type="number" min={100} max={400} step={5}
            value={Math.round(mnum(m.ovZoomStart, 1) * 100)}
            onChange={(e) => place({ ovZoomStart: clampN(Number(e.target.value) / 100, 1, 4) })} />%</label>
          <label>Zoom end<input type="number" min={100} max={400} step={5}
            value={Math.round(mnum(m.ovZoomEnd, 1) * 100)}
            onChange={(e) => place({ ovZoomEnd: clampN(Number(e.target.value) / 100, 1, 4) })} />%</label>
          <label>Pan X<input type="number" min={-50} max={50} step={1}
            value={Math.round(mnum(m.ovX, 0) * 100)}
            onChange={(e) => place({ ovX: clampN(Number(e.target.value) / 100, -0.5, 0.5) })} />%</label>
          <label>Pan Y<input type="number" min={-50} max={50} step={1}
            value={Math.round(mnum(m.ovY, 0) * 100)}
            onChange={(e) => place({ ovY: clampN(Number(e.target.value) / 100, -0.5, 0.5) })} />%</label>
        </div>

        <h4>Playback</h4>
        <div className="field-grid">
          <label>Speed<input type="number" min={0.25} max={4} step={0.05}
            value={Number((docMain.speed ?? 1).toFixed(2))}
            onChange={(e) => void engine?.dispatch(C.setClipSpeed(docMain.id, clampN(Number(e.target.value), 0.25, 4)))} />×</label>
          <label>Volume<input type="number" min={0} max={200} step={5}
            value={Math.round((docMain.gain ?? 1) * 100)}
            onChange={(e) => void engine?.dispatch(C.setClipGain(docMain.id, clampN(Number(e.target.value) / 100, 0, 2)))} />%</label>
        </div>

        <div className="row" style={{ marginTop: 10 }}>
          <button onClick={() => engine?.splitAtPlayhead()}>✂ Split (S)</button>
          <button className="danger" onClick={() => engine?.deleteSelection(true)}>🗑 Delete</button>
        </div>
        {canDetach && (
          <div className="row" style={{ marginTop: 8 }}>
            <button onClick={() => void engine?.dispatch(C.detachAudio(docMain.id))}>🔉 Detach audio to its own lane</button>
          </div>
        )}
        {docMain.audioDetached && <p className="muted small">Audio is on its own lane.</p>}
        <p className="muted small">Trim by dragging the clip edges on the timeline.</p>
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
    return (
      <div className="tool-content">
        <h4>Base segment</h4>
        <p className="muted small">{seg.start.toFixed(2)}s – {seg.end.toFixed(2)}s ({seg.kind})</p>
        {seg.kind === 'cut' && (
          <p className="muted small">This part is removed from the edit — <b>Restore</b> brings the footage back.</p>
        )}

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
      <p className="muted">Select a clip on the timeline — a base clip (split / delete / detach audio) or an overlay (size, crop, position, zoom) — to edit it here.</p>
    </div>
  )
}
