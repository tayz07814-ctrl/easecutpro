import { css } from '../css'

// Screen 1b — Video editor (1440 · AI Cut tab, results-ready / reviewing state).
// Verbatim port of the approved design. Fluid: fills width/height; media panel
// (264) and AI panel (360) are fixed rails, preview flexes, timeline is a fixed
// 236 strip (design responsive rule: three-panel at ≥1440).

const HAIR = 'rgba(255,255,255,.06)'
const CLIP9x16 =
  "width:42px;height:74px;flex:none;border-radius:7px;background:repeating-linear-gradient(45deg,#23252b 0,#23252b 8px,#1e2026 8px,#1e2026 16px);display:grid;place-items:center;font-family:'IBM Plex Mono',monospace;font-size:8px;color:#686E7B"

function TopBar(): JSX.Element {
  return (
    <div style={css(`display:flex;align-items:center;gap:12px;height:52px;padding:0 16px;border-bottom:1px solid ${HAIR};flex:none`)}>
      <div style={css('display:flex;align-items:center;gap:7px;font-size:13px;color:#9BA0AC;padding:6px 10px;border-radius:8px;cursor:pointer')}>
        <span style={css('font-size:14px')}>‹</span> Projects
      </div>
      <div style={css('width:1px;height:20px;background:rgba(255,255,255,.08)')} />
      <div style={css('display:flex;align-items:center;gap:8px')}>
        <div style={css('font-size:13.5px;font-weight:600;padding:5px 8px;border-radius:8px;cursor:text')}>Morning routine — bedroom take</div>
        <div style={css('display:flex;align-items:center;gap:5px;font-size:11.5px;color:#686E7B')}>
          <div style={css('width:6px;height:6px;border-radius:50%;background:#46A57C')} />Saved
        </div>
      </div>
      <div style={css('flex:1')} />
      <div style={css('display:flex;align-items:center;gap:4px')}>
        <div style={css('width:30px;height:30px;border-radius:8px;display:grid;place-items:center;color:#9BA0AC;font-size:14px;cursor:pointer')}>↶</div>
        <div style={css('width:30px;height:30px;border-radius:8px;display:grid;place-items:center;color:#4A4F5B;font-size:14px')}>↷</div>
      </div>
      <div style={css('width:1px;height:20px;background:rgba(255,255,255,.08)')} />
      <button style={css('background:none;border:1px solid rgba(255,255,255,.1);color:#C6C9D2;font-family:inherit;font-size:12.5px;font-weight:500;border-radius:9px;padding:7px 13px;cursor:pointer')}>Import</button>
      <div style={css('width:30px;height:30px;border-radius:8px;display:grid;place-items:center;color:#9BA0AC;font-size:15px;cursor:pointer')}>···</div>
      <button style={css('background:#6E6AE8;border:none;color:#fff;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:7px 16px;cursor:pointer')}>Export</button>
    </div>
  )
}

