import { css } from '../css'

// Screen 1d — Silence Settings (presets, Custom with advanced sliders, and the
// modal-in-context scrim). Verbatim port. In Stage C the presets map to real
// VadSilenceSettings and Custom reveals the existing threshold controls.

const HEAD =
  'display:flex;align-items:flex-start;justify-content:space-between'
const TITLE = 'font-size:16px;font-weight:650'
const SUB = 'font-size:12.5px;color:#9BA0AC;margin-top:5px;line-height:1.5'
const CLOSE =
  'color:#9BA0AC;font-size:15px;padding:4px 8px;border-radius:8px;cursor:pointer;margin:-4px -6px 0 0'
const FOOT_RESET = 'font-size:12.5px;color:#9BA0AC;cursor:pointer;padding:7px 10px;border-radius:8px'
const FOOT_CANCEL = 'font-size:12.5px;color:#C6C9D2;cursor:pointer;padding:8px 14px;border-radius:9px'
const FOOT_APPLY = 'background:#6E6AE8;border:none;color:#fff;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:9px 18px;cursor:pointer;margin-left:8px'

function Slider({ label, value, w, lo, hi }: { label: string; value: string; w: string; lo: string; hi: string }): JSX.Element {
  return (
    <div>
      <div style={css('display:flex;justify-content:space-between;font-size:12.5px')}><span style={css('color:#E9EAEE;font-weight:550')}>{label}</span><span style={css("font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:#B7B5F4")}>{value}</span></div>
      <div style={css('height:4px;border-radius:2px;background:#2A2D36;position:relative;margin-top:10px')}>
        <div style={css(`width:${w};height:100%;border-radius:2px;background:#6E6AE8`)} />
        <div style={css(`position:absolute;left:${w};top:50%;transform:translate(-50%,-50%);width:14px;height:14px;border-radius:50%;background:#E9EAEE;box-shadow:0 1px 4px rgba(0,0,0,.4)`)} />
      </div>
      <div style={css('display:flex;justify-content:space-between;font-size:10.5px;color:#565C68;margin-top:6px')}><span>{lo}</span><span>{hi}</span></div>
    </div>
  )
}

function PresetsCard(): JSX.Element {
  const tile = 'border:1px solid rgba(255,255,255,.09);border-radius:12px;padding:13px 14px;cursor:pointer'
  const tileName = 'font-size:13px;font-weight:600'
  const tileDesc = 'font-size:11.5px;color:#9BA0AC;margin-top:4px;line-height:1.45'
  return (
    <div style={css('width:440px;background:#1E2026;padding:22px')} className="dc-card">
      <div style={css(HEAD)}>
        <div>
          <div style={css(TITLE)}>Silence Settings</div>
          <div style={css(SUB)}>Controls silence detection only — retake detection is unaffected.</div>
        </div>
        <div style={css(CLOSE)}>✕</div>
      </div>
      <div style={css('display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:18px')}>
        <div style={css(tile)}>
          <div style={css(tileName)}>Conservative</div>
          <div style={css(tileDesc)}>Only trims pauses longer than 2 seconds</div>
        </div>
        <div style={css('border:1.5px solid #6E6AE8;border-radius:12px;padding:13px 14px;background:rgba(110,106,232,.07);cursor:pointer;position:relative')}>
          <div style={css('font-size:13px;font-weight:600;color:#B7B5F4')}>Balanced</div>
          <div style={css(tileDesc)}>Trims pauses over 1 second, keeps natural rhythm</div>
          <div style={css('position:absolute;top:10px;right:10px;width:15px;height:15px;border-radius:50%;background:#6E6AE8;display:grid;place-items:center;color:#fff;font-size:8px')}>✓</div>
        </div>
        <div style={css(tile)}>
          <div style={css(tileName)}>Aggressive</div>
          <div style={css(tileDesc)}>Tight, fast-paced — trims anything over half a second</div>
        </div>
        <div style={css(tile)}>
          <div style={css(tileName)}>Custom</div>
          <div style={css(tileDesc)}>Fine-tune every threshold yourself</div>
        </div>
      </div>
      <div style={css('margin-top:16px;background:#191B20;border-radius:10px;padding:11px 14px;font-size:12px;color:#9BA0AC;line-height:1.5')}>With <span style={css('color:#E9EAEE;font-weight:550')}>Balanced</span>, pauses longer than <span style={css('color:#E9EAEE')}>1.0s</span> are shortened to <span style={css('color:#E9EAEE')}>0.3s</span>, with a little breathing room kept around speech.</div>
      <div style={css('display:flex;align-items:center;margin-top:20px')}>
        <span style={css(FOOT_RESET)}>Reset to default</span>
        <div style={css('flex:1')} />
        <span style={css(FOOT_CANCEL)}>Cancel</span>
        <button style={css(FOOT_APPLY)}>Apply</button>
      </div>
    </div>
  )
}

