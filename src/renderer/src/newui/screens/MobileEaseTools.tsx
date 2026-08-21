import { useState } from 'react'
import { css } from '../css'
import { useRetake } from '../data/useRetake'

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }): JSX.Element {
  return on ? (
    <div onClick={onClick} style={css('width:44px;height:26px;border-radius:13px;background:#7C5CFF;position:relative;flex:none;cursor:pointer')}>
      <div style={css('position:absolute;right:2px;top:2px;width:22px;height:22px;border-radius:50%;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.3)')} />
    </div>
  ) : (
    <div onClick={onClick} style={css('width:44px;height:26px;border-radius:13px;background:#2a2a34;border:1px solid rgba(255,255,255,.1);position:relative;flex:none;cursor:pointer')}>
      <div style={css('position:absolute;left:2px;top:1px;width:22px;height:22px;border-radius:50%;background:#5a5a66')} />
    </div>
  )
}

function ToolCard({ icon, title, sub, onClick }: { icon: string; title: string; sub: string; onClick: () => void }): JSX.Element {
  return (
    <div onClick={onClick} style={css('display:flex;gap:12px;align-items:center;padding:12px 14px;background:#0B0B12;border:1px solid rgba(255,255,255,.06);border-radius:12px;cursor:pointer')}>
      <div style={css('width:36px;height:36px;border-radius:9px;background:#1E1E26;display:grid;place-items:center;color:#9a9aae;font-size:16px;flex:none')}>{icon}</div>
      <div style={css('flex:1;min-width:0')}><div style={css('font-size:13px;font-weight:600;color:#E7E7EA')}>{title}</div><div style={css('font-size:11px;color:#6e6e85;margin-top:2px')}>{sub}</div></div>
      <span style={css('color:#6e6e85;font-size:14px')}>›</span>
    </div>
  )
}

export default function MobileEaseTools({ onClose }: { onClose?: () => void }): JSX.Element {
  const r = useRetake()
  const [noise, setNoise] = useState(true)
  const [applyImmediate, setApplyImmediate] = useState(false)
  const cleanSilenceOnly = (): void => { void r.findSilences() ; onClose?.() }
  const cleanSpeech = (): void => { void r.find(); onClose?.() }

  return (
    <div style={css('flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;padding:14px 16px 20px;background:#141418')}>
      <div style={css('display:flex;align-items:center;gap:8px')}>
        <span style={css('color:#7C5CFF;font-size:14px')}>⚡</span><span style={css('font-size:15px;font-weight:700;color:#E7E7EA')}>EaseTools</span><span style={css('font-size:9px;font-weight:700;letter-spacing:.06em;color:#8b8ba0;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.1);border-radius:5px;padding:2px 6px')}>BETA</span>
      </div>
      <div style={css('font-size:10px;font-weight:600;letter-spacing:.08em;color:#6e6e85;margin-top:6px')}>SPEECH CLEANER</div>

      <button onClick={cleanSpeech} style={css('width:100%;margin-top:12px;background:linear-gradient(100deg,#7C5CFF,#A468FF);border:none;color:#fff;font-family:inherit;font-size:13px;font-weight:700;border-radius:12px;padding:14px 0;cursor:pointer;box-shadow:0 4px 16px rgba(124,92,255,.3)')}>Clean speech — silences, fillers & bad takes</button>
      <button onClick={cleanSilenceOnly} style={css('width:100%;margin-top:10px;background:rgba(16, 78, 64,.6);border:1px solid #1e5f4a;color:#7ED6A6;font-family:inherit;font-size:13px;font-weight:700;border-radius:12px;padding:13px 0;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px')}>◉ Clean Silence only (Silero)</button>

      <div style={css('margin-top:16px;display:flex;align-items:center;justify-content:space-between;gap:12px')}>
        <div><div style={css('font-size:13px;font-weight:500;color:#E7E7EA')}>Noise removal +40 dB gain</div><div style={css('font-size:11px;color:#6e6e85;margin-top:3px;line-height:1.4')}>Removes stationary noise then boosts the signal before Silero VAD. Disable for raw VAD on the original audio.</div></div>
        <Toggle on={noise} onClick={() => setNoise(v=>!v)} />
      </div>
      <div style={css('margin-top:14px;display:flex;align-items:center;justify-content:space-between;gap:12px')}>
        <div><div style={css('font-size:13px;font-weight:500;color:#E7E7EA')}>Apply cuts immediately</div><div style={css('font-size:11px;color:#6e6e85;margin-top:3px')}>Cuts are previewed on the timeline first — inspect them, then Apply or Discard.</div></div>
        <Toggle on={applyImmediate} onClick={() => setApplyImmediate(v=>!v)} />
      </div>

      <button onClick={() => r.openSilenceSettings()} style={css('width:100%;margin-top:14px;background:transparent;border:1px solid rgba(255,255,255,.08);color:#C6C9D2;font-family:inherit;font-size:13px;font-weight:500;border-radius:12px;padding:12px 0;cursor:pointer')}>Silence Settings</button>

      <div style={css('font-size:10px;font-weight:600;letter-spacing:.08em;color:#6e6e85;margin-top:18px;margin-bottom:10px')}>MORE TOOLS</div>
      <div style={css('display:flex;flex-direction:column;gap:10px')}>
        <ToolCard icon="🔍" title="Zoom" sub="Auto punch-ins on the strongest moments." onClick={() => { void r.autoZoom(); onClose?.() }} />
        <ToolCard icon="🖼" title="Overlays" sub="Drop images / B-roll over the video." onClick={() => void (window as unknown as { ecToast?: (m:string)=>void }).ecToast?.('Overlays — coming soon')} />
        <ToolCard icon="⧉" title="Variations" sub="Recut the same footage into a new edit." onClick={() => void (window as unknown as { ecToast?: (m:string)=>void }).ecToast?.('Variations — coming soon')} />
      </div>
    </div>
  )
}
