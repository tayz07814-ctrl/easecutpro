import { useStore } from '../store'
import { mediaSrc } from '../platform'
import type { OverlayAnimation, OverlayPosition } from '@shared/types'

const POSITIONS: OverlayPosition[] = [
  'top_center', 'center', 'bottom_center', 'top_left', 'top_right', 'bottom_left', 'bottom_right'
]
const ANIMS: OverlayAnimation[] = ['none', 'pop', 'fade']

/** Author overlay images + natural-language placement rules; run AI placement. */
export default function OverlayPanel(): JSX.Element {
  const assets = useStore((s) => s.project.overlayAssets ?? [])
  const rules = useStore((s) => s.project.overlayRules ?? [])
  const library = useStore((s) => s.library)
  const job = useStore((s) => s.job)
  const overlayLog = useStore((s) => s.overlayLog)
  const addOverlayAsset = useStore((s) => s.addOverlayAsset)
  const updateOverlayRule = useStore((s) => s.updateOverlayRule)
  const removeOverlayAsset = useStore((s) => s.removeOverlayAsset)
  const generateOverlays = useStore((s) => s.generateOverlays)
  const clearGeneratedOverlays = useStore((s) => s.clearGeneratedOverlays)

  const used = new Set(assets.map((a) => a.libraryItemId))
  const images = library.filter((i) => i.kind === 'image' && !used.has(i.id))
  const ruleFor = (id: string) => rules.find((r) => r.overlayId === id)

  return (
    <div className="overlay-panel">
      <p className="muted small">
        Import overlay images in the Media Library, add them here, and write when each should appear.
        The AI places them on overlay track 1 — you can drag or delete them after.
      </p>

      {images.length > 0 && (
        <div className="ov-add-row">
          {images.map((i) => (
            <button
              key={i.id}
              className="ov-add"
              title={`Add ${i.name} as an overlay`}
              disabled={assets.length >= 10}
              onClick={() => addOverlayAsset(i.id)}
            >
              {i.thumb ? <img src={i.thumb} alt="" /> : <span>🖼</span>}
              <span className="ov-add-name">+ {i.name}</span>
            </button>
          ))}
        </div>
      )}
      {assets.length === 0 && images.length === 0 && (
        <p className="muted small">No overlay images yet — import images in the Media Library first.</p>
      )}

      {assets.map((a) => {
        const r = ruleFor(a.id)
        if (!r) return null
        return (
          <div key={a.id} className="ov-rule">
            <div className="ov-rule-head">
              {a.file ? <img className="ov-thumb" src={mediaSrc(a.file)} alt="" /> : null}
              <input
                className="ov-name"
                value={r.name}
                onChange={(e) => updateOverlayRule(a.id, { name: e.target.value })}
              />
              <button className="ov-del" title="Remove overlay" onClick={() => removeOverlayAsset(a.id)}>✕</button>
            </div>
            <textarea
              className="ov-instr"
              placeholder="Show this when I talk about bloating, digestion, my stomach feeling lighter…"
              value={r.instruction}
              onChange={(e) => updateOverlayRule(a.id, { instruction: e.target.value })}
            />
            <div className="ov-opts">
              <label>
                Position
                <select
                  value={r.position}
                  onChange={(e) => updateOverlayRule(a.id, { position: e.target.value as OverlayPosition })}
                >
                  {POSITIONS.map((p) => (
                    <option key={p} value={p}>{p.replace(/_/g, ' ')}</option>
                  ))}
                </select>
              </label>
              <label>
                Duration
                <input
                  type="number"
                  min={1}
                  max={8}
                  step={0.5}
                  value={r.durationSeconds}
                  onChange={(e) => updateOverlayRule(a.id, { durationSeconds: Number(e.target.value) || 3 })}
                />
              </label>
              <label>
                Animation
                <select
                  value={r.animation}
                  onChange={(e) => updateOverlayRule(a.id, { animation: e.target.value as OverlayAnimation })}
                >
                  {ANIMS.map((x) => (
                    <option key={x} value={x}>{x}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        )
      })}

      {assets.length > 0 && (
        <div className="ov-actions">
          <button className="primary" disabled={job.active} onClick={() => void generateOverlays()}>
            ✨ Generate overlays
          </button>
          <button disabled={job.active} onClick={() => clearGeneratedOverlays()}>
            Clear placed
          </button>
        </div>
      )}

      {overlayLog.length > 0 && (
        <details className="ov-log">
          <summary>Last run · {overlayLog.length} log lines</summary>
          <pre>{overlayLog.join('\n')}</pre>
        </details>
      )}
    </div>
  )
}
