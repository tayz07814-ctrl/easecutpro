import { css } from '../css'
import { DASH_CARDS, MOCK_EMAIL, type DashCard } from '../mock'

// Screen 1a — Project dashboard (1440). Verbatim port of the approved design.
// Fluid: nav is full-width; content is capped at max-width 1216 and centered,
// so 1920 keeps the same column and 1280 narrows the side gutters (design
// responsive rule for the dashboard).

const HAIR = 'rgba(255,255,255,.06)'

function Dots({ hover }: { hover?: boolean }): JSX.Element {
  return (
    <div
      style={css(
        'color:#9BA0AC;font-size:16px;line-height:1;padding:4px 6px;border-radius:8px;cursor:pointer',
        hover && 'background:#262932'
      )}
    >
      ···
    </div>
  )
}

function CardFooter({ title, sub, hover }: { title: string; sub: string; hover?: boolean }): JSX.Element {
  return (
    <div style={css('display:flex;align-items:flex-start;gap:10px;padding:14px 14px 16px')}>
      <div style={css('flex:1;min-width:0')}>
        <div style={css('font-size:13.5px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>
          {title}
        </div>
        <div style={css('font-size:12px;color:#9BA0AC;margin-top:4px')}>{sub}</div>
      </div>
      <Dots hover={hover} />
    </div>
  )
}

const DUR =
  'position:absolute;right:10px;bottom:10px;font-family:\'IBM Plex Mono\',monospace;font-size:10.5px;color:#E9EAEE;background:rgba(13,14,17,.7);border-radius:6px;padding:3px 7px'
const HATCH = 'repeating-linear-gradient(45deg,#23252b 0,#23252b 12px,#1e2026 12px,#1e2026 24px)'

function Card({ card }: { card: DashCard }): JSX.Element {
  if (card.kind === 'new') {
    return (
      <div style={css('border:1.5px dashed rgba(255,255,255,.13);border-radius:14px;min-height:264px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;cursor:pointer')}>
        <div style={css('width:44px;height:44px;border-radius:50%;background:#1E2026;border:1px solid rgba(255,255,255,.08);display:grid;place-items:center;font-size:20px;color:#8B88F0;font-weight:400')}>＋</div>
        <div style={css('font-size:13.5px;font-weight:550;color:#C6C9D2')}>New project</div>
        <div style={css('font-size:12px;color:#686E7B')}>Drop a video to start</div>
      </div>
    )
  }

  if (card.kind === 'skeleton') {
    return (
      <div style={css('background:#1E2026;border:1px solid rgba(255,255,255,.08);border-radius:14px;overflow:hidden')}>
        <div style={css('aspect-ratio:16/9;background:linear-gradient(90deg,#22242b 25%,#282b33 50%,#22242b 75%);background-size:200% 100%')} />
        <div style={css('padding:14px 14px 16px;display:flex;flex-direction:column;gap:8px')}>
          <div style={css('width:70%;height:12px;border-radius:6px;background:#262932')} />
          <div style={css('width:40%;height:10px;border-radius:5px;background:#22242b')} />
        </div>
      </div>
    )
  }

  if (card.kind === 'processing') {
    return (
      <div style={css('background:#1E2026;border:1px solid rgba(255,255,255,.08);border-radius:14px;overflow:hidden')}>
        <div style={css('position:relative;aspect-ratio:16/9;background:repeating-linear-gradient(45deg,#20222a 0,#20222a 12px,#1c1e24 12px,#1c1e24 24px)')}>
          <div style={css('position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px')}>
            <div style={css('width:120px;height:4px;border-radius:2px;background:#2A2D36;overflow:hidden')}>
              <div style={css(`width:${card.percent}%;height:100%;border-radius:2px;background:#6E6AE8`)} />
            </div>
            <div style={css('font-size:11.5px;color:#9BA0AC')}>Processing · {card.percent}%</div>
          </div>
        </div>
        <CardFooter title={card.title} sub={card.sub} />
      </div>
    )
  }

  if (card.kind === 'failed') {
    return (
      <div style={css('background:#1E2026;border:1px solid rgba(255,255,255,.08);border-radius:14px;overflow:hidden')}>
        <div style={css('position:relative;aspect-ratio:16/9;background:#1A1C21;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px')}>
          <div style={css('width:34px;height:26px;border:1.5px solid #4A4F5B;border-radius:6px;display:grid;place-items:center')}>
            <div style={css('width:0;height:0;border-left:8px solid #4A4F5B;border-top:5px solid transparent;border-bottom:5px solid transparent;margin-left:2px')} />
          </div>
          <div style={css('font-size:11.5px;color:#686E7B')}>Preview unavailable</div>
          <div style={css(DUR)}>{card.duration}</div>
        </div>
        <CardFooter title={card.title} sub={card.edited} />
      </div>
    )
  }

  // kind === 'video'
  const vertical = card.thumb === '9:16'
  const thumb = card.hover ? (
    <div style={css('position:relative;aspect-ratio:16/9;border-radius:13px 13px 0 0;overflow:hidden;background:' + HATCH)}>
      <div style={css("position:absolute;inset:0;display:grid;place-items:center;font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:#686E7B")}>16:9 thumbnail</div>
      <div style={css('position:absolute;inset:0;background:rgba(13,14,17,.45);display:grid;place-items:center')}>
        <div style={css('width:44px;height:44px;border-radius:50%;background:rgba(233,234,238,.92);display:grid;place-items:center')}>
          <div style={css('width:0;height:0;border-left:13px solid #17181C;border-top:8px solid transparent;border-bottom:8px solid transparent;margin-left:3px')} />
        </div>
      </div>
      <div style={css(DUR)}>{card.duration}</div>
    </div>
  ) : vertical ? (
    <div style={css('position:relative;aspect-ratio:16/9;background:#15161a;display:grid;place-items:center')}>
      <div style={css("height:100%;aspect-ratio:9/16;background:" + HATCH + ";display:grid;place-items:center;font-family:'IBM Plex Mono',monospace;font-size:10px;color:#686E7B")}>9:16</div>
      <div style={css(DUR)}>{card.duration}</div>
    </div>
  ) : (
    <div style={css('position:relative;aspect-ratio:16/9;background:' + HATCH)}>
      <div style={css("position:absolute;inset:0;display:grid;place-items:center;font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:#686E7B")}>16:9 thumbnail</div>
      <div style={css(DUR)}>{card.duration}</div>
    </div>
  )

  const shell = card.hover
    ? 'background:#1E2026;border:1px solid rgba(255,255,255,.08);border-radius:14px;overflow:visible;position:relative;box-shadow:0 8px 24px rgba(0,0,0,.35)'
    : 'background:#1E2026;border:1px solid rgba(255,255,255,.08);border-radius:14px;overflow:hidden'

  return (
    <div style={css(shell)}>
      {thumb}
      <CardFooter title={card.title} sub={card.edited} hover={card.hover} />
      {card.hover && (
        <div style={css('position:absolute;right:8px;top:calc(100% - 8px);width:160px;background:#262932;border:1px solid rgba(255,255,255,.1);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.55);padding:6px;z-index:6')}>
          <div style={css('padding:8px 10px;font-size:13px;border-radius:8px')}>Rename</div>
          <div style={css('padding:8px 10px;font-size:13px;border-radius:8px')}>Duplicate</div>
          <div style={css('height:1px;background:rgba(255,255,255,.07);margin:4px 6px')} />
          <div style={css('padding:8px 10px;font-size:13px;border-radius:8px;color:#D9686E')}>Delete</div>
        </div>
      )}
    </div>
  )
}

export default function Dashboard(): JSX.Element {
  return (
    <div style={css('width:100%;background:#17181C')} className="ec-newui ec-dash">
      {/* top nav */}
      <div style={css(`display:flex;align-items:center;gap:24px;height:64px;padding:0 40px;border-bottom:1px solid ${HAIR}`)}>
        <div style={css('display:flex;align-items:center;gap:10px')}>
          <div style={css('width:22px;height:22px;border-radius:7px;background:#6E6AE8;display:grid;place-items:center')}>
            <div style={css('width:8px;height:8px;background:#fff;border-radius:2px;transform:rotate(45deg)')} />
          </div>
          <div style={css('font-size:17px;font-weight:700;letter-spacing:-.02em')}>Easecut</div>
        </div>
        <div style={css('flex:1;display:flex;justify-content:center')}>
          <div style={css('display:flex;align-items:center;gap:10px;width:360px;height:38px;padding:0 12px;background:#1E2026;border:1px solid rgba(255,255,255,.07);border-radius:10px')}>
            <div style={css('width:12px;height:12px;border:1.5px solid #686E7B;border-radius:50%;position:relative')}>
              <div style={css('position:absolute;width:5px;height:1.5px;background:#686E7B;bottom:-2px;right:-3px;transform:rotate(45deg)')} />
            </div>
            <span style={css('font-size:13px;color:#686E7B;flex:1')}>Search projects</span>
            <span style={css("font-family:'IBM Plex Mono',monospace;font-size:10px;color:#686E7B;background:#262932;border-radius:5px;padding:2px 6px")}>⌘K</span>
          </div>
        </div>
        <div style={css('display:flex;align-items:center;gap:8px')}>
          <div style={css('width:34px;height:34px;border-radius:50%;background:#33364a;display:grid;place-items:center;font-size:12px;font-weight:600;color:#B7B5F4')}>TZ</div>
          <div style={css('width:8px;height:8px;border-right:1.5px solid #686E7B;border-bottom:1.5px solid #686E7B;transform:rotate(45deg);margin-top:-4px')} />
        </div>
      </div>

      {/* account menu (open, tucked under avatar) */}
      <div style={css('position:relative')}>
        <div style={css('position:absolute;right:40px;top:8px;width:200px;background:#1E2026;border:1px solid rgba(255,255,255,.09);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.5);padding:6px;z-index:5')}>
          <div style={css('padding:8px 10px 6px;font-size:12px;color:#9BA0AC;border-bottom:1px solid rgba(255,255,255,.06);margin-bottom:4px')}>{MOCK_EMAIL}</div>
          <div style={css('padding:8px 10px;font-size:13px;border-radius:8px')}>Account settings</div>
          <div style={css('padding:8px 10px;font-size:13px;border-radius:8px')}>Keyboard shortcuts</div>
          <div style={css('padding:8px 10px;font-size:13px;border-radius:8px;color:#9BA0AC')}>Log out</div>
        </div>
      </div>

      {/* body */}
      <div style={css('max-width:1216px;margin:0 auto;padding:48px 40px 64px')}>
        <div style={css('display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:36px')}>
          <div>
            <div style={css('font-size:28px;font-weight:650;letter-spacing:-.02em')}>Your projects</div>
            <div style={css('font-size:14px;color:#9BA0AC;margin-top:6px')}>Everything is saved automatically as you edit.</div>
          </div>
          <div style={css('display:flex;align-items:center;gap:12px')}>
            <button style={css('background:none;border:1px solid rgba(255,255,255,.1);color:#C6C9D2;font-family:inherit;font-size:13px;font-weight:500;border-radius:10px;padding:10px 16px;cursor:pointer')}>Batch clean videos</button>
            <button style={css('background:#6E6AE8;border:none;color:#fff;font-family:inherit;font-size:13px;font-weight:600;border-radius:10px;padding:10px 18px;cursor:pointer;box-shadow:0 6px 20px rgba(110,106,232,.35)')}>＋ New project</button>
          </div>
        </div>

        <div style={css('display:grid;grid-template-columns:repeat(4,1fr);gap:24px')}>
          {DASH_CARDS.map((c, i) => (
            <Card key={i} card={c} />
          ))}
        </div>
      </div>
    </div>
  )
}
