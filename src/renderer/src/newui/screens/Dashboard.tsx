import { useState } from 'react'
import { css } from '../css'
import { useProjects } from '../data/useProjects'
import NewProjectWizard from './NewProjectWizard'
import type { DashCard } from '../mock'

// Screen 1a — Project dashboard (1440). Wired to real projects via useProjects.
// The design's static open menus become click-toggled; every style string and
// DOM node is preserved from the Stage A port (no visual drift).

const HAIR = 'rgba(255,255,255,.06)'
const DUR =
  'position:absolute;right:10px;bottom:10px;font-family:\'Geist Mono\',monospace;font-size:10.5px;color:#ededf2;background:rgba(8,8,10,.7);border-radius:6px;padding:3px 7px'

function Dots({ active, onClick }: { active?: boolean; onClick?: (e: React.MouseEvent) => void }): JSX.Element {
  return (
    <div
      onClick={onClick}
      style={css(
        'color:#9a9aae;font-size:16px;line-height:1;padding:4px 6px;border-radius:8px;cursor:pointer',
        active && 'background:#191920'
      )}
    >
      ···
    </div>
  )
}

function CardFooter({
  title,
  sub,
  active,
  onDots,
  renaming,
  onRenameCommit,
  onRenameCancel
}: {
  title: string
  sub: string
  active?: boolean
  onDots?: (e: React.MouseEvent) => void
  renaming?: boolean
  onRenameCommit?: (name: string) => void
  onRenameCancel?: () => void
}): JSX.Element {
  return (
    <div style={css('display:flex;align-items:flex-start;gap:10px;padding:14px 14px 16px')}>
      <div style={css('flex:1;min-width:0')}>
        {renaming ? (
          <input
            defaultValue={title}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => onRenameCommit?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              else if (e.key === 'Escape') onRenameCancel?.()
            }}
            style={css(
              'font-size:13.5px;font-weight:550;width:100%;background:#0c0c10;color:#ededf2;border:1px solid rgba(124,107,255,.55);border-radius:6px;padding:2px 6px;font-family:inherit;outline:none'
            )}
          />
        ) : (
          <div style={css('font-size:13.5px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>
            {title}
          </div>
        )}
        <div style={css('font-size:12px;color:#9a9aae;margin-top:4px')}>{sub}</div>
      </div>
      <Dots active={active} onClick={onDots} />
    </div>
  )
}

interface CardProps {
  card: DashCard
  onOpen?: () => void
  onDots?: (e: React.MouseEvent) => void
  menuOpen?: boolean
  hovered?: boolean
  onHover?: (v: boolean) => void
  renaming?: boolean
  onRename?: () => void
  onRenameCommit?: (name: string) => void
  onRenameCancel?: () => void
  onDelete?: () => void
}

