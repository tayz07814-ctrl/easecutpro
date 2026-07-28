import { useState } from 'react'
import { css } from '../css'
import { useProjects } from '../data/useProjects'
import NewProjectWizard from './NewProjectWizard'
import type { ProjectMeta } from '../../projectsApi'
import type { DashCard } from '../mock'

// Mobile Dashboard (screen 1a, phone). Same data as the desktop Dashboard
// (useProjects) but a single-column, touch-sized layout instead of the 4-column
// grid crammed onto a phone. Sticky top bar, full-width search, a prominent New
// project button, then a vertical list of project rows.

const HAIR = 'rgba(255,255,255,.06)'
const HATCH = 'repeating-linear-gradient(45deg,#141419 0,#141419 12px,#101015 12px,#101015 24px)'

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
    <div onClick={onOpen} style={css('display:flex;gap:12px;align-items:center;padding:10px;background:#101015;border:1px solid rgba(255,255,255,.07);border-radius:13px;position:relative;cursor:pointer')}>
      {/* Thumbnail */}
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

      {/* Title + sub */}
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
          <div style={css('font-size:14px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{title}</div>
        )}
        <div style={css('font-size:12px;color:#9a9aae;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{sub}</div>
        {card.kind === 'processing' && (
          <div style={css('width:100%;height:3px;border-radius:2px;background:#22222b;overflow:hidden;margin-top:7px')}>
            <div style={css(`width:${card.percent}%;height:100%;border-radius:2px;background:#7c6bff`)} />
          </div>
        )}
      </div>

      {/* Dots menu */}
      <div onClick={onDots} style={css('flex:none;color:#9a9aae;font-size:18px;line-height:1;padding:6px 8px;border-radius:8px;cursor:pointer', menuOpen && 'background:#191920')}>···</div>
      {menuOpen && (
        <div onClick={(e) => e.stopPropagation()} style={css('position:absolute;right:10px;top:calc(100% - 6px);width:170px;background:#191920;border:1px solid rgba(255,255,255,.1);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.55);padding:6px;z-index:8')}>
          <div onClick={onRename} style={css('padding:10px;font-size:14px;border-radius:8px;cursor:pointer')}>Rename</div>
          <div style={css('height:1px;background:rgba(255,255,255,.07);margin:4px 6px')} />
          <div onClick={onDelete} style={css('padding:10px;font-size:14px;border-radius:8px;color:#ff9b9b;cursor:pointer')}>Delete</div>
        </div>
      )}
    </div>
  )
}

export default function MobileDashboard(): JSX.Element {
  const dash = useProjects()
  const [menuId, setMenuId] = useState<string | null>(null)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [acct, setAcct] = useState(false)
  const [wizardOpen, setWizardOpen] = useState(false)

  return (
    <div
      className="ec-newui ec-m-dash"
      style={css('width:100%;min-height:100dvh;background:#08080a;display:flex;flex-direction:column')}
      onClick={() => { setMenuId(null); setAcct(false) }}
    >
      {/* Top bar (sticky) */}
      <div style={css(`flex:none;display:flex;align-items:center;gap:10px;height:54px;padding:0 16px;border-bottom:1px solid ${HAIR};position:sticky;top:0;background:#08080a;z-index:10`)}>
        <div style={css('width:22px;height:22px;border-radius:7px;background:#7c6bff;display:grid;place-items:center')}>
          <div style={css('width:8px;height:8px;background:#fff;border-radius:2px;transform:rotate(45deg)')} />
        </div>
        <div style={css('font-size:17px;font-weight:700;letter-spacing:-.02em;flex:1')}>Easecut</div>
        <div style={css('position:relative')} onClick={(e) => { e.stopPropagation(); setAcct((v) => !v) }}>
          <div style={css('width:34px;height:34px;border-radius:50%;background:#22222b;display:grid;place-items:center;font-size:12px;font-weight:600;color:#a99bff;cursor:pointer')}>TZ</div>
          {acct && (
            <div onClick={(e) => e.stopPropagation()} style={css('position:absolute;right:0;top:42px;width:210px;background:#101015;border:1px solid rgba(255,255,255,.09);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.5);padding:6px;z-index:20')}>
              <div style={css('padding:8px 10px 6px;font-size:12px;color:#9a9aae;border-bottom:1px solid rgba(255,255,255,.06);margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{dash.email}</div>
              <div onClick={() => void dash.logout()} style={css('padding:9px 10px;font-size:14px;border-radius:8px;color:#9a9aae;cursor:pointer')}>Log out</div>
            </div>
          )}
        </div>
      </div>

      {/* Body */}
      <div style={css('flex:1;padding:18px 16px 40px')}>
        {/* Search */}
        <div style={css('display:flex;align-items:center;gap:10px;height:44px;padding:0 13px;background:#101015;border:1px solid rgba(255,255,255,.07);border-radius:12px;margin-bottom:18px')}>
          <div style={css('width:13px;height:13px;border:1.5px solid #6e6e85;border-radius:50%;position:relative;flex:none')}>
            <div style={css('position:absolute;width:5px;height:1.5px;background:#6e6e85;bottom:-2px;right:-3px;transform:rotate(45deg)')} />
          </div>
          <input
            value={dash.query}
            onChange={(e) => dash.setQuery(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            placeholder="Search projects"
            style={css('font-size:14.5px;color:#ededf2;flex:1;background:none;border:none;outline:none;font-family:inherit;min-width:0')}
          />
        </div>

        {/* Heading */}
        <div style={css('font-size:22px;font-weight:650;letter-spacing:-.02em;margin-bottom:4px')}>Your projects</div>
        <div style={css('font-size:13px;color:#9a9aae;margin-bottom:16px')}>Saved automatically as you edit.</div>

        {/* New project + Batch */}
        <div style={css('display:flex;gap:10px;margin-bottom:22px')}>
          <button onClick={() => setWizardOpen(true)} style={css('flex:1;background:#7c6bff;border:none;color:#fff;font-family:inherit;font-size:14.5px;font-weight:600;border-radius:12px;padding:14px 0;cursor:pointer;box-shadow:0 6px 20px rgba(124,107,255,.35)')}>＋ New project</button>
          <button onClick={() => void dash.batch()} style={css('flex:none;background:none;border:1px solid rgba(255,255,255,.1);color:#c9c9da;font-family:inherit;font-size:14.5px;font-weight:500;border-radius:12px;padding:14px 20px;cursor:pointer')}>Batch</button>
        </div>

        {/* Project list — single column */}
        <div style={css('display:flex;flex-direction:column;gap:10px')}>
          {dash.metas.length === 0 && (
            <div style={css('color:#6e6e85;font-size:14px;text-align:center;padding:44px 0')}>
              {dash.loading ? 'Loading…' : dash.query ? 'No projects match your search.' : 'No projects yet — tap ＋ New project to start.'}
            </div>
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
      {wizardOpen && <NewProjectWizard onClose={() => setWizardOpen(false)} />}
    </div>
  )
}
