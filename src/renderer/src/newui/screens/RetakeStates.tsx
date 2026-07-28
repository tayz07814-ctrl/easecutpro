import { css } from '../css'

// Screen 1c — Retake Cleaner panel state machine (idle → analyzing → results →
// reviewing → executed → error). Verbatim port; each card is 340px. In Stage C
// these become the states of one wired RetakeCleanerPanel.

const CARD = 'width:340px;background:#0c0c10;padding:18px'
const LABEL = "font-family:'Geist Mono',monospace;font-size:9.5px;color:#6e6e85;letter-spacing:.08em;margin-bottom:14px"
const H = 'font-size:15px;font-weight:650'
const BETA = 'font-size:9.5px;font-weight:600;letter-spacing:.05em;color:#9a9aae;border:1px solid rgba(255,255,255,.12);border-radius:5px;padding:2px 6px'
const CHIP = "background:rgba(230,178,106,.14);color:#e6b26a;border:1px solid rgba(230,178,106,.3);border-radius:6px;padding:2px 7px;font-family:'Geist Mono',monospace;font-size:10px;margin:0 3px;white-space:nowrap"
const CUT = 'background:rgba(255,155,155,.13);color:#ff9b9b;border-radius:5px;padding:1px 4px;text-decoration:line-through;text-decoration-color:rgba(255,155,155,.55)'

function Idle(): JSX.Element {
  return (
    <div style={css(CARD)} className="dc-card">
      <div style={css(LABEL)}>01 · IDLE (LAUNCH DEFAULT)</div>
      <div style={css('display:flex;align-items:center;gap:8px')}>
        <div style={css(H)}>Retake Cleaner</div>
        <span style={css(BETA)}>BETA</span>
      </div>
      <div style={css('font-size:12.5px;line-height:1.5;color:#9a9aae;margin-top:6px')}>Find retakes, production chatter, false starts, and long pauses.</div>
      <button style={css('width:100%;margin-top:16px;background:#7c6bff;border:none;color:#fff;font-family:inherit;font-size:13px;font-weight:600;border-radius:10px;padding:11px 0;cursor:pointer;box-shadow:0 6px 20px rgba(124,107,255,.35)')}>Find Retakes &amp; Silence</button>
      <button style={css('width:100%;margin-top:8px;background:none;border:1px solid rgba(255,255,255,.1);color:#c9c9da;font-family:inherit;font-size:12.5px;font-weight:500;border-radius:10px;padding:10px 0;cursor:pointer')}>Silence Settings</button>
      <div style={css('display:flex;align-items:center;gap:9px;margin-top:14px')}>
        <div style={css('width:32px;height:18px;border-radius:9px;background:#7c6bff;position:relative;flex:none;cursor:pointer')}><div style={css('position:absolute;right:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff')} /></div>
        <div style={css('font-size:12px;color:#c9c9da')}>Smart Silence Cutter</div>
      </div>
      <button style={css('width:100%;margin-top:14px;background:#141419;border:none;color:#55556a;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:10px;padding:10px 0;cursor:not-allowed')}>Execute cuts</button>
      <div style={css('font-size:11px;color:#6e6e85;margin-top:12px;line-height:1.5')}>Beta — review proposed cuts before executing. Nothing is removed without you.</div>
    </div>
  )
}

