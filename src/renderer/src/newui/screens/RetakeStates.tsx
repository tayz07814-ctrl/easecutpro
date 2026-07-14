import { css } from '../css'

// Screen 1c — Retake Cleaner panel state machine (idle → analyzing → results →
// reviewing → executed → error). Verbatim port; each card is 340px. In Stage C
// these become the states of one wired RetakeCleanerPanel.

const CARD = 'width:340px;background:#191B20;padding:18px'
const LABEL = "font-family:'IBM Plex Mono',monospace;font-size:9.5px;color:#686E7B;letter-spacing:.08em;margin-bottom:14px"
const H = 'font-size:15px;font-weight:650'
const BETA = 'font-size:9.5px;font-weight:600;letter-spacing:.05em;color:#9BA0AC;border:1px solid rgba(255,255,255,.12);border-radius:5px;padding:2px 6px'
const CHIP = "background:rgba(217,164,74,.14);color:#D9A44A;border:1px solid rgba(217,164,74,.3);border-radius:6px;padding:2px 7px;font-family:'IBM Plex Mono',monospace;font-size:10px;margin:0 3px;white-space:nowrap"
const CUT = 'background:rgba(217,104,110,.13);color:#D9868B;border-radius:5px;padding:1px 4px;text-decoration:line-through;text-decoration-color:rgba(217,134,139,.55)'

function Idle(): JSX.Element {
  return (
    <div style={css(CARD)} className="dc-card">
      <div style={css(LABEL)}>01 · IDLE (LAUNCH DEFAULT)</div>
      <div style={css('display:flex;align-items:center;gap:8px')}>
        <div style={css(H)}>Retake Cleaner</div>
        <span style={css(BETA)}>BETA</span>
      </div>
      <div style={css('font-size:12.5px;line-height:1.5;color:#9BA0AC;margin-top:6px')}>Find retakes, production chatter, false starts, and long pauses.</div>
      <button style={css('width:100%;margin-top:16px;background:#6E6AE8;border:none;color:#fff;font-family:inherit;font-size:13px;font-weight:600;border-radius:10px;padding:11px 0;cursor:pointer;box-shadow:0 6px 20px rgba(110,106,232,.35)')}>Find Retakes &amp; Silence</button>
      <button style={css('width:100%;margin-top:8px;background:none;border:1px solid rgba(255,255,255,.1);color:#C6C9D2;font-family:inherit;font-size:12.5px;font-weight:500;border-radius:10px;padding:10px 0;cursor:pointer')}>Silence Settings</button>
      <div style={css('display:flex;align-items:center;gap:9px;margin-top:14px')}>
        <div style={css('width:32px;height:18px;border-radius:9px;background:#6E6AE8;position:relative;flex:none;cursor:pointer')}><div style={css('position:absolute;right:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff')} /></div>
        <div style={css('font-size:12px;color:#C6C9D2')}>Smart Silence Cutter</div>
      </div>
      <button style={css('width:100%;margin-top:14px;background:#22242b;border:none;color:#565C68;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:10px;padding:10px 0;cursor:not-allowed')}>Execute cuts</button>
      <div style={css('font-size:11px;color:#686E7B;margin-top:12px;line-height:1.5')}>Beta — review proposed cuts before executing. Nothing is removed without you.</div>
    </div>
  )
}

function Analyzing(): JSX.Element {
  return (
    <div style={css(CARD)} className="dc-card">
      <div style={css(LABEL)}>02 · ANALYZING</div>
      <div style={css(H)}>Retake Cleaner</div>
      <div style={css('margin-top:16px;background:#1E2026;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:16px')}>
        <div style={css('display:flex;align-items:center;justify-content:space-between;font-size:12.5px')}><span style={css('color:#E9EAEE;font-weight:550')}>Analyzing your video</span><span style={css("font-family:'IBM Plex Mono',monospace;font-size:11px;color:#9BA0AC")}>0:41</span></div>
        <div style={css('height:4px;border-radius:2px;background:#2A2D36;overflow:hidden;margin-top:12px')}><div style={css('width:42%;height:100%;border-radius:2px;background:#6E6AE8')} /></div>
        <div style={css('display:flex;flex-direction:column;gap:9px;margin-top:14px;font-size:12px')}>
          <div style={css('display:flex;align-items:center;gap:8px;color:#46A57C')}><div style={css('width:14px;height:14px;border-radius:50%;background:rgba(70,165,124,.16);display:grid;place-items:center;font-size:8px')}>✓</div>Transcribing audio</div>
          <div style={css('display:flex;align-items:center;gap:8px;color:#E9EAEE')}><div style={css('width:14px;height:14px;border-radius:50%;border:1.5px solid #6E6AE8')} />Detecting retakes &amp; false starts</div>
          <div style={css('display:flex;align-items:center;gap:8px;color:#686E7B')}><div style={css('width:14px;height:14px;border-radius:50%;border:1.5px solid #3A3E48')} />Measuring silence gaps</div>
        </div>
      </div>
      <div style={css('text-align:center;margin-top:14px')}><span style={css('font-size:12px;color:#9BA0AC;cursor:pointer;padding:6px 12px;border-radius:8px')}>Cancel</span></div>
      <div style={css('font-size:11px;color:#686E7B;margin-top:10px;text-align:center')}>You can keep editing while this runs.</div>
    </div>
  )
}

