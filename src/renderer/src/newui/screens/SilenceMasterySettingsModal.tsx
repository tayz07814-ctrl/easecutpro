// Silence settings — the Silence Mastery engine (this branch's only silence
// cleaner). FINAL configuration: Silero VAD is the sole detector — the pass
// toggles are gone (locked in normalizeSilenceMastery). These sliders shape
// what Silero detects and are the complete parameter surface:
//
//   Min silence   — detected silences shorter than this are natural beats;
//                   left alone.
//   Pads          — silence kept at the detected edges (left = after the
//                   speech before the gap, right = before the speech after).
//   Trims         — cut PAST the detected edges into the neighbouring speech
//                   (left = sentence ending, right = next sentence's onset).
//
// Edits write straight to the persisted store settings, so the next
// "Clean Silence" / "Find cuts" run uses them. Opened from
// SpeechCleanerPanel / RetakeCleanerPanel; mounted in Editor + MobileEditor.

import { css } from '../css'
import { useStore } from '../../store'
import {
  DEFAULT_SILENCE_MASTERY_SETTINGS,
  SILENCE_MASTERY_PRESETS,
  matchSilenceMasteryPreset
} from '@shared/silenceMastery'

const CHIP = 'font-size:11.5px;padding:6px 12px;border-radius:999px;cursor:pointer;border:1px solid rgba(255,255,255,.12);color:#9a9aae;background:transparent;font-family:inherit'
const CHIP_ON = 'font-size:11.5px;padding:6px 12px;border-radius:999px;cursor:pointer;border:1px solid #7c6bff;color:#a99bff;background:rgba(124,107,255,.12);font-weight:600;font-family:inherit'

const FOOT_RESET = 'font-size:12.5px;color:#9a9aae;cursor:pointer;padding:7px 10px;border-radius:8px'
const FOOT_APPLY = 'background:#7c6bff;border:none;color:#fff;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:9px 18px;cursor:pointer;margin-left:8px'