function CustomCard(): JSX.Element {
  const tab = 'flex:1;border:1px solid rgba(255,255,255,.09);border-radius:10px;padding:9px 0;text-align:center;font-size:12px;color:#9BA0AC;cursor:pointer'
  return (
    <div style={css('width:440px;background:#1E2026;padding:22px')} className="dc-card">
      <div style={css(HEAD)}>
        <div>
          <div style={css(TITLE)}>Silence Settings</div>
          <div style={css(SUB)}>Controls silence detection only — retake detection is unaffected.</div>
        </div>
        <div style={css(CLOSE)}>✕</div>
      </div>
      <div style={css('display:flex;gap:8px;margin-top:18px')}>
        <div style={css(tab)}>Conservative</div>
        <div style={css(tab)}>Balanced</div>
        <div style={css(tab)}>Aggressive</div>
        <div style={css('flex:1;border:1.5px solid #6E6AE8;border-radius:10px;padding:9px 0;text-align:center;font-size:12px;font-weight:600;color:#B7B5F4;background:rgba(110,106,232,.07)')}>Custom</div>
      </div>
      <div style={css('display:flex;flex-direction:column;gap:18px;margin-top:20px')}>
        <Slider label="Trim pauses longer than" value="0.8 s" w="32%" lo="0.3s · tight" hi="3s · relaxed" />
        <Slider label="Leave this much pause" value="0.25 s" w="25%" lo="none · jump cuts" hi="1s · gentle" />
        <Slider label="Background noise level" value="Quiet room" w="45%" lo="silent studio" hi="noisy street" />
        <div style={css('display:flex;align-items:center;gap:9px')}>
          <div style={css('width:32px;height:18px;border-radius:9px;background:#3A3E48;position:relative;flex:none;cursor:pointer')}><div style={css('position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#9BA0AC')} /></div>
          <div style={css('font-size:12px;color:#C6C9D2')}>Protect the first pause after each sentence</div>
        </div>
      </div>
      <div style={css('display:flex;align-items:center;margin-top:22px')}>
        <span style={css(FOOT_RESET)}>Reset to default</span>
        <div style={css('flex:1')} />
        <span style={css(FOOT_CANCEL)}>Cancel</span>
        <button style={css(FOOT_APPLY)}>Apply</button>
      </div>
    </div>
  )
}

function ModalInContext(): JSX.Element {
  const mtab = 'flex:1;border:1px solid rgba(255,255,255,.09);border-radius:8px;padding:7px 0;text-align:center;font-size:10.5px;color:#9BA0AC'
  return (
    <div style={css('width:440px;background:#101116;padding:0;position:relative;overflow:hidden')} className="dc-card">
      <div style={css('height:560px;background:#17181C;opacity:.35;display:flex;flex-direction:column')}>
        <div style={css('height:40px;border-bottom:1px solid rgba(255,255,255,.08)')} />
        <div style={css('flex:1;display:grid;place-items:center')}><div style={css('height:70%;aspect-ratio:9/16;background:#1d1f25;border-radius:10px')} /></div>
        <div style={css('height:120px;border-top:1px solid rgba(255,255,255,.08)')} />
      </div>
      <div style={css('position:absolute;inset:0;background:rgba(10,11,14,.55);display:grid;place-items:center')}>
        <div style={css('width:340px;background:#1E2026;border:1px solid rgba(255,255,255,.1);border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,.6);padding:18px')}>
          <div style={css('font-size:14px;font-weight:650')}>Silence Settings</div>
          <div style={css('font-size:11.5px;color:#9BA0AC;margin-top:4px')}>Affects silence detection only.</div>
          <div style={css('display:flex;gap:6px;margin-top:14px')}>
            <div style={css(mtab)}>Conservative</div>
            <div style={css('flex:1;border:1.5px solid #6E6AE8;border-radius:8px;padding:7px 0;text-align:center;font-size:10.5px;font-weight:600;color:#B7B5F4;background:rgba(110,106,232,.07)')}>Balanced</div>
            <div style={css(mtab)}>Aggressive</div>
            <div style={css(mtab)}>Custom</div>
          </div>
          <div style={css('margin-top:12px;background:#191B20;border-radius:8px;padding:9px 12px;font-size:11px;color:#9BA0AC;line-height:1.5')}>Pauses over <span style={css('color:#E9EAEE')}>1.0s</span> shorten to <span style={css('color:#E9EAEE')}>0.3s</span>.</div>
          <div style={css('display:flex;justify-content:flex-end;gap:8px;margin-top:16px')}>
            <span style={css('font-size:11.5px;color:#C6C9D2;padding:7px 12px;border-radius:8px;cursor:pointer')}>Cancel</span>
            <button style={css('background:#6E6AE8;border:none;color:#fff;font-family:inherit;font-size:11.5px;font-weight:600;border-radius:8px;padding:7px 15px;cursor:pointer')}>Apply</button>
          </div>
        </div>
      </div>
      <div style={css("position:absolute;left:14px;bottom:12px;font-family:'IBM Plex Mono',monospace;font-size:9.5px;color:#686E7B;letter-spacing:.08em")}>MODAL IN CONTEXT · SCRIM rgba(10,11,14,.55)</div>
    </div>
  )
}

export default function SilenceSettings(): JSX.Element {
  return (
    <div style={css('display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start')} className="ec-newui">
      <PresetsCard />
      <CustomCard />
      <ModalInContext />
    </div>
  )
}