function MediaPanel(): JSX.Element {
  return (
    <div style={css(`width:264px;flex:none;border-right:1px solid ${HAIR};display:flex;flex-direction:column;background:#191B20`)}>
      <div style={css('display:flex;align-items:center;justify-content:space-between;padding:14px 16px 10px')}>
        <div style={css('font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#9BA0AC')}>Media</div>
        <div style={css('font-size:13px;color:#686E7B;cursor:pointer')}>⟨</div>
      </div>
      <div style={css('padding:0 16px 12px;display:flex;flex-direction:column;gap:8px')}>
        <button style={css('background:rgba(110,106,232,.14);border:1px solid rgba(110,106,232,.3);color:#B7B5F4;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:8px 0;cursor:pointer;width:100%')}>＋ Import media</button>
        <div style={css('display:flex;align-items:center;gap:8px;height:32px;padding:0 10px;background:#1E2026;border:1px solid rgba(255,255,255,.06);border-radius:8px')}>
          <div style={css('width:10px;height:10px;border:1.5px solid #686E7B;border-radius:50%;position:relative')}>
            <div style={css('position:absolute;width:4px;height:1.5px;background:#686E7B;bottom:-2px;right:-2px;transform:rotate(45deg)')} />
          </div>
          <span style={css('font-size:12px;color:#686E7B')}>Filter media</span>
        </div>
      </div>
      <div style={css('padding:0 12px;display:flex;flex-direction:column;gap:8px;overflow:hidden')}>
        {/* selected base clip */}
        <div style={css('background:#1E2026;border:1px solid rgba(110,106,232,.55);border-radius:12px;padding:10px;display:flex;gap:10px;box-shadow:0 0 0 3px rgba(110,106,232,.12);position:relative')}>
          <div style={css(CLIP9x16)}>9:16</div>
          <div style={css('flex:1;min-width:0;display:flex;flex-direction:column;gap:4px')}>
            <div style={css('font-size:12.5px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>Bedroom take 3.mp4</div>
            <div style={css("font-family:'IBM Plex Mono',monospace;font-size:10px;color:#686E7B")}>3:28 · 1080×1920</div>
            <div style={css('display:flex;gap:6px;margin-top:2px')}>
              <span style={css('font-size:10px;font-weight:600;color:#B7B5F4;background:rgba(110,106,232,.18);border-radius:5px;padding:2px 7px')}>Base clip</span>
            </div>
          </div>
          <div style={css('color:#9BA0AC;font-size:14px;line-height:1;height:22px;padding:2px 5px;border-radius:6px;cursor:pointer')}>···</div>
        </div>
        <div style={css('background:#1E2026;border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:10px;display:flex;gap:10px')}>
          <div style={css(CLIP9x16)}>9:16</div>
          <div style={css('flex:1;min-width:0;display:flex;flex-direction:column;gap:4px')}>
            <div style={css('font-size:12.5px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>Bedroom take 2.mp4</div>
            <div style={css("font-family:'IBM Plex Mono',monospace;font-size:10px;color:#686E7B")}>2:51 · 1080×1920</div>
          </div>
          <div style={css('color:#9BA0AC;font-size:14px;line-height:1;height:22px;padding:2px 5px;border-radius:6px;cursor:pointer')}>···</div>
        </div>
      </div>
      <div style={css('flex:1')} />
      <div style={css('padding:14px 16px;font-size:11px;line-height:1.5;color:#686E7B;border-top:1px solid rgba(255,255,255,.05)')}>Import once, reuse anywhere. Set a clip as base, or drag it onto a track.</div>
    </div>
  )
}

function PreviewStage(): JSX.Element {
  return (
    <div style={css('flex:1;min-width:0;display:flex;flex-direction:column;background:#141519')}>
      <div style={css('flex:1;display:grid;place-items:center;padding:28px')}>
        <div style={css("height:100%;max-height:560px;aspect-ratio:9/16;border-radius:12px;background:repeating-linear-gradient(45deg,#1d1f25 0,#1d1f25 14px,#191b20 14px,#191b20 28px);border:1px solid rgba(255,255,255,.06);display:grid;place-items:center;font-family:'IBM Plex Mono',monospace;font-size:11px;color:#686E7B")}>video preview</div>
      </div>
      <div style={css('flex:none;display:flex;align-items:center;gap:16px;padding:0 20px 18px')}>
        <div style={css('display:flex;gap:2px;background:#1E2026;border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:3px')}>
          <span style={css('font-size:11.5px;color:#9BA0AC;padding:5px 10px;border-radius:7px;cursor:pointer')}>Source</span>
          <span style={css('font-size:11.5px;color:#E9EAEE;background:#2E3140;border-radius:7px;padding:5px 10px;font-weight:550')}>9:16</span>
          <span style={css('font-size:11.5px;color:#9BA0AC;padding:5px 10px;border-radius:7px;cursor:pointer')}>16:9</span>
          <span style={css('font-size:11.5px;color:#9BA0AC;padding:5px 10px;border-radius:7px;cursor:pointer')}>1:1</span>
          <span style={css('font-size:11.5px;color:#9BA0AC;padding:5px 10px;border-radius:7px;cursor:pointer')}>4:5</span>
        </div>
        <div style={css('flex:1')} />
        <div style={css('display:flex;align-items:center;gap:6px')}>
          <div style={css('width:32px;height:32px;border-radius:9px;display:grid;place-items:center;color:#9BA0AC;cursor:pointer')}>
            <div style={css('display:flex;gap:1px')}>
              <div style={css('width:2px;height:9px;background:currentColor')} />
              <div style={css('width:0;height:0;border-right:7px solid currentColor;border-top:5px solid transparent;border-bottom:5px solid transparent')} />
            </div>
          </div>
          <div style={css('width:38px;height:38px;border-radius:50%;background:#E9EAEE;display:grid;place-items:center;cursor:pointer')}>
            <div style={css('width:0;height:0;border-left:11px solid #17181C;border-top:7px solid transparent;border-bottom:7px solid transparent;margin-left:2px')} />
          </div>
          <div style={css('width:32px;height:32px;border-radius:9px;display:grid;place-items:center;color:#9BA0AC;cursor:pointer')}>
            <div style={css('display:flex;gap:1px')}>
              <div style={css('width:0;height:0;border-left:7px solid currentColor;border-top:5px solid transparent;border-bottom:5px solid transparent')} />
              <div style={css('width:2px;height:9px;background:currentColor')} />
            </div>
          </div>
        </div>
        <div style={css('flex:1')} />
        <div style={css("font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:#9BA0AC")}>
          <span style={css('color:#E9EAEE')}>00:41.2</span> / 03:28.0
        </div>
      </div>
    </div>
  )
}

function AiPanel(): JSX.Element {
  return (
    <div style={css(`width:360px;flex:none;border-left:1px solid ${HAIR};display:flex;flex-direction:column;background:#191B20`)}>
      <div style={css(`display:flex;padding:0 8px;border-bottom:1px solid ${HAIR};flex:none`)}>
        <div style={css('padding:13px 12px 11px;font-size:12.5px;font-weight:600;color:#E9EAEE;border-bottom:2px solid #6E6AE8;margin-bottom:-1px')}>AI Cut</div>
        <div style={css('padding:13px 12px 11px;font-size:12.5px;color:#9BA0AC;cursor:pointer')}>Edit</div>
        <div style={css('padding:13px 12px 11px;font-size:12.5px;color:#9BA0AC;cursor:pointer')}>Text</div>
        <div style={css('padding:13px 12px 11px;font-size:12.5px;color:#9BA0AC;cursor:pointer')}>Overlays</div>
        <div style={css('padding:13px 12px 11px;font-size:12.5px;color:#9BA0AC;cursor:pointer')}>Audio</div>
      </div>
      <div style={css('flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;padding:18px 18px 0')}>
        <div style={css('display:flex;align-items:center;gap:8px')}>
          <div style={css('font-size:15px;font-weight:650;letter-spacing:-.01em')}>Retake Cleaner</div>
          <span style={css('font-size:9.5px;font-weight:600;letter-spacing:.05em;color:#9BA0AC;border:1px solid rgba(255,255,255,.12);border-radius:5px;padding:2px 6px')}>BETA</span>
          <div style={css('flex:1')} />
          <div style={css('color:#9BA0AC;font-size:14px;padding:3px 6px;border-radius:7px;cursor:pointer')}>···</div>
        </div>
        <div style={css('font-size:12.5px;line-height:1.5;color:#9BA0AC;margin-top:6px')}>Find retakes, production chatter, false starts, and long pauses.</div>

        {/* summary card */}
        <div style={css('margin-top:16px;background:#1E2026;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:14px')}>
          <div style={css('display:grid;grid-template-columns:1fr 1fr;gap:12px 16px')}>
            <div><div style={css('font-size:17px;font-weight:650')}>8</div><div style={css('font-size:11px;color:#9BA0AC;margin-top:2px')}>retakes found</div></div>
            <div><div style={css('font-size:17px;font-weight:650;color:#D9868B')}>75</div><div style={css('font-size:11px;color:#9BA0AC;margin-top:2px')}>words to remove</div></div>
            <div><div style={css('font-size:17px;font-weight:650;color:#D9A44A')}>30</div><div style={css('font-size:11px;color:#9BA0AC;margin-top:2px')}>pauses shortened</div></div>
            <div><div style={css('font-size:17px;font-weight:650;color:#46A57C')}>~48s</div><div style={css('font-size:11px;color:#9BA0AC;margin-top:2px')}>time saved</div></div>
          </div>
        </div>

        <div style={css('display:flex;gap:8px;margin-top:12px')}>
          <button style={css('flex:1;background:#6E6AE8;border:none;color:#fff;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:10px;padding:10px 0;cursor:pointer;box-shadow:0 6px 20px rgba(110,106,232,.3)')}>Execute 105 cuts</button>
          <button style={css('background:none;border:1px solid rgba(255,255,255,.1);color:#C6C9D2;font-family:inherit;font-size:12.5px;font-weight:500;border-radius:10px;padding:10px 14px;cursor:pointer')}>Silence Settings</button>
        </div>
        <div style={css('display:flex;align-items:center;gap:9px;margin-top:12px')}>
          <div style={css('width:32px;height:18px;border-radius:9px;background:#6E6AE8;position:relative;flex:none;cursor:pointer')}>
            <div style={css('position:absolute;right:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff')} />
          </div>
          <div style={css('font-size:12px;color:#C6C9D2')}>Smart Silence Cutter</div>
          <div style={css('flex:1')} />
          <div style={css('font-size:11px;color:#686E7B')}>30 pauses</div>
        </div>

        {/* transcript */}
        <div style={css(`display:flex;align-items:center;gap:8px;margin-top:18px;padding-top:14px;border-top:1px solid ${HAIR}`)}>
          <div style={css('font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#9BA0AC')}>Review transcript</div>
          <div style={css('flex:1')} />
          <span style={css('font-size:11.5px;color:#9BA0AC;padding:4px 8px;border-radius:7px;cursor:pointer')}>Restore</span>
          <span style={css('font-size:11.5px;color:#9BA0AC;padding:4px 8px;border-radius:7px;cursor:pointer')}>Clear</span>
        </div>
        <div style={css('flex:1;min-height:0;overflow:hidden;margin:10px -18px 0;padding:2px 18px 18px;font-size:13.5px;line-height:2.1;color:#C6C9D2;-webkit-mask-image:linear-gradient(#000 82%,transparent)')}>
          {/* Inter-span single spaces mirror the design HTML's collapsing
              source whitespace between inline spans (on top of chip margins). */}
          <span>You can start talking.</span>{' '}
          <span style={css("background:rgba(217,164,74,.14);color:#D9A44A;border:1px solid rgba(217,164,74,.3);border-radius:6px;padding:2px 7px;font-family:'IBM Plex Mono',monospace;font-size:10px;margin:0 4px;white-space:nowrap")}>6.7s</span>{' '}
          <span style={css('background:rgba(217,104,110,.13);color:#D9868B;border-radius:5px;padding:1px 4px;text-decoration:line-through;text-decoration-color:rgba(217,134,139,.55)')}>You really think you can make the bed quicker than</span>{' '}
          <span> I can finish brushing my teeth?</span>{' '}
          <span style={css("background:rgba(217,164,74,.14);color:#D9A44A;border:1px solid rgba(217,164,74,.3);border-radius:6px;padding:2px 7px;font-family:'IBM Plex Mono',monospace;font-size:10px;margin:0 4px;white-space:nowrap")}>1.6s</span>{' '}
          <span> Don’t tow anything, just leave it rolling.</span>{' '}
          <span style={css("background:rgba(217,164,74,.14);color:#D9A44A;border:1px solid rgba(217,164,74,.3);border-radius:6px;padding:2px 7px;font-family:'IBM Plex Mono',monospace;font-size:10px;margin:0 4px;white-space:nowrap")}>2.6s</span>{' '}
          <span> I’m not just gonna make it, I’m gonna do it in 20 seconds.</span>{' '}
          <span style={css('background:rgba(217,104,110,.13);color:#D9868B;border-radius:5px;padding:1px 4px;text-decoration:line-through;text-decoration-color:rgba(217,134,139,.55)')}>Wait, hold on — let me start that again.</span>
        </div>
      </div>
    </div>
  )
}

function Timeline(): JSX.Element {
  const cell = 'width:16.66%;padding-left:8px'
  return (
    <div style={css(`flex:none;height:236px;border-top:1px solid ${HAIR};background:#191B20;display:flex;flex-direction:column`)}>
      <div style={css('display:flex;align-items:center;gap:8px;height:38px;padding:0 14px;border-bottom:1px solid rgba(255,255,255,.05)')}>
        <span style={css('font-size:11.5px;color:#B7B5F4;background:rgba(110,106,232,.14);border:1px solid rgba(110,106,232,.28);border-radius:7px;padding:4px 10px;font-weight:550')}>Snap</span>
        <span style={css('font-size:11.5px;color:#9BA0AC;padding:4px 10px;border-radius:7px;cursor:pointer')}>＋ Track</span>
        <span style={css('font-size:11.5px;color:#9BA0AC;padding:4px 10px;border-radius:7px;cursor:pointer')}>Split</span>
        <span style={css('font-size:11.5px;color:#9BA0AC;padding:4px 10px;border-radius:7px;cursor:pointer')}>Detach audio</span>
        <div style={css('flex:1')} />
        <div style={css("font-family:'IBM Plex Mono',monospace;font-size:11px;color:#9BA0AC")}>00:00:41:06</div>
        <div style={css('display:flex;align-items:center;gap:8px;margin-left:8px')}>
          <span style={css('font-size:12px;color:#686E7B')}>−</span>
          <div style={css('width:90px;height:3px;border-radius:2px;background:#2A2D36;position:relative')}>
            <div style={css('width:55%;height:100%;border-radius:2px;background:#686E7B')} />
            <div style={css('position:absolute;left:55%;top:50%;transform:translate(-50%,-50%);width:11px;height:11px;border-radius:50%;background:#C6C9D2')} />
          </div>
          <span style={css('font-size:12px;color:#686E7B')}>＋</span>
        </div>
      </div>
      <div style={css('flex:1;display:flex;min-height:0;position:relative')}>
        {/* track headers */}
        <div style={css(`width:148px;flex:none;border-right:1px solid ${HAIR};display:flex;flex-direction:column;font-size:11.5px`)}>
          <div style={css('height:26px;flex:none;border-bottom:1px solid rgba(255,255,255,.04)')} />
          <div style={css('height:26px;display:flex;align-items:center;gap:7px;padding:0 10px;color:#9BA0AC;border-bottom:1px solid rgba(255,255,255,.04)')}><span style={css('font-size:9px;color:#686E7B')}>▸</span>Text<div style={css('flex:1')} /><span style={css('color:#4A4F5B;font-size:10px')}>◦ ◦</span></div>
          <div style={css('height:26px;display:flex;align-items:center;gap:7px;padding:0 10px;color:#9BA0AC;border-bottom:1px solid rgba(255,255,255,.04)')}><span style={css('font-size:9px;color:#686E7B')}>▸</span>Overlays<div style={css('flex:1')} /><span style={css('color:#4A4F5B;font-size:10px')}>◦ ◦</span></div>
          <div style={css('flex:1;display:flex;align-items:center;gap:7px;padding:0 10px;color:#E9EAEE;font-weight:550;border-bottom:1px solid rgba(255,255,255,.04)')}>Video<div style={css('flex:1')} /><span style={css('color:#4A4F5B;font-size:10px')}>◦ ◦</span></div>
          <div style={css('height:34px;display:flex;align-items:center;gap:7px;padding:0 10px;color:#9BA0AC')}>Audio<div style={css('flex:1')} /><span style={css('color:#4A4F5B;font-size:10px')}>◦ ◦</span></div>
        </div>
        {/* lanes */}
        <div style={css('flex:1;position:relative;overflow:hidden')}>
          {/* ruler */}
          <div style={css("height:26px;display:flex;align-items:center;border-bottom:1px solid rgba(255,255,255,.05);font-family:'IBM Plex Mono',monospace;font-size:9.5px;color:#565C68")}>
            <div style={css(cell)}>00:00</div><div style={css(cell)}>00:30</div><div style={css(cell)}>01:00</div><div style={css(cell)}>01:30</div><div style={css(cell)}>02:00</div><div style={css(cell)}>02:30</div>
          </div>
          <div style={css('height:26px;border-bottom:1px solid rgba(255,255,255,.04);position:relative')}><div style={css('position:absolute;left:22%;width:14%;top:5px;bottom:5px;border-radius:5px;background:rgba(91,155,217,.22);border:1px solid rgba(91,155,217,.4)')} /></div>
          <div style={css('height:26px;border-bottom:1px solid rgba(255,255,255,.04);position:relative')}><div style={css('position:absolute;left:48%;width:9%;top:5px;bottom:5px;border-radius:5px;background:rgba(91,155,217,.14);border:1px solid rgba(91,155,217,.3)')} /></div>
          {/* video lane */}
          <div style={css('position:absolute;top:78px;bottom:34px;left:0;right:0;border-bottom:1px solid rgba(255,255,255,.04)')}>
            <div style={css('position:absolute;left:1.5%;right:2%;top:8px;bottom:8px;border-radius:9px;overflow:hidden;background:repeating-linear-gradient(90deg,#2b2e37 0,#2b2e37 34px,#24262e 34px,#24262e 68px);border:1px solid rgba(255,255,255,.12)')}>
              <div style={css('position:absolute;left:0;top:0;bottom:0;width:6px;background:rgba(110,106,232,.9);border-radius:9px 0 0 9px')} />
              <div style={css('position:absolute;right:0;top:0;bottom:0;width:6px;background:rgba(110,106,232,.9);border-radius:0 9px 9px 0')} />
              <div style={css('position:absolute;left:10px;top:6px;font-size:10.5px;font-weight:550;color:#C6C9D2')}>Bedroom take 3</div>
              {/* proposed cut regions */}
              <div style={css('position:absolute;left:18%;width:4%;top:0;bottom:0;background:rgba(217,104,110,.28);border-left:1px solid rgba(217,104,110,.8);border-right:1px solid rgba(217,104,110,.8)')} />
              <div style={css('position:absolute;left:44%;width:2.4%;top:0;bottom:0;background:rgba(217,104,110,.28);border-left:1px solid rgba(217,104,110,.8);border-right:1px solid rgba(217,104,110,.8)')} />
              <div style={css('position:absolute;left:71%;width:5%;top:0;bottom:0;background:rgba(217,104,110,.28);border-left:1px solid rgba(217,104,110,.8);border-right:1px solid rgba(217,104,110,.8)')} />
              {/* silence regions */}
              <div style={css('position:absolute;left:9%;width:2.2%;top:0;bottom:0;background:rgba(217,164,74,.24)')} />
              <div style={css('position:absolute;left:33%;width:1.6%;top:0;bottom:0;background:rgba(217,164,74,.24)')} />
              <div style={css('position:absolute;left:57%;width:2.8%;top:0;bottom:0;background:rgba(217,164,74,.24)')} />
              <div style={css('position:absolute;left:86%;width:2%;top:0;bottom:0;background:rgba(217,164,74,.24)')} />
            </div>
          </div>
          {/* audio lane */}
          <div style={css('position:absolute;bottom:0;height:34px;left:0;right:0')}>
            <div style={css('position:absolute;left:1.5%;right:2%;top:5px;bottom:5px;border-radius:6px;background:rgba(70,165,124,.1);border:1px solid rgba(70,165,124,.22);overflow:hidden')}>
              <div style={css('position:absolute;inset:0;background:repeating-linear-gradient(90deg,rgba(70,165,124,.4) 0,rgba(70,165,124,.4) 2px,transparent 2px,transparent 5px);-webkit-mask-image:linear-gradient(0deg,transparent 10%,#000 30%,#000 70%,transparent 90%)')} />
            </div>
          </div>
          {/* playhead */}
          <div style={css('position:absolute;left:20%;top:0;bottom:0;width:1.5px;background:#E9EAEE;z-index:4')}><div style={css('position:absolute;top:0;left:50%;transform:translateX(-50%);width:11px;height:14px;background:#E9EAEE;border-radius:3px 3px 6px 6px')} /></div>
        </div>
      </div>
    </div>
  )
}

export default function Editor(): JSX.Element {
  return (
    <div style={css('width:100%;height:100%;background:#17181C;display:flex;flex-direction:column')} className="ec-newui ec-editor">
      <TopBar />
      <div style={css('display:flex;flex:1;min-height:0')}>
        <MediaPanel />
        <PreviewStage />
        <AiPanel />
      </div>
      <Timeline />
    </div>
  )
}
