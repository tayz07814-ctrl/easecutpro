import { useStore } from '../store'
import { DEFAULT_VAD_SILENCE_SETTINGS, type VadSilenceSettings } from '@shared/vadsilence'

// Unified VAD silence-cutting settings — ONE modal for BOTH ProCut and Retake β
// (cloud build). Edits the store's vadSilenceSettings; both engines run the same
// raw-VAD silence pass with these values.
interface Row {
  key: 'speechThreshold' | 'minGapS' | 'targetPauseS' | 'padBeforeS' | 'padAfterS' | 'edgeTrimS' | 'breathDb'
  label: string
  min: number
  max: number
  step: number
  unit: string
  hint?: string
}
const ROWS: Row[] = [
  { key: 'speechThreshold', label: 'Speech threshold', min: 0, max: 1, step: 0.01, unit: '', hint: 'higher = cut more (0–1)' },
  { key: 'minGapS', label: 'Minimum gap to cut', min: 0.05, max: 1.0, step: 0.05, unit: 's' },
  { key: 'targetPauseS', label: 'Final retained pause', min: 0, max: 0.8, step: 0.01, unit: 's' },
  { key: 'padBeforeS', label: 'Padding before word', min: 0, max: 0.3, step: 0.01, unit: 's' },
  { key: 'padAfterS', label: 'Padding after word', min: 0, max: 0.3, step: 0.01, unit: 's' },
  { key: 'edgeTrimS', label: 'Trim cut edges', min: 0, max: 0.2, step: 0.01, unit: 's' },
  { key: 'breathDb', label: 'Breath sensitivity', min: -50, max: -20, step: 1, unit: ' dB', hint: 'less negative = removes more' }
]

export default function VadSilenceSettingsModal(): JSX.Element {
  const s = useStore((st) => st.vadSilenceSettings)
  const setS = useStore((st) => st.setVadSilenceSettings)
  const close = useStore((st) => st.setShowSilenceSettings)

  return (
    <div
      onClick={() => close(false)}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 460, maxWidth: '92vw', maxHeight: '88vh', overflowY: 'auto', background: '#1b1d22', border: '1px solid #33363d', borderRadius: 10, padding: 18, color: '#e6e6e6', boxShadow: '0 12px 40px rgba(0,0,0,0.5)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 16, fontWeight: 600 }}>🔇 Silence Settings</span>
          <span style={{ flex: 1 }} />
          <button onClick={() => close(false)} style={{ background: 'none', border: 'none', color: '#aaa', fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ fontSize: 12, color: '#9aa', marginBottom: 14 }}>
          Silence-cutting for <b>Retake β</b>. Word/retake cuts are unaffected.
        </div>

        {ROWS.map((r) => {
          const val = s[r.key]
          return (
            <div key={r.key} style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 3 }}>
                <span>{r.label}{r.hint ? <span style={{ color: '#778', fontSize: 11 }}> · {r.hint}</span> : null}</span>
                <span style={{ color: '#8fd08f', fontVariantNumeric: 'tabular-nums' }}>
                  {r.step < 1 ? val.toFixed(2) : val}{r.unit}
                </span>
              </div>
              <input
                type="range" min={r.min} max={r.max} step={r.step} value={val}
                onChange={(e) => setS({ [r.key]: Number(e.target.value) } as Partial<VadSilenceSettings>)}
                style={{ width: '100%' }}
              />
            </div>
          )
        })}

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 13 }}>
          <input type="checkbox" checked={s.removeBreaths} onChange={(e) => setS({ removeBreaths: e.target.checked })} />
          Remove breaths &amp; quiet fillers <span style={{ color: '#6c9', fontSize: 11 }}>(uses breath sensitivity above)</span>
        </label>

        <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
          <button onClick={() => setS({ ...DEFAULT_VAD_SILENCE_SETTINGS })} style={{ flex: 1, padding: '8px', borderRadius: 6, border: '1px solid #3a3d44', background: '#24262c', color: '#cfcfcf', cursor: 'pointer' }}>
            Reset to defaults
          </button>
          <button onClick={() => close(false)} className="primary" style={{ flex: 1, padding: '8px', borderRadius: 6, cursor: 'pointer' }}>
            Done
          </button>
        </div>
        <div style={{ fontSize: 11, color: '#778', marginTop: 10 }}>
          Then run <b>🧪 Find Retakes &amp; Silence</b> — silence chips stage for review; nothing is cut until Execute.
        </div>
      </div>
    </div>
  )
}
