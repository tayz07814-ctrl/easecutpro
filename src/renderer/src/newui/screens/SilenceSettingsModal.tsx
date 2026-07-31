import { css } from '../css'
import { useSilence } from '../data/useSilence'
import type { RetakeFinalBossSettings } from '@shared/retakefinalboss'

// Silence Settings — FSMN (FunASR) engine. The detector runs at the model's
// fixed published defaults (no strictness dial), so these controls only shape the
// SEAM geometry around each detected pause: how much audio to protect before/after
// speech, how tightly to trim the cut edges, and the crossfade at the join.

const FOOT_RESET = 'font-size:12.5px;color:#9a9aae;cursor:pointer;padding:7px 10px;border-radius:8px'
const FOOT_CANCEL = 'font-size:12.5px;color:#c9c9da;cursor:pointer;padding:8px 14px;border-radius:9px'
const FOOT_APPLY = 'background:#7c6bff;border:none;color:#fff;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:9px 18px;cursor:pointer;margin-left:8px'

function Slider({ label, value, min, max, step, fmt, lo, hi, onChange }: {
  label: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string; lo: string; hi: string; onChange: (v: number) => void
}): JSX.Element {
  const pct = `${Math.max(0, Math.min(1, (value - min) / (max - min))) * 100}%`
  return (
    <div>
      <div style={css('display:flex;justify-content:space-between;font-size:12.5px')}><span style={css('color:#ededf2;font-weight:550')}>{label}</span><span style={css("font-family:'Geist Mono',monospace;font-size:11.5px;color:#a99bff")}>{fmt(value)}</span></div>
      <div style={css('height:4px;border-radius:2px;background:#22222b;position:relative;margin-top:10px')}>
        <div style={css(`width:${pct};height:100%;border-radius:2px;background:#7c6bff`)} />
        <div style={css(`position:absolute;left:${pct};top:50%;transform:translate(-50%,-50%);width:14px;height:14px;border-radius:50%;background:#ededf2;box-shadow:0 1px 4px rgba(0,0,0,.4)`)} />
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))}
          style={css('position:absolute;left:0;right:0;top:-8px;bottom:-8px;width:100%;height:auto;margin:0;opacity:0;cursor:pointer')} />
      </div>
      <div style={css('display:flex;justify-content:space-between;font-size:10.5px;color:#55556a;margin-top:6px')}><span>{lo}</span><span>{hi}</span></div>
    </div>
  )
}

const CHIP = 'font-size:11.5px;padding:6px 12px;border-radius:999px;cursor:pointer;border:1px solid rgba(255,255,255,.12);color:#9a9aae;background:transparent;font-family:inherit'
const CHIP_ON = 'font-size:11.5px;padding:6px 12px;border-radius:999px;cursor:pointer;border:1px solid #7c6bff;color:#a99bff;background:rgba(124,107,255,.12);font-weight:600;font-family:inherit'

// One-line summary of a fixed preset's pauses, shown instead of sliders.
function presetBlurb(padBeforeS: number, padAfterS: number): string {
  const total = padBeforeS + padAfterS
  if (total <= 0) return 'Cuts flush to speech — no pause kept. Punchiest.'
  if (total <= 0.4) return `Keeps a tight ${padBeforeS.toFixed(2)}s lead-in and ${padAfterS.toFixed(2)}s tail.`
  return `Keeps a relaxed ${padBeforeS.toFixed(2)}s lead-in and ${padAfterS.toFixed(2)}s tail.`
}

const TAIL_NOTE = 'Also drops a trailing 200 ms wherever a clip ends on dead air.'

