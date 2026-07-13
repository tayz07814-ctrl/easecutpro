import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { mediaSrc, IS_CLOUD } from '../platform'
import { insertLibraryItemAtPlayhead } from '../timelineInsert'
import type { LibraryItem } from '@shared/types'

/**
 * Redesigned Media library (VITE_NEW_EASECUT_UI only). Presentation only — it
 * reuses every existing store handler (import, folder import, base/overlay/seq,
 * remove, sequence editing) and preserves drag/drop + base-clip behavior. No
 * media state is duplicated and no mock data is created. Secondary per-item
 * actions move into a ⋯ menu; the panel can collapse to a rail.
 */
function fmtDur(s: number): string {
  if (!s || s < 0) return ''
  const m = Math.floor(s / 60)
  const sec = Math.round(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}
const KIND_ICON: Record<LibraryItem['kind'], string> = { video: '🎬', audio: '♪', image: '🖼' }

export default function NewMediaLibrary(): JSX.Element {
  const library = useStore((s) => s.library)
  const addToLibrary = useStore((s) => s.addToLibrary)
  const importFolderToLibrary = useStore((s) => s.importFolderToLibrary)
  const removeFromLibrary = useStore((s) => s.removeFromLibrary)
  const setBaseFromLibrary = useStore((s) => s.setBaseFromLibrary)
  const addLibraryToOverlay = useStore((s) => s.addLibraryToOverlay)
  const addToSequence = useStore((s) => s.addToSequence)
  const addAllToSequence = useStore((s) => s.addAllToSequence)
  const reorderSequence = useStore((s) => s.reorderSequence)
  const removeSequenceClip = useStore((s) => s.removeSequenceClip)
  const trimSequenceClip = useStore((s) => s.trimSequenceClip)
  const combineSequence = useStore((s) => s.combineSequence)
  const clearSequence = useStore((s) => s.clearSequence)
  const setShowExportModal = useStore((s) => s.setShowExportModal)
  const sequence = useStore((s) => s.project.baseSequence)
  const load = useStore((s) => s.load)
  const currentPath = useStore((s) => s.project.media?.path)
  const busy = useStore((s) => s.job.active)
  const collapsed = useStore((s) => s.mediaCollapsed)
  const setCollapsed = useStore((s) => s.setMediaCollapsed)

  const hasVideos = library.some((it) => it.kind === 'video')
  const seq = sequence ?? []
  const [view, setViewState] = useState<'list' | 'grid'>(() => (localStorage.getItem('ec.mediaView') === 'grid' ? 'grid' : 'list'))
  const setView = (v: 'list' | 'grid'): void => {
    localStorage.setItem('ec.mediaView', v)
    setViewState(v)
  }
  const [headMenu, setHeadMenu] = useState(false)
  const headWrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!headMenu) return
    const onDown = (e: MouseEvent): void => {
      if (headWrap.current && !headWrap.current.contains(e.target as Node)) setHeadMenu(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [headMenu])

  // Collapsed rail — expand + quick import; nothing else needed.
  if (collapsed) {
    return (
      <div className="nml nml-rail">
        <button className="nml-icon" onClick={() => setCollapsed(false)} title="Expand media panel">⟩</button>
        <button className="nml-icon" onClick={addToLibrary} disabled={busy} title="Import media">＋</button>
      </div>
    )
  }

  return (
    <div className="nml">
      <div className="nml-head">
        <div className="nml-head-top">
          <span className="nml-title">Media</span>
          <span className="nml-spacer" />
          <button className="nml-icon" onClick={() => setCollapsed(true)} title="Collapse panel">⟨</button>
        </div>
        <button className="nml-import primary" onClick={addToLibrary} disabled={busy}>＋ Import media</button>
        <div className="nml-head-row">
          <span className="nml-view">
            <button className={'nml-view-btn' + (view === 'list' ? ' on' : '')} onClick={() => setView('list')} title="List view">☰</button>
            <button className={'nml-view-btn' + (view === 'grid' ? ' on' : '')} onClick={() => setView('grid')} title="Grid view">▦</button>
          </span>
          <span className="nml-spacer" />
          <div className="nml-menu-wrap" ref={headWrap}>
            <button className="nml-icon" onClick={() => setHeadMenu((v) => !v)} title="More">⋯</button>
            {headMenu && (
              <div className="nml-menu" role="menu">
                <button className="nml-mi" onClick={() => { importFolderToLibrary(); setHeadMenu(false) }} disabled={busy}>Import a folder…</button>
                <button className="nml-mi" onClick={() => { load(); setHeadMenu(false) }}>Open project…</button>
                <button className="nml-mi" onClick={() => { addAllToSequence(); setHeadMenu(false) }} disabled={busy || !hasVideos}>Add all to sequence</button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className={'nml-list' + (view === 'grid' ? ' grid' : '')}>
        {library.length === 0 ? (
          <div className="nml-empty">
            <div className="nml-empty-icon">🎬</div>
            <div className="nml-empty-title">No media yet</div>
            <div className="nml-empty-sub">Import a video to start — it stays here to reuse across projects.</div>
            <button className="nml-import primary" onClick={addToLibrary} disabled={busy}>＋ Import media</button>
          </div>
        ) : (
          library.map((it) => (
            <MediaCard
              key={it.id}
              item={it}
              grid={view === 'grid'}
              active={it.path === currentPath}
              onBase={() => setBaseFromLibrary(it.id)}
              onMain={() => insertLibraryItemAtPlayhead(it, 'main')}
              onOverlay={() => addLibraryToOverlay(it.id, 1)}
              onSeq={() => addToSequence(it.id)}
              onRemove={() => removeFromLibrary(it.id)}
            />
          ))
        )}
      </div>

      {seq.length > 0 && (
        <div className="nml-seq">
          <div className="nml-seq-head">
            <b>Base timeline · {seq.length} clip{seq.length > 1 ? 's' : ''}</b>
            <span className="nml-spacer" />
            <button className="nml-link" onClick={clearSequence}>Clear</button>
          </div>
          <div className="nml-seq-actions">
            {!IS_CLOUD && (
              <button onClick={combineSequence} disabled={busy} title="Optional: flatten the clips into one video">🔗 Flatten</button>
            )}
            <button onClick={() => setShowExportModal(true)} disabled={busy}>Export</button>
          </div>
          {seq.map((c, i) => {
            const dur = c.sourceDuration || c.sourceOut
            return (
              <div className="nml-seq-clip" key={c.id}>
                <div className="nml-seq-row">
                  <span className="nml-seq-n">{i + 1}</span>
                  <div className="nml-seq-thumb">
                    {c.srcW ? <img src={mediaSrc(c.sourcePath)} alt="" draggable={false} /> : <span>🎬</span>}
                  </div>
                  <span className="nml-seq-name" title={c.name}>
                    {c.name} <span className="nml-muted">{fmtDur(c.sourceOut - c.sourceIn)}</span>
                  </span>
                  <span className="nml-seq-btns">
                    <button className="nml-icon sm" onClick={() => reorderSequence(i, i - 1)} disabled={i === 0} title="Move up">▲</button>
                    <button className="nml-icon sm" onClick={() => reorderSequence(i, i + 1)} disabled={i === seq.length - 1} title="Move down">▼</button>
                    <button className="nml-icon sm" onClick={() => removeSequenceClip(c.id)} title="Remove">✕</button>
                  </span>
                </div>
                <div className="nml-seq-trim">
                  <span>In</span>
                  <input type="number" min={0} max={dur} step={0.1} value={Number(c.sourceIn.toFixed(1))} onChange={(e) => trimSequenceClip(c.id, Number(e.target.value), c.sourceOut)} />
                  <span>Out</span>
                  <input type="number" min={0} max={dur} step={0.1} value={Number(c.sourceOut.toFixed(1))} onChange={(e) => trimSequenceClip(c.id, c.sourceIn, Number(e.target.value))} />
                  <span className="nml-muted">clip {fmtDur(dur)}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function MediaCard({
  item,
  grid,
  active,
  onBase,
  onMain,
  onOverlay,
  onSeq,
  onRemove
}: {
  item: LibraryItem
  grid: boolean
  active: boolean
  onBase: () => void
  onMain: () => void
  onOverlay: () => void
  onSeq: () => void
  onRemove: () => void
}): JSX.Element {
  const [menu, setMenu] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent): void => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setMenu(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [menu])
  const act = (fn: () => void): void => {
    fn()
    setMenu(false)
  }
  // Thumbnail states: real image when ready; otherwise a neutral preview
  // placeholder (a video still is generated async, audio never has one). There is
  // no per-item "failed" flag on LibraryItem, so a failed preview shows the same
  // placeholder rather than a faked error state.
  const thumb = item.thumb ? (
    <img src={item.thumb} alt="" draggable={false} />
  ) : (
    <span className={'nml-thumb-ph' + (item.kind === 'video' ? ' pending' : '')}>{KIND_ICON[item.kind]}</span>
  )

  return (
    <div
      className={'nml-card' + (grid ? ' grid' : '') + (active ? ' active' : '')}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-ec-media', item.id)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      title="Drag onto the timeline (main, overlay or audio lane)"
    >
      <div className="nml-thumb">
        {thumb}
        {item.duration > 0 && <span className="nml-dur">{fmtDur(item.duration)}</span>}
        {active && <span className="nml-base">Base</span>}
      </div>
      <div className="nml-info">
        <div className="nml-name" title={item.name}>{item.name}</div>
        <div className="nml-meta">{item.kind}</div>
      </div>
      <div className="nml-card-menu" ref={wrap}>
        <button className="nml-icon sm" onClick={() => setMenu((v) => !v)} title="Actions">⋯</button>
        {menu && (
          <div className="nml-menu" role="menu">
            {item.kind !== 'image' && <button className="nml-mi" onClick={() => act(onBase)}>Use as base clip</button>}
            {item.kind !== 'audio' && <button className="nml-mi" onClick={() => act(onMain)}>Add to main track</button>}
            {item.kind === 'video' && <button className="nml-mi" onClick={() => act(onSeq)}>Add to sequence</button>}
            {item.kind !== 'audio' && <button className="nml-mi" onClick={() => act(onOverlay)}>Add to overlay track</button>}
            <div className="nml-mi-sep" />
            <button className="nml-mi danger" onClick={() => act(onRemove)}>Remove from library</button>
          </div>
        )}
      </div>
    </div>
  )
}
