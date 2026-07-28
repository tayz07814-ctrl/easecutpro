import { useMemo, useState } from 'react'
import { css } from '../css'
import { useProjects } from '../data/useProjects'
import { useStore } from '../../store'
import NewProjectWizard from './NewProjectWizard'
import type { DashCard } from '../mock'

// Screen 1a — Project dashboard, "Easecut Redesign" layout. Left rail + main
// (news banner, drop zone, filter tabs, project grid) + live batch dock.
// Every functional surface (search, nav, new project, batch, cards, rename,
// delete, logout) is wired to the real store via useProjects; the news slides
// and the "this week" headline stats are illustrative design chrome (no backing
// feed), exactly as the mock ships them.

const HAIR = 'rgba(255,255,255,.06)'

const NAV = [
  { id: 'local', label: 'Local projects' },
  { id: 'cloud', label: 'Cloud cowork' },
  { id: 'recents', label: 'Recents' }
] as const
type NavId = (typeof NAV)[number]['id']

const NAV_BASE = 'padding:9px 10px;border-radius:9px;font-size:13.5px;cursor:pointer;display:flex;align-items:center;justify-content:space-between'
const NAV_ON = `${NAV_BASE};background:rgba(124,107,255,.14);color:#C4BAFF;font-weight:500`
const NAV_OFF = `${NAV_BASE};color:#9A9AAE`

// Illustrative "what's new" slides (static — no backend feed).
const NEWS = [
  { tag: 'New', tone: '#7C6BFF', date: 'JUL 28', art: 'TRANSCRIPT EDITING', title: 'Edit the transcript, edit the video', body: 'Strike a word in the new Transcript panel and the cut happens on the timeline. Available now in the editor.', cta: 'Try it on a project' },
  { tag: 'Beta', tone: '#E6B26A', date: 'JUL 24', art: 'BATCH QUEUE', title: 'Batch cleaning is 2× faster', body: 'Retake detection now runs in parallel across queued clips. A ten-clip batch finishes in about the time three used to take.', cta: 'Read the changelog' },
  { tag: 'Coming', tone: '#7ED6A6', date: 'AUG 05', art: 'AUTO ZOOM', title: 'Auto zoom enters beta next week', body: 'Punch-in zooms placed on emphasis, detected from your delivery. Beta testers get it first — no waitlist.', cta: 'Join the beta group' }
]

const FILTERS = ['All', 'Needs review', 'Cleaned', 'Processing'] as const