export default function SilenceSettingsModal(): JSX.Element | null {
  const sil = useSilence()
  if (!sil.show) return null

  // Numeric fields only — tailTrim is a boolean and goes through sil.setTailTrim.
  const set = (k: Exclude<keyof RetakeFinalBossSettings, 'tailTrim'>, v: number): void => sil.setField(k, v)

  return (
    <div onClick={sil.close} style={css('position:fixed;inset:0;background:rgba(8,8,10,.55);display:grid;place-items:center;z-index:1000')}>
      <div onClick={(e) => e.stopPropagation()} style={css('width:440px;max-width:92vw;background:#101015;border:1px solid rgba(255,255,255,.1);border-radius:10px;box-shadow:0 24px 64px rgba(0,0,0,.6);padding:22px;max-height:90vh;overflow-y:auto')}>
        <div style={css('display:flex;align-items:flex-start;justify-content:space-between')}>
          <div>
            <div style={css('font-size:16px;font-weight:650')}>Silence Settings</div>
            <div style={css('font-size:12.5px;color:#9a9aae;margin-top:5px;line-height:1.5')}>Pick a vibe. FSMN detects the speech automatically — Retake detection is unaffected.</div>
          </div>
          <div onClick={sil.close} style={css('color:#9a9aae;font-size:15px;padding:4px 8px;border-radius:8px;cursor:pointer;margin:-4px -6px 0 0')}>✕</div>
        </div>

        {/* Preset chips — the last (Mad Scientist) reveals the sliders. */}
        <div style={css('display:flex;gap:6px;margin-top:16px;flex-wrap:wrap')}>
          {sil.presets.map((p) => (
            <button key={p.id} onClick={() => sil.applyPreset(p.id)} style={css(sil.preset === p.id ? CHIP_ON : CHIP)}>{p.label}</button>
          ))}
        </div>

        {/* Custom sliders — ONLY for the editable preset (Mad Scientist). */}
        {sil.editable ? (
          <div style={css('display:flex;flex-direction:column;gap:18px;margin-top:18px')}>
            <Slider label="Keep before speech" value={sil.s.padBeforeS} min={0} max={0.5} step={0.01} fmt={(v) => `${v.toFixed(2)} s`} lo="0s · tight" hi="0.5s · gentle lead-in" onChange={(v) => set('padBeforeS', v)} />
            <Slider label="Keep after speech" value={sil.s.padAfterS} min={0} max={0.5} step={0.01} fmt={(v) => `${v.toFixed(2)} s`} lo="0s · tight" hi="0.5s · gentle tail" onChange={(v) => set('padAfterS', v)} />
            <Slider label="Tighten cut edges" value={sil.s.trimEdgesS} min={0} max={0.2} step={0.01} fmt={(v) => `${v.toFixed(2)} s`} lo="0s · safe" hi="0.2s · tighter" onChange={(v) => set('trimEdgesS', v)} />
            {/* Quiet-tail trim — preset-driven elsewhere, tweakable here. */}
            <div style={css('display:flex;align-items:flex-start;gap:11px')}>
              <div onClick={() => sil.setTailTrim(!sil.s.tailTrim)} style={css(`width:32px;height:18px;border-radius:9px;position:relative;flex:none;cursor:pointer;margin-top:1px;background:${sil.s.tailTrim ? '#7c6bff' : '#2a2a34'}`)}>
                <div style={css(sil.s.tailTrim ? 'position:absolute;right:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff' : 'position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#9a9aae')} />
              </div>
              <div style={css('flex:1;min-width:0')}>
                <div style={css('font-size:12.5px;color:#ededf2;font-weight:550')}>Trim dead-air tails</div>
                <div style={css('font-size:11px;color:#9a9aae;margin-top:3px;line-height:1.45')}>When a clip ends on a breath or room tone instead of a word, drop the last 200 ms. Only looks at clip endings — openings are never touched.</div>
              </div>
            </div>
          </div>
        ) : (
          <div style={css('font-size:12px;color:#71718a;margin-top:14px;line-height:1.5;min-height:34px')}>
            {presetBlurb(sil.s.padBeforeS, sil.s.padAfterS)}
            {sil.s.tailTrim ? ` ${TAIL_NOTE}` : ''} <span style={css('color:#55556a')}>Pick <b style={css('color:#9a9aae')}>Mad Scientist</b> to fine-tune.</span>
          </div>
        )}

        {/* Seam blend ("overlap") — only tweakable in the custom preset; fixed
            presets set their own overlap. */}
        {sil.editable && (
          <div style={css('margin-top:18px;border-top:1px solid rgba(255,255,255,.07);padding-top:16px;display:flex;flex-direction:column;gap:14px')}>
            <div style={css('display:flex;align-items:flex-start;gap:11px')}>
              <div onClick={() => sil.setSeamFade({ enabled: !sil.seamFade.enabled })} style={css(`width:32px;height:18px;border-radius:9px;position:relative;flex:none;cursor:pointer;margin-top:1px;background:${sil.seamFade.enabled ? '#7c6bff' : '#2a2a34'}`)}>
                <div style={css(sil.seamFade.enabled ? 'position:absolute;right:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff' : 'position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#9a9aae')} />
              </div>
              <div style={css('flex:1;min-width:0')}>
                <div style={css('font-size:12.5px;color:#ededf2;font-weight:550')}>Blend audio at cuts (overlap)</div>
                <div style={css('font-size:11px;color:#9a9aae;margin-top:3px;line-height:1.45')}>Crossfades the join: the outgoing audio tails off under the incoming words. Marked with ◢ on the timeline. Turn off for hard cuts.</div>
              </div>
            </div>
            {sil.seamFade.enabled && (
              <Slider label="Overlap amount" value={sil.seamFade.ms} min={0} max={60} step={1} fmt={(v) => `${Math.round(v)} ms`} lo="0 · hard cut" hi="60 ms · smoother" onChange={(v) => sil.setSeamFade({ ms: v })} />
            )}
          </div>
        )}

        <div style={css('display:flex;align-items:center;margin-top:20px')}>
          <span onClick={sil.reset} style={css(FOOT_RESET)}>Reset to default</span>
          <div style={css('flex:1')} />
          <span onClick={sil.close} style={css(FOOT_CANCEL)}>Cancel</span>
          <button onClick={sil.close} style={css(FOOT_APPLY)}>Apply</button>
        </div>
      </div>
    </div>
  )
}
