import { useEffect, useState } from 'react'
import {
  DEFAULT_RETAKE_FINAL_BOSS_SETTINGS,
  type RetakeFinalBossSettings
} from '@shared/retakefinalboss'
import { css } from '../css'
import { useSilence } from '../data/useSilence'

const FOOT_RESET = 'font-size:12.5px;color:#9BA0AC;cursor:pointer;padding:7px 10px;border-radius:8px'
const FOOT_CANCEL = 'font-size:12.5px;color:#C6C9D2;cursor:pointer;padding:8px 14px;border-radius:9px'
const FOOT_APPLY = 'background:#6E6AE8;border:none;color:#fff;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:9px 18px;cursor:pointer;margin-left:8px'

function Slider({ label, description, value, min, max, step, format, low, high, onChange }: {
  label: string
  description: string
  value: number
  min: number
  max: number
  step: number
  format: (value: number) => string
  low: string
  high: string
  onChange: (value: number) => void
}): JSX.Element {
  const percent = `${Math.max(0, Math.min(1, (value - min) / (max - min))) * 100}%`
  return (
    <div>
      <div style={css('display:flex;justify-content:space-between;font-size:12.5px')}>
        <span style={css('color:#E9EAEE;font-weight:550')}>{label}</span>
        <span style={css("font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:#B7B5F4")}>{format(value)}</span>
      </div>
      <div style={css('font-size:11px;color:#7E8393;margin-top:3px;line-height:1.45')}>{description}</div>
      <div style={css('height:4px;border-radius:2px;background:#2A2D36;position:relative;margin-top:11px')}>
        <div style={css(`width:${percent};height:100%;border-radius:2px;background:#6E6AE8`)} />
        <div style={css(`position:absolute;left:${percent};top:50%;transform:translate(-50%,-50%);width:14px;height:14px;border-radius:50%;background:#E9EAEE;box-shadow:0 1px 4px rgba(0,0,0,.4)`)} />
        <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))}
          style={css('position:absolute;left:0;right:0;top:-8px;bottom:-8px;width:100%;height:auto;margin:0;opacity:0;cursor:pointer')} />
      </div>
      <div style={css('display:flex;justify-content:space-between;font-size:10.5px;color:#565C68;margin-top:6px')}><span>{low}</span><span>{high}</span></div>
    </div>
  )
}

export default function SilenceSettingsModal(): JSX.Element | null {
  const model = useSilence()
  const [draft, setDraft] = useState<RetakeFinalBossSettings>(model.settings)
  useEffect(() => {
    if (model.show) setDraft({ ...model.settings })
  }, [model.show])
  if (!model.show) return null

  const set = (key: keyof RetakeFinalBossSettings, value: number): void =>
    setDraft((current) => ({ ...current, [key]: value }))

  return (
    <div onClick={model.close} style={css('position:fixed;inset:0;background:rgba(10,11,14,.55);display:grid;place-items:center;z-index:1000')}>
      <div onClick={(event) => event.stopPropagation()} style={css('width:440px;max-width:92vw;background:#1E2026;border:1px solid rgba(255,255,255,.1);border-radius:10px;box-shadow:0 24px 64px rgba(0,0,0,.6);padding:22px;max-height:90vh;overflow-y:auto')}>
        <div style={css('display:flex;align-items:flex-start;justify-content:space-between')}>
          <div>
            <div style={css('font-size:16px;font-weight:650')}>Retake Final Boss · Silence</div>
            <div style={css('font-size:12.5px;color:#9BA0AC;margin-top:5px;line-height:1.5')}>FunASR FSMN-VAD runs with its published defaults. These controls only shape the cut seam after detection.</div>
          </div>
          <div onClick={model.close} style={css('color:#9BA0AC;font-size:15px;padding:4px 8px;border-radius:8px;cursor:pointer;margin:-4px -6px 0 0')}>✕</div>
        </div>

        <div style={css('display:flex;flex-direction:column;gap:20px;margin-top:20px')}>
          <Slider
            label="Padding after speech"
            description="Audio kept immediately after the previous word."
            value={draft.padAfterS}
            min={0}
            max={0.5}
            step={0.01}
            format={(value) => `${value.toFixed(2)} s`}
            low="none"
            high="0.50 s"
            onChange={(value) => set('padAfterS', value)}
          />
          <Slider
            label="Padding before speech"
            description="Audio kept immediately before the next word begins."
            value={draft.padBeforeS}
            min={0}
            max={0.5}
            step={0.01}
            format={(value) => `${value.toFixed(2)} s`}
            low="none"
            high="0.50 s"
            onChange={(value) => set('padBeforeS', value)}
          />
          <Slider
            label="Trim edges"
            description="Consumes part of the padding for tighter cuts, without entering a surviving word."
            value={draft.trimEdgesS}
            min={0}
            max={0.2}
            step={0.01}
            format={(value) => `${Math.round(value * 1000)} ms`}
            low="off"
            high="200 ms"
            onChange={(value) => set('trimEdgesS', value)}
          />
          <div style={css('border-top:1px solid rgba(255,255,255,.07);padding-top:18px')}>
            <Slider
              label="Audio overlap"
              description="Crossfades the audio at every executed join to prevent clicks."
              value={draft.audioOverlapMs}
              min={0}
              max={60}
              step={1}
              format={(value) => `${Math.round(value)} ms`}
              low="0 · hard cut"
              high="60 ms · smoother"
              onChange={(value) => set('audioOverlapMs', value)}
            />
          </div>
        </div>

        <div style={css('font-size:11px;color:#7E8393;line-height:1.5;margin-top:18px;padding:10px 12px;background:#191B20;border-radius:8px')}>
          Final Boss never uses transcript-predicted silence. Oversized VAD regions are split around surviving AssemblyAI words, so background noise can be removed without cutting through speech.
        </div>

        <div style={css('display:flex;align-items:center;margin-top:20px')}>
          <span onClick={() => setDraft({ ...DEFAULT_RETAKE_FINAL_BOSS_SETTINGS })} style={css(FOOT_RESET)}>Reset to default</span>
          <div style={css('flex:1')} />
          <span onClick={model.close} style={css(FOOT_CANCEL)}>Cancel</span>
          <button onClick={() => { model.commit(draft); model.close() }} style={css(FOOT_APPLY)}>Apply</button>
        </div>
      </div>
    </div>
  )
}
