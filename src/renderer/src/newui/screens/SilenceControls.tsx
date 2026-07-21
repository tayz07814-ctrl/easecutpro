import { css } from '../css'
import { useSilence } from '../data/useSilence'
import type { VadSilenceSettings } from '@shared/vadsilence'

// The silence engine's controls — preset chips + sliders + breaths + overlap —
// shared by the Silence Settings MODAL and the dedicated SILENCE TAB so the two
// surfaces can never drift. Picking a chip loads its values into the sliders;
// touching any slider makes the values stop matching and the highlight flips to
// "Custom" automatically (detectPreset).

// Honest framing for the VAD threshold: it is NOT a room-noise dial — raising it
// makes the detector stricter about what counts as speech, so soft-spoken words
// start counting as silence. Present it as detection strictness with the risk named.
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

const CHIP = 'font-size:11.5px;padding:6px 12px;border-radius:999px;cursor:pointer;border:1px solid rgba(255,255,255,.12);color:#9BA0AC;background:transparent;font-family:inherit'
const CHIP_ON = 'font-size:11.5px;padding:6px 12px;border-radius:999px;cursor:pointer;border:1px solid #6E6AE8;color:#B7B5F4;background:rgba(110,106,232,.12);font-weight:600;font-family:inherit'

/** Preset chips + sliders + breaths toggle + seam-blend section. `sil` comes from
 *  useSilence() in the host so modal/tab share the exact same store wiring. */
export function SilenceControls({ sil }: { sil: ReturnType<typeof useSilence> }): JSX.Element {
  const set = (k: keyof VadSilenceSettings, v: number | boolean): void => sil.setField(k, v)
  const active = sil.detected
  const activePreset = sil.presets.find((p) => p.id === active)

  return (
    <>
      {/* Preset chips — small; picking one loads its values into the sliders below. */}
      <div style={css('display:flex;gap:6px;margin-top:16px;flex-wrap:wrap')}>
        {sil.presets.map((p) => (
          <button key={p.id} onClick={() => sil.applyPreset(p.id)} style={css(active === p.id ? CHIP_ON : CHIP)}>{p.label}</button>
        ))}
        <span style={css(active === 'custom' ? CHIP_ON + ';cursor:default' : CHIP + ';cursor:default;opacity:.55')}>Custom</span>
      </div>
      <div style={css('font-size:11px;color:#7E8393;margin-top:8px;line-height:1.45;min-height:15px')}>
        {activePreset ? activePreset.blurb : 'Your own values — move any slider; pick a chip to go back to a preset.'}
      </div>

      {/* The sliders — always visible, bound to the live settings. */}
      <div style={css('display:flex;flex-direction:column;gap:18px;margin-top:16px')}>
        <Slider label="Trim pauses longer than" value={sil.s.minGapS} min={0.05} max={2} step={0.01} fmt={(v) => `${v.toFixed(2)} s`} lo="0.05s · tight" hi="2s · relaxed" onChange={(v) => set('minGapS', v)} />
        <Slider label="Pause to keep at each cut" value={sil.s.padAfterS} min={0} max={0.4} step={0.01} fmt={(v) => `${v.toFixed(2)} s`} lo="0s · gapless" hi="0.4s · gentle" onChange={(v) => set('padAfterS', v)} />
        <Slider label="Trim cut edges" value={sil.s.edgeTrimS} min={0} max={0.2} step={0.01} fmt={(v) => (v <= 0 ? 'off' : `${Math.round(v * 1000)} ms`)} lo="0 · off" hi="200 ms · snug" onChange={(v) => set('edgeTrimS', v)} />
        <Slider label="Silence detection strictness" value={sil.s.speechThreshold} min={0.5} max={0.9} step={0.01} fmt={(v) => `${strictnessLabel(v)} · ${Math.round(v * 100)}%`} lo="gentle · keeps soft speech" hi="strict · may clip soft speech" onChange={(v) => set('speechThreshold', v)} />
        <div style={css('display:flex;align-items:flex-start;gap:9px')}>
          <div onClick={() => set('removeBreaths', !sil.s.removeBreaths)} style={css(sil.s.removeBreaths ? 'width:32px;height:18px;border-radius:9px;background:#6E6AE8;position:relative;flex:none;cursor:pointer;margin-top:1px' : 'width:32px;height:18px;border-radius:9px;background:#3A3E48;position:relative;flex:none;cursor:pointer;margin-top:1px')}>
            <div style={css(sil.s.removeBreaths ? 'position:absolute;right:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff' : 'position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#9BA0AC')} />
          </div>
          <div style={css('flex:1;min-width:0')}>
            <div style={css('font-size:12px;color:#C6C9D2')}>Remove breaths</div>
            <div style={css('font-size:10.5px;color:#7E8393;margin-top:2px;line-height:1.4')}>Also cuts audible breaths between words. The most aggressive option — leave off if cuts feel clipped.</div>
          </div>
        </div>
      </div>

      {/* Seam blend ("overlap") — a global render setting (export + preview). */}
      <div style={css('margin-top:18px;border-top:1px solid rgba(255,255,255,.07);padding-top:16px;display:flex;flex-direction:column;gap:14px')}>
        <div style={css('display:flex;align-items:flex-start;gap:11px')}>
          <div onClick={() => sil.setSeamFade({ enabled: !sil.seamFade.enabled })} style={css(`width:32px;height:18px;border-radius:9px;position:relative;flex:none;cursor:pointer;margin-top:1px;background:${sil.seamFade.enabled ? '#6E6AE8' : '#3A3E48'}`)}>
            <div style={css(sil.seamFade.enabled ? 'position:absolute;right:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff' : 'position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#9BA0AC')} />
          </div>
          <div style={css('flex:1;min-width:0')}>
            <div style={css('font-size:12.5px;color:#E9EAEE;font-weight:550')}>Blend audio at cuts (overlap)</div>
            <div style={css('font-size:11px;color:#9BA0AC;margin-top:3px;line-height:1.45')}>Crossfades the join: the outgoing audio tails off under the incoming words. Marked with ◢ on the timeline. Turn off for hard cuts.</div>
          </div>
        </div>
        {sil.seamFade.enabled && (
          <Slider label="Overlap amount" value={sil.seamFade.ms} min={0} max={60} step={1} fmt={(v) => `${Math.round(v)} ms`} lo="0 · hard cut" hi="60 ms · smoother" onChange={(v) => sil.setSeamFade({ ms: v })} />
        )}
      </div>
    </>
  )
}