function Results(): JSX.Element {
  return (
    <div style={css(CARD)} className="dc-card">
      <div style={css(LABEL)}>03 · RESULTS READY</div>
      <div style={css(H)}>Retake Cleaner</div>
      <div style={css('margin-top:14px;background:#1E2026;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:14px')}>
        <div style={css('display:grid;grid-template-columns:1fr 1fr;gap:12px 16px')}>
          <div><div style={css('font-size:17px;font-weight:650')}>8</div><div style={css('font-size:11px;color:#9BA0AC;margin-top:2px')}>retakes found</div></div>
          <div><div style={css('font-size:17px;font-weight:650;color:#D9868B')}>75</div><div style={css('font-size:11px;color:#9BA0AC;margin-top:2px')}>words to remove</div></div>
          <div><div style={css('font-size:17px;font-weight:650;color:#D9A44A')}>30</div><div style={css('font-size:11px;color:#9BA0AC;margin-top:2px')}>pauses shortened</div></div>
          <div><div style={css('font-size:17px;font-weight:650;color:#46A57C')}>~48s</div><div style={css('font-size:11px;color:#9BA0AC;margin-top:2px')}>time saved</div></div>
        </div>
        <div style={css('height:1px;background:rgba(255,255,255,.06);margin:12px 0')} />
        <div style={css('display:flex;gap:8px;font-size:10.5px')}>
          <span style={css('color:#D9868B;background:rgba(217,104,110,.1);border-radius:6px;padding:3px 8px')}>75 word cuts</span>
          <span style={css('color:#D9A44A;background:rgba(217,164,74,.1);border-radius:6px;padding:3px 8px')}>30 silence trims</span>
        </div>
      </div>
      <button style={css('width:100%;margin-top:14px;background:#6E6AE8;border:none;color:#fff;font-family:inherit;font-size:13px;font-weight:600;border-radius:10px;padding:11px 0;cursor:pointer;box-shadow:0 6px 20px rgba(110,106,232,.35)')}>Review proposed cuts</button>
      <button style={css('width:100%;margin-top:8px;background:#262932;border:1px solid rgba(255,255,255,.1);color:#E9EAEE;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:10px;padding:10px 0;cursor:pointer')}>Execute 105 cuts</button>
      <div style={css('font-size:11px;color:#686E7B;margin-top:10px;text-align:center')}>Cuts apply to the timeline — undo any time.</div>
    </div>
  )
}

function Reviewing(): JSX.Element {
  return (
    <div style={css(CARD)} className="dc-card">
      <div style={css(LABEL)}>04 · REVIEWING</div>
      <div style={css('display:flex;align-items:center;gap:8px')}>
        <div style={css(H)}>Review cuts</div>
        <div style={css('flex:1')} />
        <span style={css('font-size:11.5px;color:#9BA0AC;padding:4px 8px;border-radius:7px;cursor:pointer')}>Restore</span>
        <span style={css('font-size:11.5px;color:#9BA0AC;padding:4px 8px;border-radius:7px;cursor:pointer')}>Clear</span>
        <div style={css('color:#9BA0AC;font-size:14px;padding:2px 5px;border-radius:6px;cursor:pointer')}>···</div>
      </div>
      <div style={css('font-size:11.5px;color:#686E7B;margin-top:6px')}>Click a word to keep or cut it · click a chip to keep the pause</div>
      <div style={css('margin-top:12px;font-size:13px;line-height:2.1;color:#C6C9D2')}>
        <span>You can start talking.</span>{' '}
        <span style={css(CHIP)}>6.7s</span>{' '}
        <span style={css(CUT)}>You really think you can make the bed quicker</span>{' '}
        <span style={css('background:rgba(110,106,232,.28);border-radius:5px;padding:1px 4px;color:#E9EAEE;outline:1.5px solid rgba(110,106,232,.7)')}>than I can finish</span>{' '}
        <span> brushing my teeth?</span>{' '}
        <span style={css(CHIP)}>1.6s</span>{' '}
        <span> I’m not just gonna make it, I’m gonna do it in 20 seconds.</span>
      </div>
      <div style={css('height:1px;background:rgba(255,255,255,.06);margin:14px 0 12px')} />
      <div style={css('display:flex;align-items:center;justify-content:space-between')}>
        <div style={css('font-size:11.5px;color:#9BA0AC')}><span style={css('color:#E9EAEE;font-weight:600')}>103</span> of 105 cuts kept</div>
        <button style={css('background:#6E6AE8;border:none;color:#fff;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:9px 16px;cursor:pointer')}>Execute 103 cuts</button>
      </div>
    </div>
  )
}

