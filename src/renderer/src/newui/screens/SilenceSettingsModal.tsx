import { useState } from 'react'
import { css } from '../css'
import { useSilence, type Preset } from '../data/useSilence'
import type { VadSilenceSettings } from '@shared/vadsilence'

// Stage C — production Silence Settings modal (screen 1d), wired to
// vadSilenceSettings. Presets ↔ Custom mirror the two approved design variants.

const FOOT_RESET = 'font-size:12.5px;color:#9BA0AC;cursor:pointer;padding:7px 10px;border-radius:8px'
const FOOT_CANCEL = 'font-size:12.5px;color:#C6C9D2;cursor:pointer;padding:8px 14px;border-radius:9px'
const FOOT_APPLY = 'background:#6E6AE8;border:none;color:#fff;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:9px 18px;cursor:pointer;margin-left:8px'

function noiseLabel(th: number): string {
  return th <= 0.62 ? 'Silent studio' : th <= 0.78 ? 'Quiet room' : th <= 0.88 ? 'Some background' : 'Noisy street'
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

const HEAD = 'display:flex;align-items:flex-start;justify-content:space-between'
const TITLE = 'font-size:16px;font-weight:650'
const SUB = 'font-size:12.5px;color:#9BA0AC;margin-top:5px;line-height:1.5'
const CLOSE = 'color:#9BA0AC;font-size:15px;padding:4px 8px;border-radius:8px;cursor:pointer;margin:-4px -6px 0 0'

export default function SilenceSettingsModal(): JSX.Element | null {
  const sil = useSilence()
  const [view, setView] = useState<Preset>(sil.detected)
  // "Protect first pause after each sentence" has no engine field (flagged):
  // kept visible per the approved design, held in local UI state only.
  const [protectFirst, setProtectFirst] = useState(false)
  if (!sil.show) return null

  const pick = (p: Preset): void => {
    setView(p)
    if (p !== 'custom') sil.applyPreset(p)
  }
  const set = (k: keyof VadSilenceSettings, v: number): void => { sil.setField(k, v); setView('custom') }

  const footer = (mt: string): JSX.Element => (
    <div style={css(`display:flex;align-items:center;margin-top:${mt}`)}>
      <span onClick={sil.reset} style={css(FOOT_RESET)}>Reset to default</span>
      <div style={css('flex:1')} />
      <span onClick={sil.close} style={css(FOOT_CANCEL)}>Cancel</span>
      <button onClick={sil.close} style={css(FOOT_APPLY)}>Apply</button>
    </div>
  )
  const header = (
    <div style={css(HEAD)}>
      <div>
        <div style={css(TITLE)}>Silence Settings</div>
        <div style={css(SUB)}>Controls silence detection only — retake detection is unaffected.</div>
      </div>
      <div onClick={sil.close} style={css(CLOSE)}>✕</div>
    </div>
  )

  const isCustom = view === 'custom'
  const tile = 'border:1px solid rgba(255,255,255,.09);border-radius:12px;padding:13px 14px;cursor:pointer'
  const tileDesc = 'font-size:11.5px;color:#9BA0AC;margin-top:4px;line-height:1.45'
  const sel = (p: Preset): boolean => view === p

  return (
    <div onClick={sil.close} style={css('position:fixed;inset:0;background:rgba(10,11,14,.55);display:grid;place-items:center;z-index:1000')}>
      <div onClick={(e) => e.stopPropagation()} style={css('width:440px;max-width:92vw;background:#1E2026;border:1px solid rgba(255,255,255,.1);border-radius:10px;box-shadow:0 24px 64px rgba(0,0,0,.6);padding:22px')}>
        {header}
        {!isCustom ? (
          <>
            <div style={css('display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:18px')}>
              <div onClick={() => pick('conservative')} style={css(sel('conservative') ? 'border:1.5px solid #6E6AE8;border-radius:12px;padding:13px 14px;background:rgba(110,106,232,.07);cursor:pointer;position:relative' : tile)}>
                <div style={css(sel('conservative') ? 'font-size:13px;font-weight:600;color:#B7B5F4' : 'font-size:13px;font-weight:600')}>Conservative</div>
                <div style={css(tileDesc)}>Only trims pauses longer than 2 seconds</div>
                {sel('conservative') && <div style={css('position:absolute;top:10px;right:10px;width:15px;height:15px;border-radius:50%;background:#6E6AE8;display:grid;place-items:center;color:#fff;font-size:8px')}>✓</div>}
              </div>
              <div onClick={() => pick('balanced')} style={css(sel('balanced') ? 'border:1.5px solid #6E6AE8;border-radius:12px;padding:13px 14px;background:rgba(110,106,232,.07);cursor:pointer;position:relative' : tile)}>
                <div style={css(sel('balanced') ? 'font-size:13px;font-weight:600;color:#B7B5F4' : 'font-size:13px;font-weight:600')}>Balanced</div>
                <div style={css(tileDesc)}>Trims pauses over 1 second, keeps natural rhythm</div>
                {sel('balanced') && <div style={css('position:absolute;top:10px;right:10px;width:15px;height:15px;border-radius:50%;background:#6E6AE8;display:grid;place-items:center;color:#fff;font-size:8px')}>✓</div>}
              </div>
              <div onClick={() => pick('aggressive')} style={css(sel('aggressive') ? 'border:1.5px solid #6E6AE8;border-radius:12px;padding:13px 14px;background:rgba(110,106,232,.07);cursor:pointer;position:relative' : tile)}>
                <div style={css(sel('aggressive') ? 'font-size:13px;font-weight:600;color:#B7B5F4' : 'font-size:13px;font-weight:600')}>Aggressive</div>
                <div style={css(tileDesc)}>Tight, fast-paced — trims anything over half a second</div>
                {sel('aggressive') && <div style={css('position:absolute;top:10px;right:10px;width:15px;height:15px;border-radius:50%;background:#6E6AE8;display:grid;place-items:center;color:#fff;font-size:8px')}>✓</div>}
              </div>
              <div onClick={() => pick('custom')} style={css(tile)}>
                <div style={css('font-size:13px;font-weight:600')}>Custom</div>
                <div style={css(tileDesc)}>Fine-tune every threshold yourself</div>
              </div>
            </div>
            <div style={css('margin-top:16px;background:#191B20;border-radius:10px;padding:11px 14px;font-size:12px;color:#9BA0AC;line-height:1.5')}>With <span style={css('color:#E9EAEE;font-weight:550')}>{view.charAt(0).toUpperCase() + view.slice(1)}</span>, pauses longer than <span style={css('color:#E9EAEE')}>{sil.s.minGapS.toFixed(1)}s</span> are shortened, with a little breathing room kept around speech.</div>
            {footer('20px')}
          </>
        ) : (
          <>
            <div style={css('display:flex;gap:8px;margin-top:18px')}>
              {(['conservative', 'balanced', 'aggressive'] as const).map((p) => (
                <div key={p} onClick={() => pick(p)} style={css('flex:1;border:1px solid rgba(255,255,255,.09);border-radius:10px;padding:9px 0;text-align:center;font-size:12px;color:#9BA0AC;cursor:pointer;text-transform:capitalize')}>{p}</div>
              ))}
              <div style={css('flex:1;border:1.5px solid #6E6AE8;border-radius:10px;padding:9px 0;text-align:center;font-size:12px;font-weight:600;color:#B7B5F4;background:rgba(110,106,232,.07)')}>Custom</div>
            </div>
            <div style={css('display:flex;flex-direction:column;gap:18px;margin-top:20px')}>
              <Slider label="Trim pauses longer than" value={sil.s.minGapS} min={0.3} max={2} step={0.1} fmt={(v) => `${v.toFixed(1)} s`} lo="0.3s · tight" hi="3s · relaxed" onChange={(v) => set('minGapS', v)} />
              <Slider label="Leave this much pause" value={sil.s.padAfterS} min={0} max={0.4} step={0.01} fmt={(v) => `${v.toFixed(2)} s`} lo="none · jump cuts" hi="1s · gentle" onChange={(v) => set('padAfterS', v)} />
              <Slider label="Background noise level" value={sil.s.speechThreshold} min={0.5} max={0.95} step={0.01} fmt={noiseLabel} lo="silent studio" hi="noisy street" onChange={(v) => set('speechThreshold', v)} />
              <div style={css('display:flex;align-items:center;gap:9px')}>
                <div onClick={() => setProtectFirst((v) => !v)} style={css(protectFirst ? 'width:32px;height:18px;border-radius:9px;background:#6E6AE8;position:relative;flex:none;cursor:pointer' : 'width:32px;height:18px;border-radius:9px;background:#3A3E48;position:relative;flex:none;cursor:pointer')}>
                  <div style={css(protectFirst ? 'position:absolute;right:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff' : 'position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#9BA0AC')} />
                </div>
                <div style={css('font-size:12px;color:#C6C9D2')}>Protect the first pause after each sentence</div>
              </div>
            </div>
            {footer('22px')}
          </>
        )}
      </div>
    </div>
  )
}
