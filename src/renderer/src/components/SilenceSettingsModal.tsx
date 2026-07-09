import { useStore } from '../store'
import { RETAKE_BETA_SILENCE_PRESETS, type SilencePreset } from '@shared/retakeaware/silence'

const PRESETS: SilencePreset[] = ['conservative', 'balanced', 'aggressive', 'custom']

interface Row {
  key: 'minPauseS' | 'targetRemainingS' | 'paddingBeforeS' | 'paddingAfterS' | 'minRemovedS' | 'maxCutsPerMinute'
  label: string
  min: number
  max: number
  step: number
  unit: string
}
const ROWS: Row[] = [
  { key: 'minPauseS', label: 'Minimum pause to detect', min: 0.7, max: 3.0, step: 0.05, unit: 's' },
  { key: 'targetRemainingS', label: 'Target remaining pause', min: 0.3, max: 1.2, step: 0.05, unit: 's' },
  { key: 'paddingBeforeS', label: 'Speech padding before word', min: 0.1, max: 0.6, step: 0.02, unit: 's' },
  { key: 'paddingAfterS', label: 'Speech padding after word', min: 0.1, max: 0.7, step: 0.02, unit: 's' },
  { key: 'minRemovedS', label: 'Minimum silence removed', min: 0.3, max: 2.0, step: 0.05, unit: 's' },
  { key: 'maxCutsPerMinute', label: 'Max silence cuts per minute', min: 2, max: 20, step: 1, unit: '/min' }
]

export default function SilenceSettingsModal(): JSX.Element {
  const s = useStore((st) => st.retakeBetaSilenceSettings)
  const setS = useStore((st) => st.setRetakeBetaSilenceSettings)
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
          <span style={{ fontSize: 16, fontWeight: 600 }}>🔇 Retake β — Silence Settings</span>
          <span style={{ flex: 1 }} />
          <button onClick={() => close(false)} style={{ background: 'none', border: 'none', color: '#aaa', fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ fontSize: 12, color: '#9aa', marginBottom: 14 }}>
          Controls Retake β silence tightening only — never FastCut / ProCut.
        </div>

        {/* Sensitivity preset */}
        <div style={{ fontSize: 12, color: '#9aa', marginBottom: 6 }}>Sensitivity preset</div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
          {PRESETS.map((p) => (
            <button
              key={p}
              onClick={() => setS({ preset: p })}
              style={{
                flex: 1, padding: '6px 4px', borderRadius: 6, cursor: 'pointer', textTransform: 'capitalize',
                border: s.preset === p ? '1px solid #6ea8fe' : '1px solid #3a3d44',
                background: s.preset === p ? '#22314e' : '#24262c', color: s.preset === p ? '#cfe0ff' : '#cfcfcf', fontSize: 12
              }}
            >
              {p}
            </button>
          ))}
        </div>

        {/* Numeric sliders */}
        {ROWS.map((r) => {
          const val = s[r.key] as number
          return (
            <div key={r.key} style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 3 }}>
                <span>{r.label}</span>
                <span style={{ color: '#8fd08f', fontVariantNumeric: 'tabular-nums' }}>{r.step < 1 ? val.toFixed(2) : val}{r.unit}</span>
              </div>
              <input
                type="range" min={r.min} max={r.max} step={r.step} value={val}
                onChange={(e) => setS({ [r.key]: Number(e.target.value) } as never)}
                style={{ width: '100%' }}
              />
            </div>
          )
        })}

        {/* Toggles */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, marginBottom: 8, fontSize: 13 }}>
          <input type="checkbox" checked={s.removeBreaths} onChange={(e) => setS({ removeBreaths: e.target.checked })} />
          Remove tiny breaths <span style={{ color: '#c08', fontSize: 11 }}>(off for launch)</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, opacity: 0.7 }} title="Anti-sliver protection cannot be disabled in launch mode.">
          <input type="checkbox" checked={s.antiSliver} disabled onChange={() => undefined} />
          Anti-sliver protection <span style={{ color: '#6c9', fontSize: 11 }}>(always on)</span>
        </label>

        {/* Aggressive VAD hard-cut toggle — bypasses the hybrid above. */}
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 12, fontSize: 13, padding: '8px 10px', borderRadius: 6, border: `1px solid ${s.vadHardCut ? '#c98a3a' : '#3a3d44'}`, background: s.vadHardCut ? '#2c2418' : 'transparent' }}>
          <input type="checkbox" checked={s.vadHardCut} onChange={(e) => setS({ vadHardCut: e.target.checked })} style={{ marginTop: 2 }} />
          <span>
            Aggressive VAD hard-cut <span style={{ color: '#e0a45a', fontSize: 11 }}>(bypasses the sliders above)</span>
            <div style={{ color: '#9aa', fontSize: 11, marginTop: 2 }}>
              Removes <b>every</b> pause ≥100ms with a raw VAD pass (speech 60% · trim 0.08s · pad 0.02s · min-gap 0.1s) instead of the transcript-gap hybrid. Tight/fast — cuts all breathing room. Retake/repeat word cuts are unaffected.
            </div>
          </span>
        </label>

        <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
          <button onClick={() => setS({ preset: 'balanced' })} style={{ flex: 1, padding: '8px', borderRadius: 6, border: '1px solid #3a3d44', background: '#24262c', color: '#cfcfcf', cursor: 'pointer' }}>
            Reset to Balanced
          </button>
          <button onClick={() => close(false)} className="primary" style={{ flex: 1, padding: '8px', borderRadius: 6, cursor: 'pointer' }}>
            Done
          </button>
        </div>
        <div style={{ fontSize: 11, color: '#778', marginTop: 10 }}>
          Then click <b>🧪 Find Retakes &amp; Silence</b> to run with these settings. The exact settings are recorded in the debug JSON.
        </div>
      </div>
    </div>
  )
}