function Card({ card, onOpen, onDots, menuOpen, hovered, onHover, renaming, onRename, onRenameCommit, onRenameCancel, onDelete }: CardProps): JSX.Element {
  if (card.kind === 'new') {
    return (
      <div onClick={onOpen} style={css('border:1.5px dashed rgba(255,255,255,.13);border-radius:14px;min-height:264px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;cursor:pointer')}>
        <div style={css('width:44px;height:44px;border-radius:50%;background:#101015;border:1px solid rgba(255,255,255,.08);display:grid;place-items:center;font-size:20px;color:#a99bff;font-weight:400')}>＋</div>
        <div style={css('font-size:13.5px;font-weight:550;color:#c9c9da')}>New project</div>
        <div style={css('font-size:12px;color:#6e6e85')}>Drop a video to start</div>
      </div>
    )
  }

  if (card.kind === 'skeleton') {
    return (
      <div style={css('background:#101015;border:1px solid rgba(255,255,255,.08);border-radius:14px;overflow:hidden')}>
        <div style={css('aspect-ratio:16/9;background:linear-gradient(90deg,#141419 25%,#191920 50%,#141419 75%);background-size:200% 100%')} />
        <div style={css('padding:14px 14px 16px;display:flex;flex-direction:column;gap:8px')}>
          <div style={css('width:70%;height:12px;border-radius:6px;background:#191920')} />
          <div style={css('width:40%;height:10px;border-radius:5px;background:#141419')} />
        </div>
      </div>
    )
  }

  if (card.kind === 'processing') {
    return (
      <div style={css('background:#101015;border:1px solid rgba(255,255,255,.08);border-radius:14px;overflow:hidden')}>
        <div style={css('position:relative;aspect-ratio:16/9;background:repeating-linear-gradient(45deg,#141419 0,#141419 12px,#101015 12px,#101015 24px)')}>
          <div style={css('position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px')}>
            <div style={css('width:120px;height:4px;border-radius:2px;background:#22222b;overflow:hidden')}>
              <div style={css(`width:${card.percent}%;height:100%;border-radius:2px;background:#7c6bff`)} />
            </div>
            <div style={css('font-size:11.5px;color:#9a9aae')}>Processing · {card.percent}%</div>
          </div>
        </div>
        <CardFooter title={card.title} sub={card.sub} />
      </div>
    )
  }

  if (card.kind === 'failed') {
    return (
      <div
        onClick={onOpen}
        onMouseEnter={() => onHover?.(true)}
        onMouseLeave={() => onHover?.(false)}
        style={css('background:#101015;border:1px solid rgba(255,255,255,.08);border-radius:14px;overflow:hidden;cursor:pointer')}
      >
        <div style={css('position:relative;aspect-ratio:16/9;background:#101015;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px')}>
          <div style={css('width:34px;height:26px;border:1.5px solid #4a4a5c;border-radius:6px;display:grid;place-items:center')}>
            <div style={css('width:0;height:0;border-left:8px solid #4a4a5c;border-top:5px solid transparent;border-bottom:5px solid transparent;margin-left:2px')} />
          </div>
          <div style={css('font-size:11.5px;color:#6e6e85')}>Preview unavailable</div>
          {card.duration && <div style={css(DUR)}>{card.duration}</div>}
        </div>
        <CardFooter title={card.title} sub={card.edited} active={hovered || menuOpen} onDots={onDots} renaming={renaming} onRenameCommit={onRenameCommit} onRenameCancel={onRenameCancel} />
        {menuOpen && <ContextMenu onRename={onRename} onDelete={onDelete} />}
      </div>
    )
  }

  // kind === 'video'
  const showHover = hovered || menuOpen
  // Real project thumbnail: a blurred cover fills the 16:9 frame, the sharp image
  // sits contained on top — so vertical phone captures show whole, not hard-cropped.
  const playOverlay = showHover && (
    <div style={css('position:absolute;inset:0;z-index:2;background:rgba(8,8,10,.45);display:grid;place-items:center')}>
      <div style={css('width:44px;height:44px;border-radius:50%;background:rgba(237,237,242,.92);display:grid;place-items:center')}>
        <div style={css('width:0;height:0;border-left:13px solid #08080a;border-top:8px solid transparent;border-bottom:8px solid transparent;margin-left:3px')} />
      </div>
    </div>
  )
  const thumb = card.image ? (
    <div style={css('position:relative;aspect-ratio:16/9;border-radius:13px 13px 0 0;overflow:hidden;background:#0c0c10')}>
      <img src={card.image} alt="" style={css('position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:blur(20px);opacity:.5;transform:scale(1.15)')} />
      <img src={card.image} alt="" style={css('position:relative;z-index:1;width:100%;height:100%;object-fit:contain;display:block')} />
      {playOverlay}
      {card.duration && <div style={css(DUR)}>{card.duration}</div>}
    </div>
  ) : (
    // No cached thumbnail yet — a clean neutral tile (subtle film glyph), never a
    // "Preview unavailable" error. A real frame replaces this once one is generated.
    <div style={css('position:relative;aspect-ratio:16/9;border-radius:13px 13px 0 0;overflow:hidden;background:#101015;display:grid;place-items:center')}>
      <div style={css('width:34px;height:26px;border:1.5px solid #2a2a34;border-radius:6px;display:grid;place-items:center')}>
        <div style={css('width:0;height:0;border-left:8px solid #2a2a34;border-top:5px solid transparent;border-bottom:5px solid transparent;margin-left:2px')} />
      </div>
      {playOverlay}
      {card.duration && <div style={css(DUR)}>{card.duration}</div>}
    </div>
  )

  const shell = showHover
    ? 'background:#101015;border:1px solid rgba(255,255,255,.08);border-radius:14px;overflow:visible;position:relative;box-shadow:0 8px 24px rgba(0,0,0,.35);cursor:pointer'
    : 'background:#101015;border:1px solid rgba(255,255,255,.08);border-radius:14px;overflow:hidden;cursor:pointer'

  return (
    <div onClick={onOpen} onMouseEnter={() => onHover?.(true)} onMouseLeave={() => onHover?.(false)} style={css(shell)}>
      {thumb}
      <CardFooter title={card.title} sub={card.edited} active={showHover} onDots={onDots} renaming={renaming} onRenameCommit={onRenameCommit} onRenameCancel={onRenameCancel} />
      {menuOpen && <ContextMenu onRename={onRename} onDelete={onDelete} />}
    </div>
  )
}

