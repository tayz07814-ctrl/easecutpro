import { useState } from 'react'
import { css } from '../css'
import { useProjects } from '../data/useProjects'
import NewProjectWizard from './NewProjectWizard'
import CoworkPanel from './CoworkPanel'
import type { ProjectMeta } from '../../projectsApi'
import type { DashCard } from '../mock'

// Mobile Dashboard — Flutter parity (mobile/lib/screens/dashboard_screen.dart)
// 4-tab bottom nav (Projects • Folders • Cowork • Batch) with IndexedStack-like
// visited-set, same tokens as Ec.theme (bg #17181C, card #1E2026, hair 0.06),
// search + cards + folders + cowork + batch exactly as the native app renders.

const HAIR = 'rgba(255,255,255,.06)'
const HAIR2 = 'rgba(255,255,255,.09)'
const HATCH = 'repeating-linear-gradient(45deg,#141419 0,#141419 12px,#101015 12px,#101015 24px)'
const BG = '#17181C'
const CARD = '#1E2026'
const CHIP = '#23252B'
const INDIGO = '#6E6AE8'
const INDIGO_TEXT = '#B7B5F4'
const INDIGO_TINT = 'rgba(110,106,232,.16)'

interface RowProps {
  meta: ProjectMeta
  card: DashCard
  onOpen: () => void
  menuOpen: boolean
  onDots: (e: React.MouseEvent) => void
  renaming: boolean
  onRenameCommit: (name: string) => void
  onRenameCancel: () => void
  onRename: () => void
  onDelete: () => void
}

function Row({ meta, card, onOpen, menuOpen, onDots, renaming, onRenameCommit, onRenameCancel, onRename, onDelete }: RowProps): JSX.Element {
  const title = 'title' in card ? card.title : meta.name
  const sub = card.kind === 'processing' ? card.sub : card.kind === 'video' || card.kind === 'failed' ? card.edited : ''
  const thumb = meta.thumb
  return (
    <div onClick={onOpen} style={css('display:flex;gap:12px;align-items:center;padding:10px;background:#1E2026;border:1px solid rgba(255,255,255,.07);border-radius:13px;position:relative;cursor:pointer')}>
      <div style={css('width:76px;height:50px;flex:none;border-radius:8px;overflow:hidden;background:' + HATCH + ';display:grid;place-items:center')}>
        {card.kind === 'video' && thumb ? (
          <img src={thumb} alt="" style={css('width:100%;height:100%;object-fit:cover')} />
        ) : card.kind === 'processing' ? (
          <span style={css('font-size:11px;font-weight:600;color:#9a9aae')}>{card.percent}%</span>
        ) : card.kind === 'failed' ? (
          <div style={css('width:22px;height:17px;border:1.5px solid #4a4a5c;border-radius:4px;display:grid;place-items:center')}>
            <div style={css('width:0;height:0;border-left:6px solid #4a4a5c;border-top:4px solid transparent;border-bottom:4px solid transparent;margin-left:2px')} />
          </div>
        ) : (
          <span style={css("font-family:'Geist Mono',monospace;font-size:9.5px;color:#6e6e85")}>16:9</span>
        )}
      </div>
      <div style={css('flex:1;min-width:0')}>
        {renaming ? (
          <input
            defaultValue={title}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => onRenameCommit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              else if (e.key === 'Escape') onRenameCancel()
            }}
            style={css('font-size:14px;font-weight:550;width:100%;background:#0c0c10;color:#ededf2;border:1px solid rgba(124,107,255,.55);border-radius:6px;padding:3px 7px;font-family:inherit;outline:none')}
          />
        ) : (
          <div style={css('font-size:14px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#E7E7EA')}>{title}</div>
        )}
        <div style={css('font-size:12px;color:#9a9aae;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{sub}</div>
        {card.kind === 'processing' && (
          <div style={css('width:100%;height:3px;border-radius:2px;background:#22222b;overflow:hidden;margin-top:7px')}>
            <div style={css(`width:${card.percent}%;height:100%;border-radius:2px;background:#7c6bff`)} />
          </div>
        )}
      </div>
      <div onClick={onDots} style={css('flex:none;color:#9a9aae;font-size:18px;line-height:1;padding:6px 8px;border-radius:8px;cursor:pointer', menuOpen && 'background:#191920')}>···</div>
      {menuOpen && (
        <div onClick={(e) => e.stopPropagation()} style={css('position:absolute;right:10px;top:calc(100% - 6px);width:170px;background:#262932;border:1px solid rgba(255,255,255,.1);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.55);padding:6px;z-index:8')}>
          <div onClick={onRename} style={css('padding:10px;font-size:14px;border-radius:8px;cursor:pointer;color:#E7E7EA')}>Rename</div>
          <div style={css('height:1px;background:rgba(255,255,255,.07);margin:4px 6px')} />
          <div onClick={onDelete} style={css('padding:10px;font-size:14px;border-radius:8px;color:#ff9b9b;cursor:pointer')}>Delete</div>
        </div>
      )}
    </div>
  )
}

