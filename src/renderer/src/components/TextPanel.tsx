import { useStore } from '../store'
import { FONT_OPTIONS } from '@shared/types'
import type { TextClip } from '@shared/types'

export default function TextPanel(): JSX.Element {
  const project = useStore((s) => s.project)
  const addText = useStore((s) => s.addText)
  const updateText = useStore((s) => s.updateText)
  const removeText = useStore((s) => s.removeText)
  const selectedTextId = useStore((s) => s.selectedTextId)
  const hasMedia = !!project.media || ((project.baseSequence?.length ?? 0) > 0)

  const clip = (project.texts ?? []).find((t) => t.id === selectedTextId) ?? null
  const set = (patch: Partial<TextClip>): void => {
    if (clip) updateText(clip.id, patch)
  }

  return (
    <div className="tool-content">
      <div className="row" style={{ marginBottom: 10 }}>
        <button className="primary" onClick={addText} disabled={!hasMedia}>＋ Add text</button>
        {clip && <button className="danger" onClick={() => removeText(clip.id)}>🗑 Delete</button>}
      </div>

      {!clip ? (
        <p className="muted small">
          Add a text overlay, then position it by dragging in the preview. Select a text block
          (here or on the timeline) to edit it.
        </p>
      ) : (
        <>
          <textarea
            className="filler-input"
            rows={2}
            value={clip.text}
            onChange={(e) => set({ text: e.target.value })}
            spellCheck={false}
          />

          <div className="row" style={{ gap: 6, marginBottom: 8 }}>
            <select value={clip.fontFamily} onChange={(e) => set({ fontFamily: e.target.value })} style={{ flex: 1 }}>
              {FONT_OPTIONS.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
            <button className={'mini' + (clip.bold ? ' on toggle' : '')} onClick={() => set({ bold: !clip.bold })}>B</button>
            <button className={'mini' + (clip.italic ? ' on toggle' : '')} onClick={() => set({ italic: !clip.italic })}><i>I</i></button>
          </div>

          <div className="field-grid">
            <label>Size<input type="number" min={2} max={40} step={0.5}
              value={Number((clip.fontSize * 100).toFixed(1))}
              onChange={(e) => set({ fontSize: Math.max(0.02, Math.min(0.6, Number(e.target.value) / 100)) })} />%</label>
            <label>Color<input type="color" value={clip.color} onChange={(e) => set({ color: e.target.value })} /></label>
          </div>
          <div className="row" style={{ gap: 6, margin: '6px 0' }}>
            {(['left', 'center', 'right'] as const).map((a) => (
              <button key={a} className={'mini' + (clip.align === a ? ' on toggle' : '')} onClick={() => set({ align: a })}>{a}</button>
            ))}
          </div>

          <h4>Outline</h4>
          <div className="field-grid">
            <label>Thickness<input type="range" min={0} max={25} step={1}
              value={Math.round(clip.strokeWidth * 100)} onChange={(e) => set({ strokeWidth: Number(e.target.value) / 100 })} /></label>
            <label>Color<input type="color" value={clip.strokeColor} onChange={(e) => set({ strokeColor: e.target.value })} /></label>
          </div>

          <h4>
            <label className="inline-check">
              <input type="checkbox" checked={clip.bgEnabled} onChange={(e) => set({ bgEnabled: e.target.checked })} /> Background
            </label>
          </h4>
          {clip.bgEnabled && (
            <div className="field-grid">
              <label>Color<input type="color" value={clip.bgColor} onChange={(e) => set({ bgColor: e.target.value })} /></label>
              <label>Opacity<input type="range" min={0} max={100} step={5}
                value={Math.round(clip.bgOpacity * 100)} onChange={(e) => set({ bgOpacity: Number(e.target.value) / 100 })} /></label>
              <label>Radius<input type="range" min={0} max={120} step={5}
                value={Math.round(clip.bgRadius * 100)} onChange={(e) => set({ bgRadius: Number(e.target.value) / 100 })} /></label>
              <label>Padding<input type="range" min={0} max={120} step={5}
                value={Math.round(clip.bgPadding * 100)} onChange={(e) => set({ bgPadding: Number(e.target.value) / 100 })} /></label>
            </div>
          )}

          <h4>Timing</h4>
          <div className="field-grid">
            <label>Start<input type="number" min={0} step={0.1} value={clip.start.toFixed(1)}
              onChange={(e) => set({ start: Math.max(0, Number(e.target.value)) })} />s</label>
            <label>End<input type="number" min={0} step={0.1} value={clip.end.toFixed(1)}
              onChange={(e) => set({ end: Math.max(clip.start + 0.2, Number(e.target.value)) })} />s</label>
          </div>
        </>
      )}
    </div>
  )
}