function Analyzing(): JSX.Element {
  return (
    <div style={css(CARD)} className="dc-card">
      <div style={css(LABEL)}>02 · ANALYZING</div>
      <div style={css(H)}>Retake Cleaner</div>
      <div style={css('margin-top:16px;background:#101015;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:16px')}>
        <div style={css('display:flex;align-items:center;justify-content:space-between;font-size:12.5px')}><span style={css('color:#ededf2;font-weight:550')}>Analyzing your video</span><span style={css("font-family:'Geist Mono',monospace;font-size:11px;color:#9a9aae")}>0:41</span></div>
        <div style={css('height:4px;border-radius:2px;background:#22222b;overflow:hidden;margin-top:12px')}><div style={css('width:42%;height:100%;border-radius:2px;background:#7c6bff')} /></div>
        <div style={css('display:flex;flex-direction:column;gap:9px;margin-top:14px;font-size:12px')}>
          <div style={css('display:flex;align-items:center;gap:8px;color:#7ed6a6')}><div style={css('width:14px;height:14px;border-radius:50%;background:rgba(126,214,166,.16);display:grid;place-items:center;font-size:8px')}>✓</div>Transcribing audio</div>
          <div style={css('display:flex;align-items:center;gap:8px;color:#ededf2')}><div style={css('width:14px;height:14px;border-radius:50%;border:1.5px solid #7c6bff')} />Detecting retakes &amp; false starts</div>
          <div style={css('display:flex;align-items:center;gap:8px;color:#6e6e85')}><div style={css('width:14px;height:14px;border-radius:50%;border:1.5px solid #2a2a34')} />Measuring silence gaps</div>
        </div>
      </div>
      <div style={css('text-align:center;margin-top:14px')}><span style={css('font-size:12px;color:#9a9aae;cursor:pointer;padding:6px 12px;border-radius:8px')}>Cancel</span></div>
      <div style={css('font-size:11px;color:#6e6e85;margin-top:10px;text-align:center')}>You can keep editing while this runs.</div>
    </div>
  )
}

function Results(): JSX.Element {
  return (
    <div style={css(CARD)} className="dc-card">
      <div style={css(LABEL)}>03 · RESULTS READY</div>
      <div style={css(H)}>Retake Cleaner</div>
      <div style={css('margin-top:14px;background:#101015;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:14px')}>
        <div style={css('display:grid;grid-template-columns:1fr 1fr;gap:12px 16px')}>
          <div><div style={css('font-size:17px;font-weight:650')}>8</div><div style={css('font-size:11px;color:#9a9aae;margin-top:2px')}>retakes found</div></div>
          <div><div style={css('font-size:17px;font-weight:650;color:#ff9b9b')}>75</div><div style={css('font-size:11px;color:#9a9aae;margin-top:2px')}>words to remove</div></div>
          <div><div style={css('font-size:17px;font-weight:650;color:#e6b26a')}>30</div><div style={css('font-size:11px;color:#9a9aae;margin-top:2px')}>pauses shortened</div></div>
          <div><div style={css('font-size:17px;font-weight:650;color:#7ed6a6')}>~48s</div><div style={css('font-size:11px;color:#9a9aae;margin-top:2px')}>time saved</div></div>
        </div>
        <div style={css('height:1px;background:rgba(255,255,255,.06);margin:12px 0')} />
        <div style={css('display:flex;gap:8px;font-size:10.5px')}>
          <span style={css('color:#ff9b9b;background:rgba(255,155,155,.1);border-radius:6px;padding:3px 8px')}>75 word cuts</span>
          <span style={css('color:#e6b26a;background:rgba(230,178,106,.1);border-radius:6px;padding:3px 8px')}>30 silence trims</span>
        </div>
      </div>
      <button style={css('width:100%;margin-top:14px;background:#7c6bff;border:none;color:#fff;font-family:inherit;font-size:13px;font-weight:600;border-radius:10px;padding:11px 0;cursor:pointer;box-shadow:0 6px 20px rgba(124,107,255,.35)')}>Review proposed cuts</button>
      <button style={css('width:100%;margin-top:8px;background:#191920;border:1px solid rgba(255,255,255,.1);color:#ededf2;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:10px;padding:10px 0;cursor:pointer')}>Execute 105 cuts</button>
      <div style={css('font-size:11px;color:#6e6e85;margin-top:10px;text-align:center')}>Cuts apply to the timeline — undo any time.</div>
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
        <span style={css('font-size:11.5px;color:#9a9aae;padding:4px 8px;border-radius:7px;cursor:pointer')}>Restore</span>
        <span style={css('font-size:11.5px;color:#9a9aae;padding:4px 8px;border-radius:7px;cursor:pointer')}>Clear</span>
        <div style={css('color:#9a9aae;font-size:14px;padding:2px 5px;border-radius:6px;cursor:pointer')}>···</div>
      </div>
      <div style={css('font-size:11.5px;color:#6e6e85;margin-top:6px')}>Click a word to keep or cut it · click a chip to keep the pause</div>
      <div style={css('margin-top:12px;font-size:13px;line-height:2.1;color:#c9c9da')}>
        <span>You can start talking.</span>{' '}
        <span style={css(CHIP)}>6.7s</span>{' '}
        <span style={css(CUT)}>You really think you can make the bed quicker</span>{' '}
        <span style={css('background:rgba(124,107,255,.28);border-radius:5px;padding:1px 4px;color:#ededf2;outline:1.5px solid rgba(124,107,255,.7)')}>than I can finish</span>{' '}
        <span> brushing my teeth?</span>{' '}
        <span style={css(CHIP)}>1.6s</span>{' '}
        <span> I’m not just gonna make it, I’m gonna do it in 20 seconds.</span>
      </div>
      <div style={css('height:1px;background:rgba(255,255,255,.06);margin:14px 0 12px')} />
      <div style={css('display:flex;align-items:center;justify-content:space-between')}>
        <div style={css('font-size:11.5px;color:#9a9aae')}><span style={css('color:#ededf2;font-weight:600')}>103</span> of 105 cuts kept</div>
        <button style={css('background:#7c6bff;border:none;color:#fff;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:9px 16px;cursor:pointer')}>Execute 103 cuts</button>
      </div>
    </div>
  )
}

