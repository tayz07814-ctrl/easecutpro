// Silence settings — the Silence Mastery engine (this branch's only silence
// cleaner). The engine keeps the transcript's word timestamps and removes
// everything else; these four sliders are its complete parameter surface:
//
//   Min silence   — gaps shorter than this are natural beats; left alone.
//   Pad left      — silence kept right AFTER the word before a removed gap.
//   Pad right     — silence kept just BEFORE the word after a removed gap.
//   Trim edges    — moves the cutter INTO the neighbouring word timestamps
//                   by N ms (eats ASR dead air baked into word ends).
//
// Edits write straight to the persisted store settings, so the next
// "Clean Silence" run uses them. Opened from SpeechCleanerPanel /
// RetakeCleanerPanel; mounted in Editor + MobileEditor.

import { css } from '../css'
import { useStore } from '../../store'
import { DEFAULT_SILENCE_MASTERY_SETTINGS } from '@shared/silenceMastery'

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
            <div style={css('font-size:12.5px;color:#9a9aae;margin-top:5px;line-height:1.5')}>Clean Silence keeps your words and removes everything else — the quiet before the first word, every long gap between words, and the dead air after the last one.</div>
          </div>
          <div onClick={() => close(false)} style={css('color:#9a9aae;font-size:15px;padding:4px 8px;border-radius:8px;cursor:pointer;margin:-4px -6px 0 0')}>✕</div>
        </div>

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
            hint="Silence kept right after the word BEFORE the gap, so word tails can breathe."
            value={st.padLeftMs} min={0} max={500} step={10}
            fmt={(v) => `${Math.round(v)} ms`} lo="0 · flush" hi="500ms · roomy tail"
            onChange={(v) => setSt({ padLeftMs: v })}
          />
          <Slider
            label="Pad right of the gap"
            hint="Silence kept just before the word AFTER the gap, protecting soft onsets."
            value={st.padRightMs} min={0} max={500} step={10}
            fmt={(v) => `${Math.round(v)} ms`} lo="0 · flush" hi="500ms · gentle lead-in"
            onChange={(v) => setSt({ padRightMs: v })}
          />
          <Slider
            label="Trim edges"
            hint="Moves the cutter INTO the word timestamps on both sides — eats dead air the transcriber baked into word ends. Never crosses a word's midpoint."
            value={st.trimEdgesMs} min={0} max={300} step={5}
            fmt={(v) => `${Math.round(v)} ms`} lo="0 · safe" hi="300ms · aggressive"
            onChange={(v) => setSt({ trimEdgesMs: v })}
          />
          {/* Stretched-word repair — the transcriber sometimes stamps one word
              across a whole pause (a 2.5s "Okay."), hiding silence where no gap
              rule can see it. */}
          <div style={css('display:flex;align-items:flex-start;gap:11px')}>
            <div onClick={() => setSt({ clampStretchedWords: !st.clampStretchedWords })} style={css(`width:32px;height:18px;border-radius:9px;position:relative;flex:none;cursor:pointer;margin-top:1px;background:${st.clampStretchedWords ? '#7c6bff' : '#2a2a34'}`)}>
              <div style={css(st.clampStretchedWords ? 'position:absolute;right:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff' : 'position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#9a9aae')} />
            </div>
            <div style={css('flex:1;min-width:0')}>
              <div style={css('font-size:12.5px;color:#ededf2;font-weight:550')}>Fix stretched words</div>
              <div style={css('font-size:11px;color:#9a9aae;margin-top:3px;line-height:1.45')}>The transcriber sometimes stamps one word across a whole pause (a 2.5s “Okay.”), hiding silence inside the word. This clamps implausibly long words so that hidden dead air gets cut too.</div>
            </div>
          </div>
          {/* Word-timestamp (transcript-gap) pass — the sliders above shape it. */}
          <div style={css('display:flex;align-items:flex-start;gap:11px')}>
            <div onClick={() => setSt({ gapPass: !st.gapPass })} style={css(`width:32px;height:18px;border-radius:9px;position:relative;flex:none;cursor:pointer;margin-top:1px;background:${st.gapPass ? '#7c6bff' : '#2a2a34'}`)}>
              <div style={css(st.gapPass ? 'position:absolute;right:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff' : 'position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#9a9aae')} />
            </div>
            <div style={css('flex:1;min-width:0')}>
              <div style={css('font-size:12.5px;color:#ededf2;font-weight:550')}>Word-timestamp pass</div>
              <div style={css('font-size:11px;color:#9a9aae;margin-top:3px;line-height:1.45')}>Cuts the gaps between transcript word stamps using the sliders above (transcribes first if needed). Off = Silero-only cleaning.</div>
            </div>
          </div>
          {/* Silero VAD — stage 1 of the hybrid; the neural ear cuts first. */}
          <div style={css('display:flex;align-items:flex-start;gap:11px')}>
            <div onClick={() => setSt({ sileroPass: !st.sileroPass })} style={css(`width:32px;height:18px;border-radius:9px;position:relative;flex:none;cursor:pointer;margin-top:1px;background:${st.sileroPass ? '#7c6bff' : '#2a2a34'}`)}>
              <div style={css(st.sileroPass ? 'position:absolute;right:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff' : 'position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#9a9aae')} />
            </div>
            <div style={css('flex:1;min-width:0')}>
              <div style={css('font-size:12.5px;color:#ededf2;font-weight:550')}>Silero VAD pass (runs first)</div>
              <div style={css('font-size:11px;color:#9a9aae;margin-top:3px;line-height:1.45')}>A neural voice detector listens to the audio and cuts what it hears as non-speech, keeping 100ms around every speech segment. The word-timestamp pass then sweeps whatever it left.</div>
            </div>
          </div>
          {/* RMS energy pass — the audio's own verdict, auto-thresholded. */}
          <div style={css('display:flex;align-items:flex-start;gap:11px')}>
            <div onClick={() => setSt({ rmsPass: !st.rmsPass })} style={css(`width:32px;height:18px;border-radius:9px;position:relative;flex:none;cursor:pointer;margin-top:1px;background:${st.rmsPass ? '#7c6bff' : '#2a2a34'}`)}>
              <div style={css(st.rmsPass ? 'position:absolute;right:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff' : 'position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#9a9aae')} />
            </div>
            <div style={css('flex:1;min-width:0')}>
              <div style={css('font-size:12.5px;color:#ededf2;font-weight:550')}>Energy pass (auto threshold)</div>
              <div style={css('font-size:11px;color:#9a9aae;margin-top:3px;line-height:1.45')}>Also listens to the actual audio: measures the clip’s own noise floor vs speech level and cuts every low-energy stretch the transcript missed — never within 100ms of a spoken word.</div>
            </div>
          </div>
        </div>

        <div style={css('display:flex;align-items:center;margin-top:20px')}>
          <span onClick={() => setSt({ ...DEFAULT_SILENCE_MASTERY_SETTINGS })} style={css(FOOT_RESET)}>Reset to default</span>
          <div style={css('flex:1')} />
          <button onClick={() => close(false)} style={css(FOOT_APPLY)}>Done</button>
        </div>
      </div>
    </div>
  )
}