function initials(email: string): string {
  const name = (email.split('@')[0] || 'you').replace(/[^a-zA-Z]/g, '')
  return (name.slice(0, 2) || 'YO').toUpperCase()
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
      <div onClick={onDelete} style={css('padding:8px 10px;font-size:13px;border-radius:8px;color:#FF9B9B;cursor:pointer')}>Delete</div>
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

function Card({ card, onOpen, onDots, menuOpen, hovered, onHover, renaming, onRename, onRenameCommit, onRenameCancel, onDelete }: CardProps): JSX.Element | null {
  // Grid only ever receives real project cards (video/processing); the leading
  // "new" tile and skeletons are handled elsewhere. Guard keeps the union safe.
  if (card.kind === 'new' || card.kind === 'skeleton') return null
  const working = card.kind === 'processing'
  const title = card.title
  const edited = card.kind === 'processing' ? card.sub : card.edited
  const image = card.kind === 'video' ? card.image : undefined
  const duration = card.kind === 'video' || card.kind === 'failed' ? card.duration : ''
  const showHover = hovered || menuOpen

  const badge = working ? (
    <span style={css('display:inline-flex;align-items:center;gap:5px;background:rgba(10,10,13,.82);backdrop-filter:blur(6px);border:1px solid rgba(230,178,106,.35);color:#E6B26A;font-size:10.5px;font-weight:500;padding:3px 8px;border-radius:20px')}>
      <span style={css('width:5px;height:5px;border-radius:50%;background:#E6B26A;animation:ecPulse 1.4s infinite')} />Cleaning
    </span>
  ) : (
    <span style={css('display:inline-flex;align-items:center;gap:5px;background:rgba(10,10,13,.82);backdrop-filter:blur(6px);border:1px solid rgba(126,214,166,.3);color:#7ED6A6;font-size:10.5px;font-weight:500;padding:3px 8px;border-radius:20px')}>
      <span style={css('width:5px;height:5px;border-radius:50%;background:#7ED6A6')} />Cleaned
    </span>
  )

  const thumbInner = image ? (
    <>
      <img src={image} alt="" style={css('position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:blur(18px);opacity:.5;transform:scale(1.15)')} />
      <img src={image} alt="" style={css('position:relative;z-index:1;height:100%;width:100%;object-fit:contain;display:block')} />
    </>
  ) : (
    <div style={css('width:41%;height:100%;background-image:repeating-linear-gradient(135deg,#1B1B22 0 6px,#141419 6px 12px);display:flex;align-items:flex-end;justify-content:center;padding-bottom:10px')}>
      <span style={css("font-family:'Geist Mono',monospace;font-size:8.5px;color:#4E4E60;letter-spacing:.06em")}>9:16</span>
    </div>
  )

  return (
    <div
      onClick={onOpen}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
      style={css(
        'background:#101015;border:1px solid rgba(255,255,255,.07);border-radius:14px;cursor:pointer;transition:border-color .15s,transform .15s;position:relative',
        showHover ? 'overflow:visible;border-color:rgba(124,107,255,.45);transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,.35)' : 'overflow:hidden'
      )}
    >
      <div style={css('position:relative;aspect-ratio:16/10;background:#0A0A0D;display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:13px 13px 0 0')}>
        {thumbInner}
        <div style={css('position:absolute;left:9px;top:9px')}>{badge}</div>
        {duration ? (
          <span style={css("position:absolute;right:9px;bottom:9px;font-family:'Geist Mono',monospace;font-size:10px;background:rgba(10,10,13,.8);padding:2px 6px;border-radius:5px;color:#B9B9CC")}>{duration}</span>
        ) : null}
      </div>
      <div style={css('padding:12px 13px 13px')}>
        <div style={css('display:flex;align-items:flex-start;gap:8px')}>
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
              style={css('flex:1;min-width:0;font-size:13.5px;font-weight:600;background:#0C0C10;color:#EDEDF2;border:1px solid rgba(124,107,255,.55);border-radius:6px;padding:2px 6px;font-family:inherit;outline:none')}
            />
          ) : (
            <div style={css('flex:1;min-width:0;font-size:13.5px;font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{title}</div>
          )}
          <div onClick={onDots} style={css('color:#6E6E85;font-size:15px;line-height:1;cursor:pointer', showHover && 'color:#9A9AAE')}>···</div>
        </div>
        <div style={css('display:flex;align-items:center;gap:7px;margin-top:6px;font-size:11.5px;color:#7A7A8C')}>
          <span>{edited}</span>
          {working ? null : (
            <>
              <span style={css('width:2.5px;height:2.5px;border-radius:50%;background:#4A4A5C')} />
              <span style={css('color:#7ED6A6')}>Ready</span>
            </>
          )}
        </div>
      </div>
      {menuOpen && <ContextMenu onRename={onRename} onDelete={onDelete} />}
    </div>
  )
}

function BatchDock({ onHide }: { onHide: () => void }): JSX.Element | null {
  const jobs = useStore((s) => s.batchJobs)
  if (!jobs.length) return null
  const active = jobs.filter((j) => j.status === 'queued' || j.status === 'processing')
  const rows = jobs.map((j) => {
    if (j.status === 'processing') {
      return (
        <div key={j.projectId} style={css('background:#101015;border:1px solid rgba(124,107,255,.3);border-radius:11px;padding:12px 13px')}>
          <div style={css('display:flex;align-items:center;gap:8px;font-size:12.5px')}>
            <span style={css('flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500')}>{j.name}</span>
            <span style={css("font-family:'Geist Mono',monospace;font-size:10.5px;color:#A99BFF")}>·····</span>
          </div>
          <div style={css('height:3px;background:rgba(255,255,255,.08);border-radius:3px;margin-top:9px;overflow:hidden')}>
            <div style={css('width:60%;height:100%;background:#7C6BFF;border-radius:3px')} />
          </div>
          <div style={css('font-size:11px;color:#7A7A8C;margin-top:7px')}>{j.step || 'Working…'}</div>
        </div>
      )
    }
    if (j.status === 'queued') {
      return (
        <div key={j.projectId} style={css('background:#0E0E12;border:1px solid rgba(255,255,255,.06);border-radius:11px;padding:12px 13px')}>
          <div style={css('display:flex;align-items:center;gap:8px;font-size:12.5px')}>
            <span style={css('flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#9A9AAE')}>{j.name}</span>
            <span style={css("font-family:'Geist Mono',monospace;font-size:10.5px;color:#6E6E85")}>Queued</span>
          </div>
        </div>
      )
    }
    const err = j.status === 'error'
    return (
      <div key={j.projectId} style={css('background:#0E0E12;border:1px solid rgba(255,255,255,.06);border-radius:11px;padding:12px 13px')}>
        <div style={css('display:flex;align-items:center;gap:8px;font-size:12.5px')}>
          <span style={css('flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#9A9AAE')}>{j.name}</span>
          <span style={css(`display:flex;align-items:center;gap:5px;font-size:10.5px;color:${err ? '#FF9B9B' : '#7ED6A6'}`)}>
            <span style={css(`width:5px;height:5px;border-radius:50%;background:${err ? '#FF9B9B' : '#7ED6A6'}`)} />{err ? 'Failed' : 'Done'}
          </span>
        </div>
        {j.step ? <div style={css('font-size:11px;color:#7A7A8C;margin-top:7px')}>{err ? j.error || j.step : j.step}</div> : null}
      </div>
    )
  })

  return (
    <div style={css('width:326px;flex:none;background:#0A0A0D;border-left:1px solid rgba(255,255,255,.07);display:flex;flex-direction:column')}>
      <div style={css(`display:flex;align-items:center;gap:10px;padding:19px 18px 17px;border-bottom:1px solid ${HAIR}`)}>
        <span style={css(`width:7px;height:7px;border-radius:50%;background:${active.length ? '#E6B26A' : '#7ED6A6'}${active.length ? ';animation:ecPulse 1.4s infinite' : ''}`)} />
        <span style={css('font-size:13px;font-weight:600;letter-spacing:-.01em')}>{active.length ? `Cleaning ${active.length} video${active.length > 1 ? 's' : ''}` : 'Batch queue'}</span>
        <div style={css('flex:1')} />
        <span style={css("font-family:'Geist Mono',monospace;font-size:10.5px;color:#7A7A8C")}>{jobs.length} total</span>
      </div>
      <div style={css('flex:1;min-height:0;overflow-y:auto;padding:12px 12px 16px;display:flex;flex-direction:column;gap:8px')}>{rows}</div>
      <div style={css('display:flex;gap:8px;padding:0 12px 14px')}>
        <button onClick={onHide} style={css('flex:1;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:#D6D6E4;font-family:inherit;font-size:12.5px;padding:8px;border-radius:8px;cursor:pointer')}>Hide</button>
      </div>
    </div>
  )
}

export default function Dashboard(): JSX.Element {
  const dash = useProjects()
  const batchJobs = useStore((s) => s.batchJobs)
  const [acct, setAcct] = useState(false)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [src, setSrc] = useState<NavId>('local')
  const [filter, setFilter] = useState(0)
  const [news, setNews] = useState(0)
  const [dockHidden, setDockHidden] = useState(false)

  const activeJobs = batchJobs.filter((j) => j.status === 'queued' || j.status === 'processing')
  const jobIds = useMemo(
    () => new Set(batchJobs.filter((j) => j.status === 'queued' || j.status === 'processing').map((j) => j.projectId)),
    [batchJobs]
  )

  // Real project (meta, card) pairs — cards[0] is the leading "new" tile, so
  // metas[i] aligns with cards[i+1]. The redesign grid is projects-only (no new
  // tile), so we iterate metas and carry the folded card for its display fields.
  const pairs = useMemo(() => {
    let rows = dash.metas.map((meta, i) => ({ meta, card: dash.cards[i + 1] })).filter((r) => r.card)
    if (src === 'recents') rows = rows.slice(0, 12)
    if (filter === 2) rows = rows.filter((r) => !jobIds.has(r.meta.id)) // Cleaned
    else if (filter === 3) rows = rows.filter((r) => jobIds.has(r.meta.id)) // Processing
    // filter 1 "Needs review" has no backing status source → behaves as All.
    return rows
  }, [dash.metas, dash.cards, src, filter, jobIds])

  const navTitle = NAV.find((n) => n.id === src)?.label ?? 'Projects'
  const slide = NEWS[news] || NEWS[0]

  return (
    <div style={css('width:100%;height:100%;display:flex;overflow:hidden;background:#08080A')} className="ec-newui ec-dash" onClick={() => { setAcct(false); setMenuId(null) }}>
      {/* ============ LEFT RAIL ============ */}
      <aside style={css(`width:216px;flex:none;background:#0C0C10;border-right:1px solid ${HAIR};display:flex;flex-direction:column;padding:18px 14px`)}>
        <div style={css('display:flex;align-items:center;gap:10px;padding:4px 8px 22px')}>
          <div style={css('width:26px;height:26px;border-radius:8px;background:linear-gradient(150deg,#7C6BFF,#4B3DD1);display:flex;align-items:center;justify-content:center')}>
            <div style={css('width:9px;height:9px;background:#fff;transform:rotate(45deg);border-radius:2px')} />
          </div>
          <span style={css('font-size:15px;font-weight:600;letter-spacing:-.01em')}>Easecut</span>
          <span style={css("font-family:'Geist Mono',monospace;font-size:9px;color:#8B8BA0;border:1px solid rgba(255,255,255,.12);padding:2px 5px;border-radius:5px;letter-spacing:.04em")}>BETA</span>
        </div>

        <div style={css('display:flex;flex-direction:column;gap:2px')}>
          {NAV.map((n) => {
            const on = src === n.id
            const count = n.id === 'recents' ? Math.min(dash.metas.length, 12) : dash.metas.length
            return (
              <div key={n.id} onClick={(e) => { e.stopPropagation(); setSrc(n.id); setFilter(0) }} style={css(on ? NAV_ON : NAV_OFF)}>
                <span>{n.label}</span>
                <span style={css(`font-family:'Geist Mono',monospace;font-size:10px;color:${on ? '#A99BFF' : '#5C5C70'}`)}>{count}</span>
              </div>
            )
          })}
        </div>

        <div style={css("margin-top:26px;padding:0 10px 10px;font-family:'Geist Mono',monospace;font-size:9.5px;letter-spacing:.1em;color:#5C5C70")}>THIS WEEK</div>
        <div style={css(`background:#111116;border:1px solid ${HAIR};border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:12px`)}>
          <div>
            <div style={css('font-size:22px;font-weight:600;letter-spacing:-.02em')}>1h 47m</div>
            <div style={css('font-size:11.5px;color:#8B8BA0;margin-top:2px')}>of dead air removed</div>
          </div>
          <div style={css(`height:1px;background:${HAIR}`)} />
          <div style={css('display:flex;justify-content:space-between;font-size:11.5px;color:#8B8BA0')}>
            <span>Projects</span><span style={css('color:#EDEDF2')}>{dash.metas.length}</span>
          </div>
          <div style={css('display:flex;justify-content:space-between;font-size:11.5px;color:#8B8BA0')}>
            <span>Avg. trim</span><span style={css('color:#EDEDF2')}>21%</span>
          </div>
        </div>

        <div style={css('flex:1')} />
        <div style={css('position:relative;display:flex;align-items:center;gap:10px;padding:9px 8px;border-radius:10px;cursor:pointer')} onClick={(e) => { e.stopPropagation(); setAcct((v) => !v) }}>
          <div style={css('width:28px;height:28px;border-radius:50%;background:#2A2A34;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:#C9C9DA')}>{initials(dash.email)}</div>
          <div style={css('flex:1;min-width:0')}>
            <div style={css('font-size:12.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{dash.email.split('@')[0] || 'You'}</div>
            <div style={css('font-size:10.5px;color:#7A7A8C')}>Beta tester</div>
          </div>
          {acct && (
            <div onClick={(e) => e.stopPropagation()} style={css('position:absolute;left:0;bottom:calc(100% + 6px);width:196px;background:#101015;border:1px solid rgba(255,255,255,.09);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.5);padding:6px;z-index:20')}>
              <div style={css(`padding:8px 10px 6px;font-size:12px;color:#9A9AAE;border-bottom:1px solid ${HAIR};margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis`)}>{dash.email}</div>
              <div style={css('padding:8px 10px;font-size:13px;border-radius:8px;cursor:pointer')}>Account settings</div>
              <div onClick={() => void dash.logout()} style={css('padding:8px 10px;font-size:13px;border-radius:8px;color:#9A9AAE;cursor:pointer')}>Log out</div>
            </div>
          )}
        </div>
      </aside>

      {/* ============ MAIN ============ */}
      <main style={css('flex:1;min-width:0;display:flex;flex-direction:column;position:relative')}>
        <header style={css(`height:60px;flex:none;border-bottom:1px solid ${HAIR};display:flex;align-items:center;gap:16px;padding:0 26px`)}>
          <div style={css('flex:0 1 380px;min-width:190px;height:36px;display:flex;align-items:center;gap:9px;background:#111116;border:1px solid rgba(255,255,255,.07);border-radius:9px;padding:0 11px;overflow:hidden')}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#71718A" strokeWidth="1.6"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg>
            <input
              value={dash.query}
              onChange={(e) => dash.setQuery(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              placeholder="Search projects, transcripts, files"
              style={css('flex:1;min-width:0;font-size:13px;color:#EDEDF2;background:none;border:none;outline:none;font-family:inherit;padding:0;margin:0')}
            />
            <span style={css("font-family:'Geist Mono',monospace;font-size:10px;color:#5C5C70;border:1px solid rgba(255,255,255,.1);border-radius:4px;padding:1px 5px;flex:none")}>⌘K</span>
          </div>
          <div style={css('flex:1')} />
          {activeJobs.length > 0 && (
            <span onClick={(e) => { e.stopPropagation(); setDockHidden(false) }} style={css('display:flex;align-items:center;gap:7px;flex:none;white-space:nowrap;font-size:13px;color:#9A9AAE;padding:8px 12px;border-radius:9px;cursor:pointer')}>
              <span style={css('width:6px;height:6px;border-radius:50%;background:#E6B26A;animation:ecPulse 1.4s infinite')} />Queue {activeJobs.length}
            </span>
          )}
          <button onClick={() => void dash.batch()} style={css('flex:none;white-space:nowrap;background:transparent;border:1px solid rgba(255,255,255,.12);color:#D6D6E4;font-family:inherit;font-size:13px;font-weight:500;padding:8px 14px;border-radius:9px;cursor:pointer')}>Batch clean</button>
          <button onClick={(e) => { e.stopPropagation(); setWizardOpen(true) }} style={css('flex:none;white-space:nowrap;background:#7C6BFF;border:none;color:#fff;font-family:inherit;font-size:13px;font-weight:600;padding:9px 16px;border-radius:9px;cursor:pointer;box-shadow:0 4px 16px rgba(124,107,255,.32)')}>New project</button>
        </header>

        <div style={css('flex:1;min-height:0;display:flex;overflow-x:auto')}>
          <div style={css('flex:1;min-width:600px;overflow-y:auto;padding:30px 26px 60px')}>
            <div style={css('max-width:1320px;margin:0 auto')}>
              {/* news banner slideshow */}
              <div style={css('position:relative;height:268px;border-radius:16px;overflow:hidden;background:#101016;border:1px solid rgba(255,255,255,.07);margin-bottom:22px')}>
                <div style={css(`position:absolute;left:44%;right:0;top:0;bottom:0;background:radial-gradient(120% 140% at 80% 20%, ${slide.tone}2e, #101016 62%)`)}>
                  <div style={css(`position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:'Geist Mono',monospace;font-size:11px;letter-spacing:.16em;color:${slide.tone}99`)}>{slide.art}</div>
                </div>
                <div style={css('position:absolute;left:0;top:0;bottom:0;width:52%;pointer-events:none;background:linear-gradient(90deg,#0B0B0F 0%,#0B0B0F 74%,rgba(11,11,15,0) 100%)')} />
                <div style={css('position:absolute;left:0;top:0;bottom:0;width:46%;padding:30px 30px 30px 32px;display:flex;flex-direction:column;justify-content:center;gap:9px')}>
                  <div style={css('display:flex;align-items:center;gap:9px')}>
                    <span style={css(`font-size:10.5px;font-weight:600;letter-spacing:.02em;padding:3px 8px;border-radius:20px;background:${slide.tone}22;color:${slide.tone}`)}>{slide.tag}</span>
                    <span style={css("font-family:'Geist Mono',monospace;font-size:10px;color:#8B8BA0")}>{slide.date}</span>
                  </div>
                  <div style={css('font-size:26px;font-weight:600;letter-spacing:-.025em;line-height:1.18')}>{slide.title}</div>
                  <div style={css('font-size:13px;color:#B0B0C2;line-height:1.55')}>{slide.body}</div>
                  <div style={css('margin-top:8px')}><span style={css('display:inline-block;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.16);color:#EDEDF2;font-size:12.5px;font-weight:500;padding:8px 14px;border-radius:9px;cursor:pointer')}>{slide.cta}</span></div>
                </div>
                <div onClick={(e) => { e.stopPropagation(); setNews((news + NEWS.length - 1) % NEWS.length) }} style={css('position:absolute;right:74px;bottom:22px;width:30px;height:30px;border-radius:9px;background:rgba(6,6,9,.6);border:1px solid rgba(255,255,255,.14);display:flex;align-items:center;justify-content:center;cursor:pointer;color:#D6D6E4;font-size:13px')}>‹</div>
                <div onClick={(e) => { e.stopPropagation(); setNews((news + 1) % NEWS.length) }} style={css('position:absolute;right:36px;bottom:22px;width:30px;height:30px;border-radius:9px;background:rgba(6,6,9,.6);border:1px solid rgba(255,255,255,.14);display:flex;align-items:center;justify-content:center;cursor:pointer;color:#D6D6E4;font-size:13px')}>›</div>
                <div style={css('position:absolute;right:36px;top:22px;display:flex;gap:5px')}>
                  {NEWS.map((_, i) => (
                    <div key={i} onClick={(e) => { e.stopPropagation(); setNews(i) }} style={css(`width:${news === i ? 16 : 6}px;height:6px;border-radius:6px;cursor:pointer;transition:width .2s;background:${news === i ? '#7C6BFF' : 'rgba(255,255,255,.16)'}`)} />
                  ))}
                </div>
              </div>

              {/* drop zone */}
              <div style={css('border:1px dashed rgba(255,255,255,.14);border-radius:16px;padding:22px 24px;display:flex;align-items:center;gap:18px;background:linear-gradient(180deg,rgba(124,107,255,.06),rgba(124,107,255,0))')}>
                <div style={css('width:42px;height:42px;flex:none;border-radius:12px;background:rgba(124,107,255,.14);display:flex;align-items:center;justify-content:center')}>
                  <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="#A99BFF" strokeWidth="1.7" strokeLinecap="round"><path d="M10 14V4M6 8l4-4 4 4M3.5 15.5v1a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-1" /></svg>
                </div>
                <div style={css('flex:1')}>
                  <div style={css('font-size:14.5px;font-weight:600;letter-spacing:-.01em')}>Drop footage here to start a clean</div>
                  <div style={css('font-size:12.5px;color:#8B8BA0;margin-top:3px')}>Drop two or more clips and we&rsquo;ll queue them as a batch automatically.</div>
                </div>
                <button onClick={(e) => { e.stopPropagation(); setWizardOpen(true) }} style={css('background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);color:#EDEDF2;font-family:inherit;font-size:12.5px;font-weight:500;padding:8px 14px;border-radius:8px;cursor:pointer')}>Browse files</button>
              </div>

              {/* toolbar */}
              <div style={css('display:flex;align-items:center;gap:10px;margin:28px 0 16px')}>
                <h1 style={css('margin:0;font-size:19px;font-weight:600;letter-spacing:-.02em')}>{navTitle}</h1>
                <span style={css("font-family:'Geist Mono',monospace;font-size:11px;color:#6E6E85;margin-top:2px")}>{pairs.length}</span>
                <div style={css('flex:1')} />
                <div style={css('display:flex;gap:3px;background:#101015;border:1px solid rgba(255,255,255,.07);border-radius:9px;padding:3px')}>
                  {FILTERS.map((label, i) => (
                    <div key={label} onClick={(e) => { e.stopPropagation(); setFilter(i) }} style={css('font-size:12.5px;padding:5px 11px;border-radius:7px;cursor:pointer;white-space:nowrap', filter === i ? 'background:rgba(255,255,255,.09);color:#EDEDF2;font-weight:500' : 'color:#8B8BA0')}>{label}</div>
                  ))}
                </div>
                <div style={css('display:flex;align-items:center;gap:6px;border:1px solid rgba(255,255,255,.07);border-radius:9px;padding:7px 11px;font-size:12.5px;color:#9A9AAE;cursor:pointer')}>
                  <span>Last edited</span>
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="#71718A" strokeWidth="1.6"><path d="m3 4.5 3 3 3-3" /></svg>
                </div>
              </div>

              {/* grid */}
              {pairs.length === 0 ? (
                <div style={css('padding:60px 0;text-align:center;color:#6E6E85;font-size:13px')}>
                  {dash.loading ? 'Loading projects…' : dash.query ? 'No projects match your search.' : 'No projects yet — start one with “New project”.'}
                </div>
              ) : (
                <div style={css('display:grid;grid-template-columns:repeat(auto-fill,minmax(226px,1fr));gap:18px')}>
                  {pairs.map(({ meta, card }) => {
                    const id = meta.id
                    return (
                      <Card
                        key={id}
                        card={card}
                        onOpen={() => void dash.open(id)}
                        hovered={hoverId === id}
                        onHover={(v) => setHoverId(v ? id : (h) => (h === id ? null : h))}
                        menuOpen={menuId === id}
                        onDots={(e) => { e.stopPropagation(); setMenuId((m) => (m === id ? null : id)) }}
                        renaming={renameId === id}
                        onRename={() => { setRenameId(id); setMenuId(null) }}
                        onRenameCommit={(name) => { setRenameId(null); void dash.rename(id, name) }}
                        onRenameCancel={() => setRenameId(null)}
                        onDelete={() => { setMenuId(null); if (confirm('Delete this project? This cannot be undone.')) void dash.remove(id) }}
                      />
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          {/* batch queue dock (only when there are jobs) */}
          {!dockHidden && <BatchDock onHide={() => setDockHidden(true)} />}
        </div>
      </main>

      {wizardOpen && <NewProjectWizard onClose={() => setWizardOpen(false)} />}
    </div>
  )
}