function Executed(): JSX.Element {
  return (
    <div style={css(CARD)} className="dc-card">
      <div style={css(LABEL)}>05 · CUTS EXECUTED</div>
      <div style={css(H)}>Retake Cleaner</div>
      <div style={css('margin-top:14px;background:rgba(126,214,166,.08);border:1px solid rgba(126,214,166,.25);border-radius:12px;padding:16px;display:flex;gap:12px')}>
        <div style={css('width:26px;height:26px;flex:none;border-radius:50%;background:rgba(126,214,166,.18);display:grid;place-items:center;color:#7ed6a6;font-size:12px')}>✓</div>
        <div>
          <div style={css('font-size:13px;font-weight:600;color:#9fdfbe')}>103 cuts applied</div>
          <div style={css('font-size:12px;color:#9a9aae;margin-top:4px;line-height:1.5')}>Your video is now 2:40 — 48 seconds shorter. Every cut is on the timeline and can be undone.</div>
        </div>
      </div>
      <div style={css('display:flex;gap:8px;margin-top:14px')}>
        <button style={css('flex:1;background:#191920;border:1px solid rgba(255,255,255,.1);color:#ededf2;font-family:inherit;font-size:12.5px;font-weight:550;border-radius:10px;padding:10px 0;cursor:pointer')}>Undo all</button>
        <button style={css('flex:1;background:#7c6bff;border:none;color:#fff;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:10px;padding:10px 0;cursor:pointer')}>Export</button>
      </div>
      <div style={css('font-size:11px;color:#6e6e85;margin-top:12px;text-align:center')}>Run again after more edits to catch new pauses.</div>
    </div>
  )
}

function ErrorState(): JSX.Element {
  return (
    <div style={css(CARD)} className="dc-card">
      <div style={css(LABEL)}>06 · ERROR</div>
      <div style={css(H)}>Retake Cleaner</div>
      <div style={css('margin-top:14px;background:rgba(255,155,155,.07);border:1px solid rgba(255,155,155,.25);border-radius:12px;padding:16px;display:flex;gap:12px')}>
        <div style={css('width:26px;height:26px;flex:none;border-radius:50%;background:rgba(255,155,155,.16);display:grid;place-items:center;color:#ff9b9b;font-size:12px')}>!</div>
        <div>
          <div style={css('font-size:13px;font-weight:600;color:#ff9b9b')}>Analysis didn’t finish</div>
          <div style={css('font-size:12px;color:#9a9aae;margin-top:4px;line-height:1.5')}>We couldn’t transcribe the audio. Your project and edits are untouched.</div>
        </div>
      </div>
      <button style={css('width:100%;margin-top:14px;background:#7c6bff;border:none;color:#fff;font-family:inherit;font-size:13px;font-weight:600;border-radius:10px;padding:11px 0;cursor:pointer')}>Try again</button>
      <div style={css('text-align:center;margin-top:10px')}><span style={css('font-size:12px;color:#9a9aae;cursor:pointer;padding:5px 10px;border-radius:8px')}>Get help</span></div>
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