function Executed(): JSX.Element {
  return (
    <div style={css(CARD)} className="dc-card">
      <div style={css(LABEL)}>05 · CUTS EXECUTED</div>
      <div style={css(H)}>Retake Cleaner</div>
      <div style={css('margin-top:14px;background:rgba(70,165,124,.08);border:1px solid rgba(70,165,124,.25);border-radius:12px;padding:16px;display:flex;gap:12px')}>
        <div style={css('width:26px;height:26px;flex:none;border-radius:50%;background:rgba(70,165,124,.18);display:grid;place-items:center;color:#5FBF94;font-size:12px')}>✓</div>
        <div>
          <div style={css('font-size:13px;font-weight:600;color:#7FCBA8')}>103 cuts applied</div>
          <div style={css('font-size:12px;color:#9BA0AC;margin-top:4px;line-height:1.5')}>Your video is now 2:40 — 48 seconds shorter. Every cut is on the timeline and can be undone.</div>
        </div>
      </div>
      <div style={css('display:flex;gap:8px;margin-top:14px')}>
        <button style={css('flex:1;background:#262932;border:1px solid rgba(255,255,255,.1);color:#E9EAEE;font-family:inherit;font-size:12.5px;font-weight:550;border-radius:10px;padding:10px 0;cursor:pointer')}>Undo all</button>
        <button style={css('flex:1;background:#6E6AE8;border:none;color:#fff;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:10px;padding:10px 0;cursor:pointer')}>Export</button>
      </div>
      <div style={css('font-size:11px;color:#686E7B;margin-top:12px;text-align:center')}>Run again after more edits to catch new pauses.</div>
    </div>
  )
}

function ErrorState(): JSX.Element {
  return (
    <div style={css(CARD)} className="dc-card">
      <div style={css(LABEL)}>06 · ERROR</div>
      <div style={css(H)}>Retake Cleaner</div>
      <div style={css('margin-top:14px;background:rgba(217,104,110,.07);border:1px solid rgba(217,104,110,.25);border-radius:12px;padding:16px;display:flex;gap:12px')}>
        <div style={css('width:26px;height:26px;flex:none;border-radius:50%;background:rgba(217,104,110,.16);display:grid;place-items:center;color:#D9868B;font-size:12px')}>!</div>
        <div>
          <div style={css('font-size:13px;font-weight:600;color:#E09BA0')}>Analysis didn’t finish</div>
          <div style={css('font-size:12px;color:#9BA0AC;margin-top:4px;line-height:1.5')}>We couldn’t transcribe the audio. Your project and edits are untouched.</div>
        </div>
      </div>
      <button style={css('width:100%;margin-top:14px;background:#6E6AE8;border:none;color:#fff;font-family:inherit;font-size:13px;font-weight:600;border-radius:10px;padding:11px 0;cursor:pointer')}>Try again</button>
      <div style={css('text-align:center;margin-top:10px')}><span style={css('font-size:12px;color:#9BA0AC;cursor:pointer;padding:5px 10px;border-radius:8px')}>Get help</span></div>
    </div>
  )
}

export default function RetakeStates(): JSX.Element {
  return (
    <div style={css('display:flex;gap:20px;flex-wrap:wrap;max-width:1440px')} className="ec-newui">
      <Idle />
      <Analyzing />
      <Results />
      <Reviewing />
      <Executed />
      <ErrorState />
    </div>
  )
}
