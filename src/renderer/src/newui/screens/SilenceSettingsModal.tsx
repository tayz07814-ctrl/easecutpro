import { useEffect, useState } from 'react'
import { css } from '../css'
import { useSilence } from '../data/useSilence'
import type { SilenceCutScope, VadSilenceSettings } from '@shared/vadsilence'
import { detectPreset, presetProfile } from '../../silencePresets'

// Silence Settings — ONE panel. Small preset chips on top; the everyday sliders
// beneath, with the fiddly/risky knobs (speech sensitivity + tighten) tucked under
// an "Advanced" disclosure so the default view stays uncluttered. Clicking a chip
// loads its values into the sliders (bound to the store, so they move); touching
// any slider makes the values stop matching and the highlight flips to "Custom"
// automatically (detectPreset).

const FOOT_RESET = 'font-size:12.5px;color:#9BA0AC;cursor:pointer;padding:7px 10px;border-radius:8px'
const FOOT_CANCEL = 'font-size:12.5px;color:#C6C9D2;cursor:pointer;padding:8px 14px;border-radius:9px'
const FOOT_APPLY = 'background:#6E6AE8;border:none;color:#fff;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:9px 18px;cursor:pointer;margin-left:8px'

// Honest framing for the VAD threshold: it is NOT a room-noise dial — raising it
// makes the detector stricter about what counts as speech, so soft-spoken words
// start counting as silence. Present it as sensitivity with the risk named.
function strictnessLabel(th: number): string {
  return th <= 0.68 ? 'Gentle' : th <= 0.78 ? 'Standard' : th <= 0.85 ? 'Strict' : 'Very strict'
}

function Slider({ label, value, min, max, step, fmt, lo, hi, onChange }: {
  label: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string; lo: string; hi: string; onChange: (v: number) => void
}): JSX.Element {
  const pct = `${Math.max(0, Math.min(1, (value - min) / (max - min))) * 100}%`
  return (
    <div>
      <div style={css('display:flex;justify-content:space-between;font-size:12.5px')}><span style={css('color:#E9EAEE;font-weight:550')}>{label}</span><span style={css("font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:#B7B5F4")}>{fmt(value)}</span></div>
      <div style={css('height:4px;border-radius:2px;background:#2A2D36;position:relative;margin-top:10px')}>
        <div style={css(`width:${pct};height:100%;border-radius:2px;background:#6E6AE8`)} />
        <div style={css(`position:absolute;left:${pct};top:50%;transform:translate(-50%,-50%);width:14px;height:14px;border-radius:50%;background:#E9EAEE;box-shadow:0 1px 4px rgba(0,0,0,.4)`)} />
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))}
          style={css('position:absolute;left:0;right:0;top:-8px;bottom:-8px;width:100%;height:auto;margin:0;opacity:0;cursor:pointer')} />
      </div>
      <div style={css('display:flex;justify-content:space-between;font-size:10.5px;color:#565C68;margin-top:6px')}><span>{lo}</span><span>{hi}</span></div>
    </div>
  )
}

/** A labelled on/off switch (breaths, blend). */
function Toggle({ on, onToggle, title, desc }: { on: boolean; onToggle: () => void; title: string; desc: string }): JSX.Element {
  return (
    <div style={css('display:flex;align-items:flex-start;gap:10px')}>
      <div onClick={onToggle} style={css(`width:32px;height:18px;border-radius:9px;position:relative;flex:none;cursor:pointer;margin-top:1px;background:${on ? '#6E6AE8' : '#3A3E48'}`)}>
        <div style={css(on ? 'position:absolute;right:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff' : 'position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#9BA0AC')} />
      </div>
      <div style={css('flex:1;min-width:0')}>
        <div style={css('font-size:12.5px;color:#E9EAEE;font-weight:550')}>{title}</div>
        <div style={css('font-size:11px;color:#7E8393;margin-top:2px;line-height:1.45')}>{desc}</div>
      </div>
    </div>
  )
}

const CHIP = 'font-size:11.5px;padding:6px 12px;border-radius:999px;cursor:pointer;border:1px solid rgba(255,255,255,.12);color:#9BA0AC;background:transparent;font-family:inherit'
const CHIP_ON = 'font-size:11.5px;padding:6px 12px;border-radius:999px;cursor:pointer;border:1px solid #6E6AE8;color:#B7B5F4;background:rgba(110,106,232,.12);font-weight:600;font-family:inherit'
const GROUP = 'display:flex;flex-direction:column;gap:18px;margin-top:16px'

