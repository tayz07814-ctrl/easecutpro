import { useState } from 'react'
import { useStore } from '../store'
import { DEFAULT_VAD_SILENCE_SETTINGS, type VadSilenceSettings } from '@shared/vadsilence'
import { SILENCE_PRESETS, detectPreset, presetValues, type SilencePresetId } from '../silencePresets'

/**
 * Silence Settings — redesigned Retake β silence UI (VITE_NEW_EASECUT_UI only).
 *
 * Edits ONLY the existing `vadSilenceSettings` (via the existing setter — no
 * second store, no new fields). Changes are BUFFERED in a local draft so Cancel
 * discards and Apply commits (Apply → setVadSilenceSettings, which normalizes +
 * persists exactly as before). Selecting a preset fills the draft; editing any
 * value flips the active preset to "Custom". Controls map 1:1 to real fields
 * with creator-facing labels — no engine, provider, or VAD terminology is shown.
 */

// Numeric controls, each bound to one real VadSilenceSettings field.
interface Row {
  key: 'speechThreshold' | 'minGapS' | 'padBeforeS' | 'padAfterS' | 'edgeTrimS'
  label: string
  desc: string
  min: number
  max: number
  step: number
  fmt: (v: number) => string
}
const ROWS: Row[] = [
  { key: 'minGapS', label: 'Minimum pause to detect', desc: 'Only pauses longer than this are trimmed.', min: 0.05, max: 1.5, step: 0.05, fmt: (v) => `${v.toFixed(2)}s` },
  { key: 'padBeforeS', label: 'Padding before speech', desc: 'Audio kept just before each word.', min: 0, max: 0.3, step: 0.01, fmt: (v) => `${v.toFixed(2)}s` },
  { key: 'padAfterS', label: 'Padding after speech', desc: 'Audio kept just after each word.', min: 0, max: 0.3, step: 0.01, fmt: (v) => `${v.toFixed(2)}s` },
  { key: 'edgeTrimS', label: 'Tighten cut edges', desc: 'Trim a touch extra at every cut for snappier pacing.', min: 0, max: 0.2, step: 0.01, fmt: (v) => `${v.toFixed(2)}s` },
  { key: 'speechThreshold', label: 'Silence sensitivity', desc: 'Higher catches quieter pauses as silence.', min: 0.5, max: 0.95, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` }
]

export default function SilenceSettingsSheet(): JSX.Element {
  const applied = useStore((s) => s.vadSilenceSettings)
  const setApplied = useStore((s) => s.setVadSilenceSettings)
  const close = useStore((s) => s.setShowSilenceSettings)

  // Buffered draft — seeded from the currently-applied settings. Cancel/scrim
  // simply close without committing; only Apply writes to the store.
  const [draft, setDraft] = useState<VadSilenceSettings>(() => ({ ...applied }))
  const active = detectPreset(draft)

  const set = (patch: Partial<VadSilenceSettings>): void => setDraft((d) => ({ ...d, ...patch }))
  const pickPreset = (id: SilencePresetId): void => setDraft(presetValues(id))
  const cancel = (): void => close(false)
  const apply = (): void => {
    setApplied(draft) // existing setter → normalizes + persists
    close(false)
  }

  const explain = `Pauses longer than ${draft.minGapS.toFixed(2)}s are removed, keeping about ${draft.padAfterS.toFixed(2)}s of breathing room${draft.removeBreaths ? ', and soft breaths are trimmed' : ''}.`

  return (
    <div className="ss-scrim" onClick={cancel}>
      <div className="ss-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="ss-head">
          <div>
            <div className="ss-title">Silence Settings</div>
            <div className="ss-sub">Controls silence trimming for Retake β only — retake detection is unaffected.</div>
          </div>
          <button className="ss-x" onClick={cancel} aria-label="Close">✕</button>
        </div>

        {/* preset cards */}
        <div className="ss-presets">
          {SILENCE_PRESETS.map((p) => (
            <button
              key={p.id}
              className={'ss-preset' + (active === p.id ? ' on' : '')}
              onClick={() => pickPreset(p.id)}
            >
              <div className="ss-preset-name">{p.label}</div>
              <div className="ss-preset-blurb">{p.blurb}</div>
              {active === p.id && <span className="ss-preset-tick">✓</span>}
            </button>
          ))}
          <div className={'ss-preset ss-preset-custom' + (active === 'custom' ? ' on' : '')}>
            <div className="ss-preset-name">Custom</div>
            <div className="ss-preset-blurb">Fine-tune every value below.</div>
            {active === 'custom' && <span className="ss-preset-tick">✓</span>}
          </div>
        </div>

        <div className="ss-explain">{explain}</div>

        {/* real controls */}
        <div className="ss-controls">
          {ROWS.map((r) => {
            const val = draft[r.key]
            return (
              <div className="ss-ctl" key={r.key}>
                <div className="ss-ctl-top">
                  <span className="ss-ctl-label">{r.label}</span>
                  <span className="ss-ctl-val">{r.fmt(val)}</span>
                </div>
                <input
                  type="range"
                  min={r.min}
                  max={r.max}
                  step={r.step}
                  value={val}
                  onChange={(e) => set({ [r.key]: Number(e.target.value) } as Partial<VadSilenceSettings>)}
                />
                <div className="ss-ctl-desc">{r.desc}</div>
              </div>
            )
          })}

          <label className="ss-toggle-row">
            <input type="checkbox" checked={draft.removeBreaths} onChange={(e) => set({ removeBreaths: e.target.checked })} />
            <span>
              <span className="ss-ctl-label">Remove breaths &amp; quiet fillers</span>
              <span className="ss-ctl-desc">Also cut soft breaths kept as speech. Can clip very soft speech — review after.</span>
            </span>
          </label>

          {draft.removeBreaths && (
            <div className="ss-ctl">
              <div className="ss-ctl-top">
                <span className="ss-ctl-label">Breath sensitivity</span>
              </div>
              {/* breathDb: less-negative removes more. Presented as subtle→aggressive, no dB jargon. */}
              <input
                type="range"
                min={-50}
                max={-20}
                step={1}
                value={draft.breathDb}
                onChange={(e) => set({ breathDb: Number(e.target.value) })}
              />
              <div className="ss-ctl-ends">
                <span>Subtle</span>
                <span>Aggressive</span>
              </div>
            </div>
          )}
        </div>

        {/* footer */}
        <div className="ss-foot">
          <button className="ss-reset" onClick={() => setDraft({ ...DEFAULT_VAD_SILENCE_SETTINGS })}>Reset to defaults</button>
          <span className="ss-spacer" />
          <button onClick={cancel}>Cancel</button>
          <button className="primary" onClick={apply}>Apply settings</button>
        </div>
      </div>
    </div>
  )
}
