import { useEffect, useMemo, useState } from 'react'
import { css } from '../css'
import { useProjects } from '../data/useProjects'
import FolderRail, { projectDragType } from './FolderRail'
import { useStore, makeXferReporter } from '../../store'
import { getProject } from '../../projectsApi'
import { hydrateProjectMedia } from '../../webapi'
import { shareProject, listSpaces, listSpaceFolders, type Space, type SpaceFolder } from '../../cloud/cowork'
import NewProjectWizard from './NewProjectWizard'
import CoworkPanel from './CoworkPanel'
import NotificationsBell from './NotificationsBell'
import {
  getSubscription,
  isProNow,
  checkoutConfigured,
  onBillingChange,
  openAccountPanel,
  type Subscription
} from '../../cloud/subscription'
import type { DashCard } from '../mock'

// Screen 1a — Project dashboard, "Easecut Redesign" layout. Left rail + main
// (news banner, drop zone, filter tabs, project grid) + live batch dock.
// Every functional surface (search, nav, new project, batch, cards, rename,
// delete, logout) is wired to the real store via useProjects. The "this week"
// tile is now REAL (counted from project timestamps); the news slides below are
// still illustrative design chrome with no backing feed.

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

function ContextMenu({
  onRename,
  onDelete,
  onUpload
}: {
  onRename?: () => void
  onDelete?: () => void
  onUpload?: (spaceId: string, folderId: string | null) => void
}): JSX.Element {
  // Drill-down: root → pick a space → pick a folder → upload. Staying inside one
  // popover avoids fragile nested-flyout positioning near the grid edges.
  const [view, setView] = useState<'root' | 'spaces' | 'folders'>('root')
  const [spaces, setSpaces] = useState<Space[]>([])
  const [folders, setFolders] = useState<SpaceFolder[]>([])
  const [space, setSpace] = useState<Space | null>(null)
  const [loading, setLoading] = useState(false)

  const openSpaces = async (): Promise<void> => {
    setView('spaces')
    setLoading(true)
    try {
      setSpaces(await listSpaces())
    } catch {
      setSpaces([])
    } finally {
      setLoading(false)
    }
  }
  const openFolders = async (s: Space): Promise<void> => {
    setSpace(s)
    setView('folders')
    setLoading(true)
    try {
      setFolders(await listSpaceFolders(s.id))
    } catch {
      setFolders([])
    } finally {
      setLoading(false)
    }
  }
  const rs = 'padding:8px 10px;font-size:13px;border-radius:8px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={css('position:absolute;right:8px;top:calc(100% - 8px);width:196px;max-height:288px;overflow-y:auto;background:#191920;border:1px solid rgba(255,255,255,.1);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.55);padding:6px;z-index:6')}
    >
      {view === 'root' && (
        <>
          <div onClick={onRename} style={css(rs)}>Rename</div>
          <div onClick={(e) => { e.stopPropagation(); void openSpaces() }} style={css(`${rs};display:flex;align-items:center;justify-content:space-between;color:#C4BAFF`)}>
            Upload to space<span style={css('color:#7A7A8C')}>›</span>
          </div>
          <div style={css('height:1px;background:rgba(255,255,255,.07);margin:4px 6px')} />
          <div onClick={onDelete} style={css(`${rs};color:#FF9B9B`)}>Delete</div>
        </>
      )}
      {view === 'spaces' && (
        <>
          <div onClick={(e) => { e.stopPropagation(); setView('root') }} style={css(`${rs};color:#8B8BA0`)}>‹ Back</div>
          {loading ? (
            <div style={css(`${rs};color:#6E6E85`)}>Loading…</div>
          ) : spaces.length ? (
            spaces.map((s) => (
              <div key={s.id} onClick={(e) => { e.stopPropagation(); void openFolders(s) }} style={css(`${rs};display:flex;align-items:center;justify-content:space-between`)}>
                <span style={css('flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis')}>{s.name}</span>
                <span style={css('color:#7A7A8C')}>›</span>
              </div>
            ))
          ) : (
            <div style={css(`${rs};color:#6E6E85`)}>No spaces yet</div>
          )}
        </>
      )}
      {view === 'folders' && (
        <>
          <div onClick={(e) => { e.stopPropagation(); setView('spaces') }} style={css(`${rs};color:#8B8BA0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis`)}>‹ {space?.name ?? 'Spaces'}</div>
          <div onClick={(e) => { e.stopPropagation(); if (space) onUpload?.(space.id, null) }} style={css(`${rs};color:#C4BAFF`)}>Upload here (no folder)</div>
          {loading ? (
            <div style={css(`${rs};color:#6E6E85`)}>Loading…</div>
          ) : (
            folders.map((f) => (
              <div key={f.id} onClick={(e) => { e.stopPropagation(); if (space) onUpload?.(space.id, f.id) }} style={css(`${rs};display:flex;align-items:center;gap:8px`)}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="#7A7A8C" strokeWidth="1.4" strokeLinejoin="round"><path d="M2 5c0-.66.54-1.2 1.2-1.2h2.4c.4 0 .77.2 1 .53l.5.74c.23.33.6.53 1 .53H12.8c.66 0 1.2.54 1.2 1.2v4.9c0 .66-.54 1.2-1.2 1.2H3.2c-.66 0-1.2-.54-1.2-1.2V5z" /></svg>
                <span style={css('flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis')}>{f.name}</span>
              </div>
            ))
          )}
        </>
      )}
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
  onUpload?: (spaceId: string, folderId: string | null) => void
  /** when set, the card is draggable and carries this id as the folder-drop payload. */
  dragId?: string
}