export default function SilenceSettingsModal(): JSX.Element | null {
  const sil = useSilence()
  const [advanced, setAdvanced] = useState(false)
  const [draft, setDraft] = useState<VadSilenceSettings>(sil.s)
  const [draftFade, setDraftFade] = useState(sil.seamFade)
  useEffect(() => {
    if (sil.show) {
      setDraft({ ...sil.s })
      setDraftFade({ ...sil.seamFade })
    }
  }, [sil.show])
  if (!sil.show) return null

  const set = (k: keyof VadSilenceSettings, v: number | boolean | SilenceCutScope): void => setDraft((s) => ({ ...s, [k]: v }))
  const active = detectPreset(draft, draftFade)
  const activePreset = sil.presets.find((p) => p.id === active)

  return (
    <div onClick={sil.close} style={css('position:fixed;inset:0;background:rgba(10,11,14,.55);display:grid;place-items:center;z-index:1000')}>
      <div onClick={(e) => e.stopPropagation()} style={css('width:440px;max-width:92vw;background:#1E2026;border:1px solid rgba(255,255,255,.1);border-radius:10px;box-shadow:0 24px 64px rgba(0,0,0,.6);padding:22px;max-height:90vh;overflow-y:auto')}>
        <div style={css('display:flex;align-items:flex-start;justify-content:space-between')}>
          <div>
            <div style={css('font-size:16px;font-weight:650')}>Silence Settings</div>
            <div style={css('font-size:12.5px;color:#9BA0AC;margin-top:5px;line-height:1.5')}>Controls silence detection only — retake detection is unaffected.</div>
          </div>
          <div onClick={sil.close} style={css('color:#9BA0AC;font-size:15px;padding:4px 8px;border-radius:8px;cursor:pointer;margin:-4px -6px 0 0')}>✕</div>
        </div>

        {/* Preset chips — small; picking one loads its values into the controls below. */}
        <div style={css('display:flex;gap:6px;margin-top:16px;flex-wrap:wrap')}>
          {sil.presets.map((p) => (
            <button key={p.id} onClick={() => { const profile = presetProfile(p.id); setDraft(profile.values); setDraftFade(profile.seamFade) }} style={css(active === p.id ? CHIP_ON : CHIP)}>{p.label}</button>
          ))}
          <span style={css(active === 'custom' ? CHIP_ON + ';cursor:default' : CHIP + ';cursor:default;opacity:.55')}>Custom</span>
        </div>
        <div style={css('font-size:11px;color:#7E8393;margin-top:8px;line-height:1.45;min-height:15px')}>
          {activePreset ? activePreset.blurb : 'Your own settings — pick a preset to start over.'}
        </div>

        {/* The two everyday controls + breaths. */}
        <div style={css(GROUP)}>
          <label style={css('display:flex;flex-direction:column;gap:7px;font-size:12.5px;color:#E9EAEE;font-weight:550')}>
            Gaps eligible for shortening
            <select value={draft.scope} onChange={(e) => set('scope', e.target.value as SilenceCutScope)} style={css('background:#282B33;color:#E9EAEE;border:1px solid #3A3E48;border-radius:8px;padding:8px;font-family:inherit')}>
              <option value="sentences">Sentence boundaries only</option>
              <option value="sentences_and_long_words">Sentences + long word gaps</option>
              <option value="all_word_gaps">All transcript-safe word gaps</option>
            </select>
          </label>
          <Slider label="Cut pauses longer than" value={draft.minGapS} min={0.05} max={2} step={0.01} fmt={(v) => `${v.toFixed(2)} s`} lo="0.05s · tight" hi="2s · relaxed" onChange={(v) => set('minGapS', v)} />
          <Slider label="Pause kept at each cut" value={draft.targetPauseS} min={0} max={0.8} step={0.01} fmt={(v) => (v <= 0 ? 'none' : `${v.toFixed(2)} s`)} lo="none · gapless" hi="0.8s · roomy" onChange={(v) => set('targetPauseS', v)} />
          <Toggle on={draft.removeBreaths} onToggle={() => set('removeBreaths', !draft.removeBreaths)} title="Remove breaths" desc="Also cuts breath sounds between words. Turn off if speech feels clipped." />
        </div>

        {/* Advanced — the fiddly/risky knobs, hidden by default to reduce clutter. */}
        <button onClick={() => setAdvanced((v) => !v)}
          style={css('background:none;border:none;color:#9BA0AC;font-family:inherit;font-size:11.5px;cursor:pointer;padding:0;margin-top:18px;display:flex;align-items:center;gap:6px')}>
          <span style={css('font-size:9px')}>{advanced ? '▼' : '▶'}</span> Advanced
        </button>
        {advanced && (
          <div style={css(GROUP + ';margin-top:14px')}>
            <Slider label="Keep after previous word" value={draft.padAfterS} min={0} max={0.5} step={0.01} fmt={(v) => `${v.toFixed(2)} s`} lo="none" hi="0.5s" onChange={(v) => set('padAfterS', v)} />
            <Slider label="Keep before next word" value={draft.padBeforeS} min={0} max={0.5} step={0.01} fmt={(v) => `${v.toFixed(2)} s`} lo="none" hi="0.5s" onChange={(v) => set('padBeforeS', v)} />
            <Slider label="VAD speech threshold" value={draft.speechThreshold} min={0} max={1} step={0.01} fmt={(v) => strictnessLabel(v)} lo="0 · most protective" hi="1 · most aggressive" onChange={(v) => set('speechThreshold', v)} />
          </div>
        )}

        {/* Blend audio at cuts ("overlap") — a render setting (export + preview). */}
        <div style={css('margin-top:18px;border-top:1px solid rgba(255,255,255,.07);padding-top:16px;display:flex;flex-direction:column;gap:14px')}>
          <Toggle on={draftFade.enabled} onToggle={() => setDraftFade((s) => ({ ...s, enabled: !s.enabled }))}
            title="Blend audio at cuts" desc="Crossfades each join so cuts don't click. Marked ◢ on the timeline." />
          {draftFade.enabled && (
            <Slider label="Overlap amount" value={draftFade.ms} min={0} max={60} step={1} fmt={(v) => `${Math.round(v)} ms`} lo="0 · hard cut" hi="60 ms · smoother" onChange={(v) => setDraftFade((s) => ({ ...s, ms: v }))} />
          )}
        </div>

        <div style={css('display:flex;align-items:center;margin-top:20px')}>
          <span onClick={() => { const profile = presetProfile('balanced'); setDraft(profile.values); setDraftFade(profile.seamFade) }} style={css(FOOT_RESET)}>Reset to default</span>
          <div style={css('flex:1')} />
          <span onClick={sil.close} style={css(FOOT_CANCEL)}>Cancel</span>
          <button onClick={() => { sil.commit(draft, draftFade); sil.close() }} style={css(FOOT_APPLY)}>Apply</button>
        </div>
      </div>
    </div>
  )
}