function Slider({ label, hint, value, min, max, step, fmt, lo, hi, onChange }: {
  label: string; hint: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string; lo: string; hi: string; onChange: (v: number) => void
}): JSX.Element {
  const pct = `${Math.max(0, Math.min(1, (value - min) / (max - min))) * 100}%`
  return (
    <div>
      <div style={css('display:flex;justify-content:space-between;font-size:12.5px')}>
        <span style={css('color:#ededf2;font-weight:550')}>{label}</span>
        <span style={css("font-family:'Geist Mono',monospace;font-size:11.5px;color:#a99bff")}>{fmt(value)}</span>
      </div>
      <div style={css('font-size:11px;color:#71718a;margin-top:3px;line-height:1.45')}>{hint}</div>
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

export default function SilenceMasterySettingsModal(): JSX.Element | null {
  const show = useStore((s) => s.showSilenceMasterySettings)
  const close = useStore((s) => s.setShowSilenceMasterySettings)
  const st = useStore((s) => s.silenceMasterySettings)
  const setSt = useStore((s) => s.setSilenceMasterySettings)
  if (!show) return null

  return (
    <div onClick={() => close(false)} style={css('position:fixed;inset:0;background:rgba(8,8,10,.55);display:grid;place-items:center;z-index:1000')}>
      <div onClick={(e) => e.stopPropagation()} style={css('width:440px;max-width:92vw;background:#101015;border:1px solid rgba(255,255,255,.1);border-radius:10px;box-shadow:0 24px 64px rgba(0,0,0,.6);padding:22px;max-height:90vh;overflow-y:auto')}>
        <div style={css('display:flex;align-items:flex-start;justify-content:space-between')}>
          <div>
            <div style={css('font-size:16px;font-weight:650')}>Silence settings</div>
            <div style={css('font-size:12.5px;color:#9a9aae;margin-top:5px;line-height:1.5')}>A neural voice detector (Silero VAD) listens to your audio and removes everything that isn’t speech — the quiet before the first word, every long gap, and the dead air after the last one. Find cuts runs it too, as its final step.</div>
          </div>
          <div onClick={() => close(false)} style={css('color:#9a9aae;font-size:15px;padding:4px 8px;border-radius:8px;cursor:pointer;margin:-4px -6px 0 0')}>✕</div>
        </div>

        {/* Presets — 4 fixed recipes. The 5th chip, Mad Scientist, has no fixed
            values: its lever below unlocks the sliders for hand-tuning. */}
        <div style={css('display:flex;gap:6px;margin-top:16px;flex-wrap:wrap')}>
          {SILENCE_MASTERY_PRESETS.map((p) => (
            <button key={p.id} onClick={() => setSt({ ...p.values })} style={css(!st.madScientist && matchSilenceMasteryPreset(st) === p.id ? CHIP_ON : CHIP)}>{p.label}</button>
          ))}
        </div>

        {/* Mad Scientist — the lever. ON unlocks the sliders (start from the
            current values); OFF locks back to presets, snapping stray values
            to the default (Flash) when they match no preset. */}
        <div style={css('display:flex;align-items:center;gap:11px;margin-top:16px')}>
          <div
            onClick={() => {
              if (st.madScientist) {
                const back = matchSilenceMasteryPreset(st) ? {} : { ...DEFAULT_SILENCE_MASTERY_SETTINGS }
                setSt({ ...back, madScientist: false })
              } else setSt({ madScientist: true })
            }}
            style={css(`width:32px;height:18px;border-radius:9px;position:relative;flex:none;cursor:pointer;background:${st.madScientist ? '#7c6bff' : '#2a2a34'}`)}
          >
            <div style={css(st.madScientist ? 'position:absolute;right:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff' : 'position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#9a9aae')} />
          </div>
          <div style={css('flex:1;min-width:0')}>
            <div style={css(`font-size:12.5px;font-weight:600;color:${st.madScientist ? '#a99bff' : '#ededf2'}`)}>Mad Scientist 🧪</div>
            <div style={css('font-size:11px;color:#9a9aae;margin-top:2px;line-height:1.45')}>Roll your own: unlock the sliders and tune every value by hand.</div>
          </div>
        </div>

        {st.madScientist && (
        <div style={css('display:flex;flex-direction:column;gap:18px;margin-top:18px')}>
          <Slider
            label="Min silence to remove"
            hint="Gaps shorter than this are natural pauses — they stay."
            value={st.minSilenceS} min={0.1} max={3} step={0.05}
            fmt={(v) => `${v.toFixed(2)} s`} lo="0.1s · cuts more" hi="3s · cuts less"
            onChange={(v) => setSt({ minSilenceS: v })}
          />
          <Slider
            label="Pad left of the gap"
            hint="Silence kept after the speech BEFORE a removed gap (applies to Silero\u2019s detected edges too), so tails can breathe."
            value={st.padLeftMs} min={0} max={500} step={10}
            fmt={(v) => `${Math.round(v)} ms`} lo="0 · flush" hi="500ms · roomy tail"
            onChange={(v) => setSt({ padLeftMs: v })}
          />
          <Slider
            label="Pad right of the gap"
            hint="Silence kept just before the speech AFTER a removed gap (applies to Silero\u2019s detected edges too), protecting soft onsets."
            value={st.padRightMs} min={0} max={500} step={10}
            fmt={(v) => `${Math.round(v)} ms`} lo="0 · flush" hi="500ms · gentle lead-in"
            onChange={(v) => setSt({ padRightMs: v })}
          />
          <Slider
            label="Trim left (sentence ending)"
            hint="Cuts PAST the detected silence into the tail of the sentence BEFORE the gap — eats trailing breaths/dead air the detector kept."
            value={st.trimLeftMs} min={0} max={500} step={5}
            fmt={(v) => `${Math.round(v)} ms`} lo="0 · safe" hi="500ms · aggressive"
            onChange={(v) => setSt({ trimLeftMs: v })}
          />
          <Slider
            label="Trim right (next sentence start)"
            hint="Cuts PAST the detected silence into the onset of the sentence AFTER the gap — snappier pickups."
            value={st.trimRightMs} min={0} max={500} step={5}
            fmt={(v) => `${Math.round(v)} ms`} lo="0 · safe" hi="500ms · aggressive"
            onChange={(v) => setSt({ trimRightMs: v })}
          />
          {/* Breath cleanup — Flash/Cut Throat carry it on, the gentle presets
              off; Mad Scientists decide for themselves here. */}
          <div style={css('display:flex;align-items:flex-start;gap:11px')}>
            <div onClick={() => setSt({ breathRefine: !st.breathRefine })} style={css(`width:32px;height:18px;border-radius:9px;position:relative;flex:none;cursor:pointer;margin-top:1px;background:${st.breathRefine ? '#7c6bff' : '#2a2a34'}`)}>
              <div style={css(st.breathRefine ? 'position:absolute;right:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff' : 'position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#9a9aae')} />
            </div>
            <div style={css('flex:1;min-width:0')}>
              <div style={css('font-size:12.5px;color:#ededf2;font-weight:550')}>Breath cleanup (sentence endings)</div>
              <div style={css('font-size:11px;color:#9a9aae;margin-top:3px;line-height:1.45')}>Walks each cut back over the exhale at the end of a sentence until the voice actually stops (max 1.5s), keeping a 100ms fade so word endings stay natural. Endings only — the next sentence’s onset is never touched.</div>
            </div>
          </div>
        </div>
        )}

        <div style={css('display:flex;align-items:center;margin-top:20px')}>
          <span onClick={() => setSt({ ...DEFAULT_SILENCE_MASTERY_SETTINGS })} style={css(FOOT_RESET)}>Reset to default (Flash)</span>
          <div style={css('flex:1')} />
          <button onClick={() => close(false)} style={css(FOOT_APPLY)}>Done</button>
        </div>
      </div>
    </div>
  )
}
