import { useState } from 'react'
import { css } from '../css'

// Shared folder sidebar for the Dashboard (device-local folders) and Cloud
// Cowork (space folders). Projects are dragged from the grid onto a folder to
// file them; the drag payload is the project id under `projectDragType`.

export const projectDragType = 'text/ec-project'

export interface FolderItem {
  id: string
  name: string
}

interface Props {
  folders: FolderItem[]
  /** currently open folder id, or null for "All". */
  selected: string | null
  /** counts keyed by folder id, plus `all` for the everything view. */
  counts?: { all: number; byId: Record<string, number> }
  onSelect: (folderId: string | null) => void
  onCreate: () => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  /** drop a project onto a folder (null = move it out of folders). */
  onDropProject: (folderId: string | null, projectId: string) => void
  title?: string
}

const FolderIcon = ({ open }: { open?: boolean }): JSX.Element => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
    {open ? (
      <path d="M2 5.2c0-.66.54-1.2 1.2-1.2h2.3c.4 0 .77.2 1 .53l.5.74c.23.33.6.53 1 .53H13c.66 0 1.2.54 1.2 1.2v.3l-1 4.4c-.13.55-.62.94-1.18.94H3.2c-.66 0-1.2-.54-1.2-1.2V5.2z" />
    ) : (
      <path d="M2 5c0-.66.54-1.2 1.2-1.2h2.4c.4 0 .77.2 1 .53l.5.74c.23.33.6.53 1 .53H12.8c.66 0 1.2.54 1.2 1.2v4.9c0 .66-.54 1.2-1.2 1.2H3.2c-.66 0-1.2-.54-1.2-1.2V5z" />
    )}
  </svg>
)

export default function FolderRail({
  folders,
  selected,
  counts,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onDropProject,
  title = 'Folders'
}: Props): JSX.Element {
  const [over, setOver] = useState<string | null>(null) // drag-hovered target ('all' | folderId)
  const [hover, setHover] = useState<string | null>(null) // mouse-hovered folder id (for row actions)

  const overKey = (key: string | null): string => (key === null ? 'all' : key)
  const allowDrop =
    (key: string | null) =>
    (e: React.DragEvent): void => {
      if (e.dataTransfer.types.includes(projectDragType)) {
        e.preventDefault()
        setOver(overKey(key))
      }
    }
  const doDrop =
    (key: string | null) =>
    (e: React.DragEvent): void => {
      e.preventDefault()
      setOver(null)
      const id = e.dataTransfer.getData(projectDragType)
      if (id) onDropProject(key, id)
    }

  const row = (key: string | null, label: string, count: number | undefined, folder?: FolderItem): JSX.Element => {
    const on = selected === key
    const hot = over === overKey(key)
    return (
      <div
        key={key ?? '__all'}
        onClick={() => onSelect(key)}
        onMouseEnter={() => folder && setHover(folder.id)}
        onMouseLeave={() => setHover((h) => (folder && h === folder.id ? null : h))}
        onDragOver={allowDrop(key)}
        onDragLeave={() => setOver((o) => (o === overKey(key) ? null : o))}
        onDrop={doDrop(key)}
        style={css(
          'display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:9px;cursor:pointer;font-size:13px;transition:background .12s',
          on ? 'background:rgba(124,107,255,.16);color:#EDEDF2' : 'color:#B7B7C6',
          hot ? 'outline:2px dashed rgba(124,107,255,.65);outline-offset:-2px;background:rgba(124,107,255,.1)' : ''
        )}
      >
        <span style={css(on ? 'color:#A99BFF' : 'color:#7A7A8C;display:flex')}>
          <FolderIcon open={on && key !== null} />
        </span>
        <span style={css('flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{label}</span>
        {folder && hover === folder.id ? (
          <span style={css('display:flex;gap:4px;flex:none')}>
            <span
              onClick={(e) => { e.stopPropagation(); onRename(folder.id, folder.name) }}
              title="Rename folder"
              style={css('color:#8B8BA0;font-size:11px;padding:1px 3px')}
            >
              ✎
            </span>
            <span
              onClick={(e) => { e.stopPropagation(); onDelete(folder.id) }}
              title="Delete folder"
              style={css('color:#8B8BA0;font-size:12px;padding:1px 3px')}
            >
              ✕
            </span>
          </span>
        ) : count != null ? (
          <span style={css("font-family:'Geist Mono',monospace;font-size:10.5px;color:#6E6E85;flex:none")}>{count}</span>
        ) : null}
      </div>
    )
  }

  return (
    <div style={css('width:190px;flex:none;display:flex;flex-direction:column;gap:2px')}>
      <div style={css('display:flex;align-items:center;gap:8px;padding:2px 10px 8px')}>
        <span style={css('font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#7A7A8C')}>{title}</span>
        <div style={css('flex:1')} />
        <span onClick={onCreate} title="New folder" style={css('cursor:pointer;color:#9A9AAE;font-size:15px;line-height:1;padding:0 3px')}>+</span>
      </div>
      {row(null, 'All projects', counts?.all)}
      {folders.map((f) => row(f.id, f.name, counts?.byId[f.id]))}
      <div
        onClick={onCreate}
        style={css('display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:9px;cursor:pointer;font-size:12.5px;color:#7A7A8C;margin-top:2px')}
      >
        <span style={css('font-size:14px;line-height:1')}>+</span>
        <span>New folder</span>
      </div>
    </div>
  )
}