function Card({ card, onOpen, onDots, menuOpen, hovered, onHover, renaming, onRename, onRenameCommit, onRenameCancel, onDelete, onUpload, dragId }: CardProps): JSX.Element | null {
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
      draggable={!!dragId && !renaming}
      onDragStart={
        dragId
          ? (e): void => {
              e.dataTransfer.setData(projectDragType, dragId)
              e.dataTransfer.effectAllowed = 'move'
            }
          : undefined
      }
      style={css(
        'background:#101015;border:1px solid rgba(255,255,255,.07);border-radius:14px;cursor:pointer;transition:border-color .15s,transform .15s;position:relative',
        showHover ? 'overflow:visible;border-color:rgba(124,107,255,.45);transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,.35);z-index:20' : 'overflow:hidden'
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
      {menuOpen && <ContextMenu onRename={onRename} onDelete={onDelete} onUpload={onUpload} />}
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

// Right-side dock listing live Cloud Cowork transfers — uploads while sharing a
// project to R2, downloads while opening one — each with a real byte-progress
// bar. Store-backed so it keeps updating as the user moves around the dashboard.
function CoworkTransferDock(): JSX.Element | null {
  const transfers = useStore((s) => s.coworkTransfers)
  const dismiss = useStore((s) => s.dismissCoworkXfers)
  if (!transfers.length) return null
  const active = transfers.filter((t) => t.status === 'active')
  const anyDown = active.some((t) => t.kind === 'download')
  const title = active.length
    ? `${anyDown ? 'Downloading' : 'Uploading'} ${active.length} file${active.length > 1 ? 's' : ''}`
    : 'Transfers'
  return (
    <div style={css('width:326px;flex:none;background:#0A0A0D;border-left:1px solid rgba(255,255,255,.07);display:flex;flex-direction:column')}>
      <div style={css(`display:flex;align-items:center;gap:10px;padding:19px 18px 17px;border-bottom:1px solid ${HAIR}`)}>
        <span style={css(`width:7px;height:7px;border-radius:50%;background:${active.length ? '#7C6BFF' : '#7ED6A6'}${active.length ? ';animation:ecPulse 1.4s infinite' : ''}`)} />
        <span style={css('font-size:13px;font-weight:600;letter-spacing:-.01em')}>{title}</span>
        <div style={css('flex:1')} />
        <span onClick={dismiss} style={css('font-size:11px;color:#7A7A8C;cursor:pointer')}>Clear done</span>
      </div>
      <div style={css('flex:1;min-height:0;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px')}>
        {transfers.map((t) => {
          const err = t.status === 'error'
          const done = t.status === 'done'
          const color = err ? '#FF9B9B' : done ? '#7ED6A6' : '#7C6BFF'
          return (
            <div key={t.id} style={css('background:#101015;border:1px solid rgba(255,255,255,.07);border-radius:11px;padding:12px 13px')}>
              <div style={css('display:flex;align-items:center;gap:8px;font-size:12.5px')}>
                <span style={css(`font-size:12px;color:${color};flex:none`)} title={t.kind}>{t.kind === 'upload' ? '↑' : '↓'}</span>
                <span style={css('flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500')}>{t.name}</span>
                <span style={css(`font-family:'Geist Mono',monospace;font-size:10.5px;color:${color}`)}>{err ? 'Failed' : done ? 'Done' : `${t.pct}%`}</span>
              </div>
              <div style={css('height:3px;background:rgba(255,255,255,.08);border-radius:3px;margin-top:9px;overflow:hidden')}>
                <div style={css(`width:${err ? 100 : t.pct}%;height:100%;background:${color};border-radius:3px;transition:width .25s`)} />
              </div>
              <div style={css('font-size:11px;color:#7A7A8C;margin-top:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{t.step}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function Dashboard(): JSX.Element {
  const dash = useProjects()
  const batchJobs = useStore((s) => s.batchJobs)
  const [acct, setAcct] = useState(false)
  const [sub, setSub] = useState<Subscription | null>(null)
  const pro = isProNow(sub)

  // Pro/subscription status for the account menu (cloud only). Refreshes when the
  // billing bus fires (e.g. after a checkout completes and the webhook writes).
  useEffect(() => {
    if (!checkoutConfigured()) return
    let active = true
    void getSubscription().then((s) => {
      if (active) setSub(s)
    })
    const off = onBillingChange(async () => {
      if (active) setSub(await getSubscription())
    })
    return () => {
      active = false
      off()
    }
  }, [])
  const [menuId, setMenuId] = useState<string | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [src, setSrc] = useState<NavId>('local')
  const [filter, setFilter] = useState(0)
  const [news, setNews] = useState(0)
  const [dockHidden, setDockHidden] = useState(false)
  const [showLocalNotice, setShowLocalNotice] = useState(() => {
    try {
      return localStorage.getItem('ec_localonly_notice') !== '1'
    } catch {
      return true
    }
  })
  const dismissLocalNotice = (): void => {
    setShowLocalNotice(false)
    try {
      localStorage.setItem('ec_localonly_notice', '1')
    } catch {
      /* ignore */
    }
  }

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

  // Upload a device-local project into a cowork space (+ optional folder). Per-file
  // progress lands in the transfer dock (shown in this view while active).
  const uploadToSpace = async (projectId: string, name: string, spaceId: string, folderId: string | null): Promise<void> => {
    try {
      const rec = await getProject(projectId)
      if (!rec?.project) throw new Error('Could not load that project')
      await hydrateProjectMedia(rec.project)
      await shareProject(spaceId, rec.project, name, makeXferReporter(), folderId)
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Could not upload to the space')
    }
  }

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

        {/* Real figures only. This tile used to read "1h 47m of dead air removed"
            and "Avg. trim 21%" — both hard-coded literals from the design mock,
            identical for every creator forever. Nothing records removed time, so
            they could not be made accurate; showing invented numbers to a paying
            creator is worse than showing fewer. Counted over ALL projects, not the
            filtered card list, so searching doesn't move them. */}
        <div style={css("margin-top:26px;padding:0 10px 10px;font-family:'Geist Mono',monospace;font-size:9.5px;letter-spacing:.1em;color:#5C5C70")}>THIS WEEK</div>
        <div style={css(`background:#111116;border:1px solid ${HAIR};border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:12px`)}>
          <div>
            <div style={css('font-size:22px;font-weight:600;letter-spacing:-.02em')}>{dash.weekly.editedThisWeek}</div>
            <div style={css('font-size:11.5px;color:#8B8BA0;margin-top:2px')}>project{dash.weekly.editedThisWeek === 1 ? '' : 's'} edited</div>
          </div>
          <div style={css(`height:1px;background:${HAIR}`)} />
          <div style={css('display:flex;justify-content:space-between;font-size:11.5px;color:#8B8BA0')}>
            <span>All projects</span><span style={css('color:#EDEDF2')}>{dash.weekly.total}</span>
          </div>
        </div>

        <div style={css('flex:1')} />
        <div style={css('position:relative;display:flex;align-items:center;gap:10px;padding:9px 8px;border-radius:10px;cursor:pointer')} onClick={(e) => { e.stopPropagation(); setAcct((v) => !v) }}>
          <div style={css('width:28px;height:28px;border-radius:50%;background:#2A2A34;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:#C9C9DA')}>{initials(dash.email)}</div>
          <div style={css('flex:1;min-width:0')}>
            <div style={css('font-size:12.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{dash.email.split('@')[0] || 'You'}</div>
            <div style={css('font-size:10.5px;color:#7A7A8C')}>{pro ? '★ Pro' : 'Beta tester'}</div>
          </div>
          {acct && (
            <div onClick={(e) => e.stopPropagation()} style={css('position:absolute;left:0;bottom:calc(100% + 6px);width:196px;background:#101015;border:1px solid rgba(255,255,255,.09);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.5);padding:6px;z-index:20')}>
              <div style={css(`padding:8px 10px 6px;font-size:12px;color:#9A9AAE;border-bottom:1px solid ${HAIR};margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis`)}>{dash.email}</div>
              {checkoutConfigured() && (
                <div
                  onClick={() => {
                    setAcct(false)
                    openAccountPanel()
                  }}
                  style={css('padding:8px 10px;font-size:13px;border-radius:8px;font-weight:600;cursor:pointer', pro ? 'color:#F5C518' : 'color:#B7B5F4')}
                >
                  {pro ? '★ Pro — manage' : '★ Upgrade to Pro'}
                </div>
              )}
              <div
                onClick={() => {
                  setAcct(false)
                  openAccountPanel()
                }}
                style={css('padding:8px 10px;font-size:13px;border-radius:8px;cursor:pointer')}
              >
                Account settings
              </div>
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
          <NotificationsBell onJoined={() => { setSrc('cloud'); setFilter(0) }} />
          <button onClick={() => void dash.batch()} style={css('flex:none;white-space:nowrap;background:transparent;border:1px solid rgba(255,255,255,.12);color:#D6D6E4;font-family:inherit;font-size:13px;font-weight:500;padding:8px 14px;border-radius:9px;cursor:pointer')}>Batch clean</button>
          <button onClick={(e) => { e.stopPropagation(); setWizardOpen(true) }} style={css('flex:none;white-space:nowrap;background:#7C6BFF;border:none;color:#fff;font-family:inherit;font-size:13px;font-weight:600;padding:9px 16px;border-radius:9px;cursor:pointer;box-shadow:0 4px 16px rgba(124,107,255,.32)')}>New project</button>
        </header>

        <div style={css('flex:1;min-height:0;display:flex;overflow-x:auto')}>
          <div style={css('flex:1;min-width:600px;overflow-y:auto;padding:30px 26px 60px')}>
            <div style={css('max-width:1320px;margin:0 auto')}>
              {src === 'cloud' ? <CoworkPanel /> : (<>
              {/* one-time notice: local projects are now device-only */}
              {showLocalNotice && (
                <div style={css('display:flex;align-items:flex-start;gap:12px;padding:13px 15px;margin-bottom:16px;border-radius:12px;background:rgba(124,107,255,.08);border:1px solid rgba(124,107,255,.24)')}>
                  <div style={css('width:30px;height:30px;flex:none;border-radius:8px;background:rgba(124,107,255,.16);display:flex;align-items:center;justify-content:center')}>
                    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="#A99BFF" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="4.5" y="2.5" width="11" height="15" rx="2" /><path d="M8 5.5h4M8 8.5h4" /></svg>
                  </div>
                  <div style={css('flex:1;min-width:0')}>
                    <div style={css('font-size:13.5px;font-weight:600;letter-spacing:-.01em;color:#EDEDF2')}>Local projects now stay on this device</div>
                    <div style={css('font-size:12.5px;color:#A6A6BA;line-height:1.5;margin-top:3px')}>They&rsquo;re no longer saved to the cloud. To edit a project on another device, right-click it → <span style={css('color:#C4BAFF')}>Upload to space</span> first (or open Cloud cowork). Clearing this browser&rsquo;s data removes local projects.</div>
                  </div>
                  <span onClick={dismissLocalNotice} title="Got it" style={css('cursor:pointer;color:#8B8BA0;font-size:14px;flex:none;padding:2px 4px')}>✕</span>
                </div>
              )}

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

              {/* folders (device-local) + project grid */}
              <div style={css('display:flex;gap:22px;align-items:flex-start')}>
                <FolderRail
                  folders={dash.folders}
                  selected={dash.selectedFolder}
                  counts={dash.folderCounts}
                  onSelect={dash.setSelectedFolder}
                  onCreate={() => void dash.createFolder()}
                  onRename={(fid, name) => void dash.renameFolder(fid, name)}
                  onDelete={(fid) => void dash.removeFolder(fid)}
                  onDropProject={(fid, pid) => void dash.moveToFolder(pid, fid)}
                />
                <div style={css('flex:1;min-width:0')}>
                  {pairs.length === 0 ? (
                    <div style={css('padding:60px 0;text-align:center;color:#6E6E85;font-size:13px')}>
                      {dash.loading
                        ? 'Loading projects…'
                        : dash.query
                          ? 'No projects match your search.'
                          : dash.selectedFolder
                            ? 'This folder is empty — drag a project here to file it.'
                            : 'No projects yet — start one with “New project”.'}
                    </div>
                  ) : (
                    <div style={css('display:grid;grid-template-columns:repeat(auto-fill,minmax(226px,1fr));gap:18px')}>
                      {pairs.map(({ meta, card }) => {
                        const id = meta.id
                        return (
                          <Card
                            key={id}
                            card={card}
                            dragId={id}
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
                            onUpload={(spaceId, folderId) => { setMenuId(null); void uploadToSpace(id, meta.name, spaceId, folderId) }}
                          />
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
              </>)}
            </div>
          </div>

          {/* right dock: cowork transfers (also visible in the local view while an
              "Upload to space" is in flight — the dock self-hides when empty) */}
          {src === 'cloud' ? (
            <CoworkTransferDock />
          ) : (
            <>
              <CoworkTransferDock />
              {!dockHidden && <BatchDock onHide={() => setDockHidden(true)} />}
            </>
          )}
        </div>
      </main>

      {wizardOpen && <NewProjectWizard onClose={() => setWizardOpen(false)} />}
    </div>
  )
}
