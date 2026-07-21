import { useState } from 'react'
import { css } from '../css'
import { useSilence } from '../data/useSilence'
import type { VadSilenceSettings } from '@shared/vadsilence'

// The silence engine's controls — preset chips + a few plain-language sliders,
// shared by the Silence Settings MODAL and the dedicated SILENCE TAB so the two
// surfaces can never drift. Picking a chip loads its values into the sliders;
// touching any slider makes the values stop matching and the highlight flips to
// "Custom" automatically (detectPreset). The two risky/fiddly controls (speech
// sensitivity + tighten) live under an "Advanced" disclosure to keep the default
// view uncluttered. This is a pure UI layer — the settings + engine are unchanged.

// Honest framing for the VAD threshold: it is NOT a room-noise dial — raising it
// makes the detector stricter about what counts as speech, so soft-spoken words
// start counting as silence. Present it as sensitivity with the risk named.
function strictnessLabel(th: number): string {
  return th <= 0.68 ? 'Gentle' : th <= 0.78 ? 'Standard' : th <= 0.85 ? 'Strict' : 'Very strict'
}

export function Slider({ label, value, min, max, step, fmt, lo, hi, onChange }: {
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

/** Preset chips + sliders + toggles. `sil` comes from useSilence() in the host so
 *  modal/tab share the exact same store wiring. */
export function SilenceControls({ sil }: { sil: ReturnType<typeof useSilence> }): JSX.Element {
  const set = (k: keyof VadSilenceSettings, v: number | boolean): void => sil.setField(k, v)
  const active = sil.detected
  const activePreset = sil.presets.find((p) => p.id === active)
  const [advanced, setAdvanced] = useState(false)

  return (
    <>
      {/* Preset chips — small; picking one loads its values into the controls below. */}
      <div style={css('display:flex;gap:6px;margin-top:16px;flex-wrap:wrap')}>
        {sil.presets.map((p) => (
          <button key={p.id} onClick={() => sil.applyPreset(p.id)} style={css(active === p.id ? CHIP_ON : CHIP)}>{p.label}</button>
        ))}
        <span style={css(active === 'custom' ? CHIP_ON + ';cursor:default' : CHIP + ';cursor:default;opacity:.55')}>Custom</span>
      </div>
      <div style={css('font-size:11px;color:#7E8393;margin-top:8px;line-height:1.45;min-height:15px')}>
        {activePreset ? activePreset.blurb : 'Your own settings — pick a preset to start over.'}
      </div>

      {/* The two everyday controls + breaths. */}
      <div style={css(GROUP)}>
        <Slider label="Cut pauses longer than" value={sil.s.minGapS} min={0.05} max={2} step={0.01} fmt={(v) => `${v.toFixed(2)} s`} lo="0.05s · tight" hi="2s · relaxed" onChange={(v) => set('minGapS', v)} />
        <Slider label="Pause kept at each cut" value={sil.s.padAfterS} min={0} max={0.4} step={0.01} fmt={(v) => (v <= 0 ? 'none' : `${v.toFixed(2)} s`)} lo="none · gapless" hi="0.4s · roomy" onChange={(v) => set('padAfterS', v)} />
        <Toggle on={sil.s.removeBreaths} onToggle={() => set('removeBreaths', !sil.s.removeBreaths)} title="Remove breaths" desc="Also cuts breath sounds between words. Turn off if speech feels clipped." />
      </div>

      {/* Advanced — the fiddly/risky knobs, hidden by default to reduce clutter. */}
      <button onClick={() => setAdvanced((v) => !v)}
        style={css('background:none;border:none;color:#9BA0AC;font-family:inherit;font-size:11.5px;cursor:pointer;padding:0;margin-top:18px;display:flex;align-items:center;gap:6px')}>
        <span style={css('font-size:9px')}>{advanced ? '▼' : '▶'}</span> Advanced
      </button>
      {advanced && (
        <div style={css(GROUP + ';margin-top:14px')}>
          <Slider label="Tighten cuts" value={sil.s.edgeTrimS} min={0} max={0.2} step={0.01} fmt={(v) => (v <= 0 ? 'off' : `${Math.round(v * 1000)} ms`)} lo="off" hi="0.2s · tightest" onChange={(v) => set('edgeTrimS', v)} />
          <Slider label="Silence sensitivity" value={sil.s.speechThreshold} min={0.5} max={0.9} step={0.01} fmt={(v) => strictnessLabel(v)} lo="gentle · keeps soft speech" hi="strict · may clip soft speech" onChange={(v) => set('speechThreshold', v)} />
        </div>
      )}

      {/* Blend audio at cuts ("overlap") — a render setting (export + preview). */}
      <div style={css('margin-top:18px;border-top:1px solid rgba(255,255,255,.07);padding-top:16px;display:flex;flex-direction:column;gap:14px')}>
        <Toggle on={sil.seamFade.enabled} onToggle={() => sil.setSeamFade({ enabled: !sil.seamFade.enabled })}
          title="Blend audio at cuts" desc="Crossfades each join so cuts don't click. Marked ◢ on the timeline." />
        {sil.seamFade.enabled && (
          <Slider label="Overlap amount" value={sil.seamFade.ms} min={0} max={60} step={1} fmt={(v) => `${Math.round(v)} ms`} lo="0 · hard cut" hi="60 ms · smoother" onChange={(v) => sil.setSeamFade({ ms: v })} />
        )}
      </div>
    </>
  )
}