function initials(email: string): string {
  if (!email) return '·'
  const name = email.split('@')[0]
  const parts = name.split(/[._-]/)
  if (parts.length >= 2 && parts[0] && parts[1]) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

function TopBar({ email, onLogout }: { email: string; onLogout: () => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div style={css('flex:none;display:flex;align-items:center;height:54px;padding:0 16px;border-bottom:1px solid rgba(255,255,255,.06);background:' + BG)}>
      <div style={css('width:22px;height:22px;border-radius:6px;background:#6E6AE8;display:grid;place-items:center')}><div style={css('width:8px;height:8px;background:#fff;transform:rotate(45deg)')} /></div>
      <div style={css('font-size:17px;font-weight:700;letter-spacing:-.02em;margin-left:9px;color:#E7E7EA')}>Easecut</div>
      <div style={css('flex:1')} />
      <div style={css('position:relative')} onClick={(e) => e.stopPropagation()}>
        <div onClick={() => setOpen((v) => !v)} style={css('width:34px;height:34px;border-radius:50%;background:#33364A;display:grid;place-items:center;font-size:12px;font-weight:600;color:#B7B5F4;cursor:pointer')}>{initials(email)}</div>
        {open && (
          <div onClick={(e) => e.stopPropagation()} style={css('position:absolute;right:0;top:42px;width:210px;background:#1E2026;border:1px solid rgba(255,255,255,.09);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.5);padding:6px;z-index:20')}>
            <div style={css('padding:8px 10px 6px;font-size:12px;color:#9a9aae;border-bottom:1px solid rgba(255,255,255,.06);margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{email || 'Signed in'}</div>
            <div onClick={() => void onLogout()} style={css('padding:9px 10px;font-size:14px;border-radius:8px;color:#9a9aae;cursor:pointer')}>Log out</div>
          </div>
        )}
      </div>
    </div>
  )
}

function BottomNav({ tab, onTab }: { tab: number; onTab: (i: number) => void }): JSX.Element {
  const item = (i: number, label: string, icon: string): JSX.Element => {
    const active = tab === i
    const color = active ? '#B7B5F4' : '#686E7B'
    return (
      <div onClick={() => onTab(i)} style={css('flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;cursor:pointer;padding:6px 0')}>
        <span style={css(`font-size:19px;line-height:1;color:${color}`)}>{icon}</span>
        <span style={css(`font-size:11px;color:${color};font-weight:${active ? 600 : 500}`)}>{label}</span>
      </div>
    )
  }
  return (
    <div style={css('flex:none;height:58px;display:flex;border-top:1px solid rgba(255,255,255,.09);background:' + BG)}>
      {item(0, 'Projects', '◧')}
      {item(1, 'Folders', '▭')}
      {item(2, 'Cowork', '◐')}
      {item(3, 'Batch', '✦')}
    </div>
  )
}

function FoldersTab({ dash }: { dash: ReturnType<typeof useProjects> }): JSX.Element {
  const { folders, selectedFolder, setSelectedFolder, folderCounts, createFolder, renameFolder, removeFolder, metas } = dash
  const [openId, setOpenId] = useState<string | null>(null)
  const folder = openId ? folders.find((f) => f.id === openId) ?? null : null
  if (folder) {
    const ids = metas.filter((m) => (m.folderId ?? null) === folder.id)
    return (
      <div style={css('flex:1;padding:18px 16px 40px;overflow:auto')}>
        <div style={css('display:flex;align-items:center;gap:8px;margin-bottom:16px')}>
          <span onClick={() => setOpenId(null)} style={css('font-size:20px;cursor:pointer;color:#C6C9D2')}>‹</span>
          <span style={css('font-size:20px;font-weight:600;color:#E7E7EA')}>{folder.name}</span>
        </div>
        {ids.length === 0 ? (
          <div style={css('color:#686E7B;font-size:13px;text-align:center;padding:44px 0')}>This folder is empty.</div>
        ) : (
          <div style={css('display:flex;flex-direction:column;gap:10px')}>
            {ids.map((m) => (
              <div key={m.id} onClick={() => void dash.open(m.id)} style={css('display:flex;gap:12px;align-items:center;padding:10px;background:#1E2026;border:1px solid rgba(255,255,255,.07);border-radius:13px;cursor:pointer')}>
                <div style={css('width:76px;height:50px;flex:none;border-radius:8px;background:' + HATCH + ';display:grid;place-items:center')}><span style={css("font-size:9.5px;color:#6e6e85")}>16:9</span></div>
                <div style={css('flex:1;font-size:14px;color:#E7E7EA')}>{m.name}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }
  return (
    <div style={css('flex:1;padding:18px 16px 40px;overflow:auto')}>
      <div style={css('font-size:22px;font-weight:650;letter-spacing:-.02em;color:#E7E7EA')}>Folders</div>
      <div style={css('font-size:13px;color:#9BA0AC;margin:4px 0 16px')}>Group your projects on this device.</div>
      <button onClick={() => void createFolder()} style={css('width:100%;background:#6E6AE8;border:none;color:#fff;font-family:inherit;font-size:14.5px;font-weight:600;border-radius:12px;padding:14px 0;cursor:pointer;box-shadow:0 6px 20px rgba(110,106,232,.35)')}>＋ New folder</button>
      <div style={css('margin-top:16px;display:flex;flex-direction:column;gap:10px')}>
        {folders.length === 0 ? (
          <div style={css('color:#686E7B;font-size:13px;text-align:center;padding:44px 0')}>No folders yet — create one to group your projects.</div>
        ) : (
          folders.map((f) => {
            const count = folderCounts.byId[f.id] ?? 0
            const sel = selectedFolder === f.id
            return (
              <div key={f.id} onClick={() => setOpenId(f.id)} style={css(`display:flex;gap:12px;align-items:center;padding:12px;background:${sel ? '#262932' : '#1E2026'};border:1px solid ${sel ? 'rgba(110,106,232,.4)' : 'rgba(255,255,255,.07)'};border-radius:13px;cursor:pointer`)}>
                <div style={css('width:42px;height:42px;border-radius:10px;background:' + INDIGO_TINT + ';display:grid;place-items:center;color:#B7B5F4')}>▭</div>
                <div style={css('flex:1')}>
                  <div style={css('font-size:14px;font-weight:500;color:#E7E7EA')}>{f.name}</div>
                  <div style={css('font-size:12px;color:#9BA0AC')}>{count} {count === 1 ? 'project' : 'projects'}</div>
                </div>
                <span onClick={(e) => { e.stopPropagation(); void renameFolder(f.id, f.name) }} style={css('color:#9a9aae;font-size:12px;padding:6px;cursor:pointer')}>✎</span>
                <span onClick={(e) => { e.stopPropagation(); void removeFolder(f.id) }} style={css('color:#ff9b9b;font-size:12px;padding:6px;cursor:pointer')}>✕</span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

function BatchTab(): JSX.Element {
  const [queue, setQueue] = useState<{ name: string }[]>([])
  const pick = async (): Promise<void> => {
    const files = await window.api.openMediaDialogMulti()
    if (files.length) setQueue((q) => [...q, ...files.map((f) => ({ name: f.name }))])
  }
  return (
    <div style={css('flex:1;padding:18px 16px 40px;overflow:auto')}>
      <div style={css('font-size:22px;font-weight:600;color:#E7E7EA')}>Batch cleaning</div>
      <div style={css('font-size:13px;color:#9BA0AC;margin:4px 0 16px')}>Enhance many clips in one go. Each opens in the editor and runs automatically.</div>
      <div onClick={() => void pick()} style={css('padding:16px;border-radius:12px;border:1.5px solid rgba(110,106,232,.5);background:rgba(110,106,232,.08);text-align:center;color:#B7B5F4;font-size:14px;font-weight:600;cursor:pointer')}>{queue.length === 0 ? '＋ Select video files' : 'Add more videos'}</div>
      {queue.length === 0 ? (
        <div style={css('color:#686E7B;font-size:13px;text-align:center;padding:44px 0')}>No videos queued yet.</div>
      ) : (
        <div style={css('margin-top:14px;display:flex;flex-direction:column;gap:9px')}>
          {queue.map((q, i) => (
            <div key={i} style={css('padding:11px 12px;background:#1E2026;border:1px solid rgba(255,255,255,.07);border-radius:12px;display:flex;align-items:center;gap:11px')}>
              <span style={css('color:#686E7B')}>◧</span><span style={css('flex:1;color:#E7E7EA;font-size:13.5px')}>{q.name}</span><span style={css('color:#686E7B;font-size:11.5px')}>Queued</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function MobileDashboard(): JSX.Element {
  const dash = useProjects()
  const [tab, setTab] = useState(0)
  const [visited, setVisited] = useState<Set<number>>(new Set([0]))
  const [menuId, setMenuId] = useState<string | null>(null)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const onTab = (i: number): void => {
    setTab(i)
    setVisited((v) => new Set([...v, i]))
    setMenuId(null)
    if (i === 0) void dash.refresh()
  }
  const Top = <TopBar email={dash.email} onLogout={dash.logout} />
  const projectsList = (
    <div style={css('flex:1;padding:18px 16px 40px;overflow:auto')}>
      <div style={css('display:flex;align-items:center;gap:10px;height:44px;padding:0 13px;background:#1E2026;border:1px solid rgba(255,255,255,.07);border-radius:12px;margin-bottom:18px')}>
        <span style={css('color:#686E7B;font-size:16px')}>⌕</span>
        <input value={dash.query} onChange={(e) => dash.setQuery(e.target.value)} placeholder="Search projects" style={css('font-size:14.5px;color:#E7E7EA;flex:1;background:none;border:none;outline:none;font-family:inherit;min-width:0')} />
      </div>
      <div style={css('font-size:22px;font-weight:650;letter-spacing:-.02em;margin-bottom:4px;color:#E7E7EA')}>Your projects</div>
      <div style={css('font-size:13px;color:#9BA0AC;margin-bottom:16px')}>Saved automatically as you edit.</div>
      <div style={css('display:flex;gap:10px;margin-bottom:22px')}>
        <button onClick={() => setWizardOpen(true)} style={css('flex:1;background:#6E6AE8;border:none;color:#fff;font-family:inherit;font-size:14.5px;font-weight:600;border-radius:12px;padding:14px 0;cursor:pointer;box-shadow:0 6px 20px rgba(110,106,232,.35)')}>＋ New project</button>
        <button onClick={() => onTab(3)} style={css('flex:none;background:none;border:1px solid rgba(255,255,255,.1);color:#C6C9D2;font-family:inherit;font-size:14.5px;font-weight:500;border-radius:12px;padding:14px 20px;cursor:pointer')}>Batch</button>
      </div>
      <div style={css('display:flex;flex-direction:column;gap:10px')}>
        {dash.metas.length === 0 && (
          <div style={css('color:#6e6e85;font-size:14px;text-align:center;padding:44px 0')}>{dash.loading ? 'Loading…' : dash.query ? 'No projects match your search.' : 'No projects yet — tap ＋ New project to start.'}</div>
        )}
        {dash.metas.map((meta, i) => {
          const card = dash.cards[i + 1]
          if (!card) return null
          const id = meta.id
          return (
            <Row
              key={id}
              meta={meta}
              card={card}
              onOpen={() => void dash.open(id)}
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
    </div>
  )

  return (
    <div className="ec-newui ec-m-dash" style={css('width:100%;min-height:100dvh;background:' + BG + ';display:flex;flex-direction:column')} onClick={() => setMenuId(null)}>
      {Top}
      <div style={css('flex:1;display:flex;flex-direction:column;overflow:hidden;background:' + BG)}>
        <div style={css('flex:1;display:flex;flex-direction:column;overflow:hidden')}>
          {tab === 0 && projectsList}
          {tab === 1 && <FoldersTab dash={dash} />}
          {tab === 2 && <div style={css('flex:1;overflow:auto')}>{visited.has(2) ? <CoworkPanel /> : null}</div>}
          {tab === 3 && <BatchTab />}
        </div>
      </div>
      <BottomNav tab={tab} onTab={onTab} />
      {wizardOpen && <NewProjectWizard onClose={() => setWizardOpen(false)} />}
    </div>
  )
}
