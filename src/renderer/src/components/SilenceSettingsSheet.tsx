import { useState } from 'react'
import { useStore } from '../store'
import type { SilenceCutScope, VadSilenceSettings } from '@shared/vadsilence'
import { SILENCE_PRESETS, detectPreset, presetProfile, type SilencePresetId } from '../silencePresets'

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
  key: 'speechThreshold' | 'minGapS' | 'targetPauseS' | 'padBeforeS' | 'padAfterS'
  label: string
  desc: string
  min: number
  max: number
  step: number
  fmt: (v: number) => string
}
const ROWS: Row[] = [
  { key: 'minGapS', label: 'Minimum pause to detect', desc: 'Only pauses longer than this are trimmed.', min: 0.05, max: 1.5, step: 0.05, fmt: (v) => `${v.toFixed(2)}s` },
  { key: 'targetPauseS', label: 'Final retained pause', desc: 'The total breathing room left after shortening.', min: 0, max: 0.8, step: 0.01, fmt: (v) => `${v.toFixed(2)}s` },
  { key: 'padAfterS', label: 'Keep after previous word', desc: 'Protected tail after the preceding word.', min: 0, max: 0.4, step: 0.01, fmt: (v) => `${v.toFixed(2)}s` },
  { key: 'padBeforeS', label: 'Keep before next word', desc: 'Protected lead-in before the next word.', min: 0, max: 0.4, step: 0.01, fmt: (v) => `${v.toFixed(2)}s` },
  { key: 'speechThreshold', label: 'VAD speech threshold', desc: 'Higher treats quiet speech more aggressively.', min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) }
]

export default function SilenceSettingsSheet(): JSX.Element {
  const applied = useStore((s) => s.vadSilenceSettings)
  const setApplied = useStore((s) => s.setVadSilenceSettings)
  const appliedFade = useStore((s) => s.seamFade)
  const setAppliedFade = useStore((s) => s.setSeamFade)
  const close = useStore((s) => s.setShowSilenceSettings)

  // Buffered draft — seeded from the currently-applied settings. Cancel/scrim
  // simply close without committing; only Apply writes to the store.
  const [draft, setDraft] = useState<VadSilenceSettings>(() => ({ ...applied }))
  const [draftFade, setDraftFade] = useState(() => ({ ...appliedFade }))
  const active = detectPreset(draft, draftFade)

  const set = (patch: Partial<VadSilenceSettings>): void => setDraft((d) => ({ ...d, ...patch }))
  const pickPreset = (id: SilencePresetId): void => {
    const profile = presetProfile(id)
    setDraft(profile.values)
    setDraftFade(profile.seamFade)
  }
  const cancel = (): void => close(false)
  const apply = (): void => {
    setApplied(draft) // existing setter → normalizes + persists
    setAppliedFade(draftFade)
    close(false)
  }

  const explain = `Pauses longer than ${draft.minGapS.toFixed(2)}s are shortened to ${Math.max(draft.targetPauseS, draft.padAfterS + draft.padBeforeS).toFixed(2)}s with a ${draftFade.ms}ms crossfade.`

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
          <label className="ss-ctl">
            <span className="ss-ctl-label">Gaps eligible for shortening</span>
            <select value={draft.scope} onChange={(e) => set({ scope: e.target.value as SilenceCutScope })}>
              <option value="sentences">Sentence boundaries only</option>
              <option value="sentences_and_long_words">Sentences + long word gaps</option>
              <option value="all_word_gaps">All transcript-safe word gaps</option>
            </select>
          </label>
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

          <div className="ss-ctl">
            <div className="ss-ctl-top"><span className="ss-ctl-label">Audio crossfade</span><span className="ss-ctl-val">{draftFade.ms}ms</span></div>
            <input type="range" min={0} max={60} step={1} value={draftFade.ms} onChange={(e) => setDraftFade({ enabled: Number(e.target.value) > 0, ms: Number(e.target.value) })} />
          </div>
        </div>

        {/* footer */}
        <div className="ss-foot">
          <button className="ss-reset" onClick={() => pickPreset('balanced')}>Reset to defaults</button>
          <span className="ss-spacer" />
          <button onClick={cancel}>Cancel</button>
          <button className="primary" onClick={apply}>Apply settings</button>
        </div>
      </div>
    </div>
  )
}
