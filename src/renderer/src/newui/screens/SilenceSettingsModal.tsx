import { css } from '../css'
import { useSilence } from '../data/useSilence'
import { SilenceControls } from './SilenceControls'

// Silence Settings — ONE panel (chips + always-visible sliders, shared with the
// dedicated Silence tab via SilenceControls so the two surfaces can never drift).

const FOOT_RESET = 'font-size:12.5px;color:#9BA0AC;cursor:pointer;padding:7px 10px;border-radius:8px'
const FOOT_CANCEL = 'font-size:12.5px;color:#C6C9D2;cursor:pointer;padding:8px 14px;border-radius:9px'
const FOOT_APPLY = 'background:#6E6AE8;border:none;color:#fff;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:9px 18px;cursor:pointer;margin-left:8px'

export default function SilenceSettingsModal(): JSX.Element | null {
  const sil = useSilence()
  if (!sil.show) return null

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

        <SilenceControls sil={sil} />

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