function ContextMenu({ onRename, onDelete }: { onRename?: () => void; onDelete?: () => void }): JSX.Element {
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={css('position:absolute;right:8px;top:calc(100% - 8px);width:160px;background:#191920;border:1px solid rgba(255,255,255,.1);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.55);padding:6px;z-index:6')}
    >
      <div onClick={onRename} style={css('padding:8px 10px;font-size:13px;border-radius:8px;cursor:pointer')}>Rename</div>
      <div style={css('padding:8px 10px;font-size:13px;border-radius:8px;cursor:pointer')}>Duplicate</div>
      <div style={css('height:1px;background:rgba(255,255,255,.07);margin:4px 6px')} />
      <div onClick={onDelete} style={css('padding:8px 10px;font-size:13px;border-radius:8px;color:#ff9b9b;cursor:pointer')}>Delete</div>
    </div>
  )
}

export default function Dashboard(): JSX.Element {
  const dash = useProjects()
  const [acct, setAcct] = useState(false)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)

  // cards[0] is the "new" tile; cards[i+1] aligns with metas[i].
  const metaFor = (i: number): { id: string } | undefined => (i > 0 ? dash.metas[i - 1] : undefined)

  return (
    <div style={css('width:100%;height:100%;overflow-y:auto;background:#08080a')} className="ec-newui ec-dash" onClick={() => { setAcct(false); setMenuId(null) }}>
      {/* top nav */}
      <div style={css(`display:flex;align-items:center;gap:24px;height:64px;padding:0 40px;border-bottom:1px solid ${HAIR}`)}>
        <div style={css('display:flex;align-items:center;gap:10px')}>
          <div style={css('width:22px;height:22px;border-radius:7px;background:#7c6bff;display:grid;place-items:center')}>
            <div style={css('width:8px;height:8px;background:#fff;border-radius:2px;transform:rotate(45deg)')} />
          </div>
          <div style={css('font-size:17px;font-weight:700;letter-spacing:-.02em')}>Easecut</div>
        </div>
        <div style={css('flex:1;display:flex;justify-content:center')}>
          <div style={css('display:flex;align-items:center;gap:10px;width:360px;height:38px;padding:0 12px;background:#101015;border:1px solid rgba(255,255,255,.07);border-radius:10px')}>
            <div style={css('width:12px;height:12px;border:1.5px solid #6e6e85;border-radius:50%;position:relative')}>
              <div style={css('position:absolute;width:5px;height:1.5px;background:#6e6e85;bottom:-2px;right:-3px;transform:rotate(45deg)')} />
            </div>
            <input
              value={dash.query}
              onChange={(e) => dash.setQuery(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              placeholder="Search projects"
              style={css('font-size:13px;color:#ededf2;flex:1;background:none;border:none;outline:none;font-family:inherit;min-width:0;padding:0;margin:0')}
            />
            <span style={css("font-family:'Geist Mono',monospace;font-size:10px;color:#6e6e85;background:#191920;border-radius:5px;padding:2px 6px")}>⌘K</span>
          </div>
        </div>
        <div style={css('display:flex;align-items:center;gap:8px;position:relative')} onClick={(e) => { e.stopPropagation(); setAcct((v) => !v) }}>
          <div style={css('width:34px;height:34px;border-radius:50%;background:#22222b;display:grid;place-items:center;font-size:12px;font-weight:600;color:#a99bff;cursor:pointer')}>TZ</div>
          <div style={css('width:8px;height:8px;border-right:1.5px solid #6e6e85;border-bottom:1.5px solid #6e6e85;transform:rotate(45deg);margin-top:-4px')} />
        </div>
      </div>

      {/* account menu */}
      {acct && (
        <div style={css('position:relative')} onClick={(e) => e.stopPropagation()}>
          <div style={css('position:absolute;right:40px;top:8px;width:200px;background:#101015;border:1px solid rgba(255,255,255,.09);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.5);padding:6px;z-index:5')}>
            <div style={css('padding:8px 10px 6px;font-size:12px;color:#9a9aae;border-bottom:1px solid rgba(255,255,255,.06);margin-bottom:4px')}>{dash.email}</div>
            <div style={css('padding:8px 10px;font-size:13px;border-radius:8px;cursor:pointer')}>Account settings</div>
            <div style={css('padding:8px 10px;font-size:13px;border-radius:8px;cursor:pointer')}>Keyboard shortcuts</div>
            <div onClick={() => void dash.logout()} style={css('padding:8px 10px;font-size:13px;border-radius:8px;color:#9a9aae;cursor:pointer')}>Log out</div>
          </div>
        </div>
      )}

      {/* body */}
      <div style={css('max-width:1216px;margin:0 auto;padding:48px 40px 64px')}>
        <div style={css('display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:36px')}>
          <div>
            <div style={css('font-size:28px;font-weight:650;letter-spacing:-.02em')}>Your projects</div>
            <div style={css('font-size:14px;color:#9a9aae;margin-top:6px')}>Everything is saved automatically as you edit.</div>
          </div>
          <div style={css('display:flex;align-items:center;gap:12px')}>
            <button onClick={() => void dash.batch()} style={css('background:none;border:1px solid rgba(255,255,255,.1);color:#c9c9da;font-family:inherit;font-size:13px;font-weight:500;border-radius:10px;padding:10px 16px;cursor:pointer')}>Batch clean videos</button>
            <button onClick={(e) => { e.stopPropagation(); setWizardOpen(true) }} style={css('background:#7c6bff;border:none;color:#fff;font-family:inherit;font-size:13px;font-weight:600;border-radius:10px;padding:10px 18px;cursor:pointer;box-shadow:0 6px 20px rgba(124,107,255,.35)')}>＋ New project</button>
          </div>
        </div>

        <div style={css('display:grid;grid-template-columns:repeat(4,1fr);gap:24px')}>
          {dash.cards.map((c, i) => {
            const meta = metaFor(i)
            const id = meta?.id
            return (
              <Card
                key={id ?? `new-${i}`}
                card={c}
                onOpen={i === 0 ? () => setWizardOpen(true) : id ? () => void dash.open(id) : undefined}
                hovered={id ? hoverId === id : false}
                onHover={id ? (v) => setHoverId(v ? id : (h) => (h === id ? null : h)) : undefined}
                menuOpen={id ? menuId === id : false}
                onDots={id ? (e) => { e.stopPropagation(); setMenuId((m) => (m === id ? null : id)) } : undefined}
                renaming={id ? renameId === id : false}
                onRename={id ? () => { setRenameId(id); setMenuId(null) } : undefined}
                onRenameCommit={id ? (name) => { setRenameId(null); void dash.rename(id, name) } : undefined}
                onRenameCancel={() => setRenameId(null)}
                onDelete={id ? () => { setMenuId(null); if (confirm('Delete this project? This cannot be undone.')) void dash.remove(id) } : undefined}
              />
            )
          })}
        </div>
      </div>
      {wizardOpen && <NewProjectWizard onClose={() => setWizardOpen(false)} />}
    </div>
  )
}
