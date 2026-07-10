import { useState } from 'react'
import { useStore } from '../store'
import { mediaSrc, IS_CLOUD } from '../platform'
import { insertLibraryItemAtPlayhead } from '../timelineInsert'
import type { LibraryItem } from '@shared/types'

function fmtDur(s: number): string {
  if (!s || s < 0) return ''
  const m = Math.floor(s / 60)
  const sec = Math.round(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

const KIND_ICON: Record<LibraryItem['kind'], string> = {
  video: '🎬',
  audio: '♪',
  image: '🖼'
}

export default function MediaLibrary(): JSX.Element {
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

  const hasVideos = library.some((it) => it.kind === 'video')
  const seq = sequence ?? []
  // grid ⇄ list layout for the media items (persisted per user)
  const [view, setViewState] = useState<'list' | 'grid'>(
    () => (localStorage.getItem('ec.mediaView') === 'grid' ? 'grid' : 'list')
  )
  function setView(v: 'list' | 'grid'): void {
    localStorage.setItem('ec.mediaView', v)
    setViewState(v)
  }

  return (
    <div className="media-lib">
      <div className="media-lib-head">
        <h3>Media library</h3>
        <div className="row">
          <button className="primary" onClick={addToLibrary} disabled={busy}>
            ＋ Import
          </button>
          <button onClick={importFolderToLibrary} disabled={busy} title="Import every video/image in a folder at once">
            📁 Import folder
          </button>
          <button onClick={load} title="Open a saved project">
            Open project…
          </button>
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <button onClick={addAllToSequence} disabled={busy || !hasVideos} title="Add every video to the montage sequence, in order (clip 1, 2, 3…)">
            ▦ Add all → sequence
          </button>
          <span className="spacer" />
          <span className="view-toggle" title="Media library layout">
            <button className={'mini' + (view === 'list' ? ' on toggle' : '')} onClick={() => setView('list')} title="List view">☰</button>
            <button className={'mini' + (view === 'grid' ? ' on toggle' : '')} onClick={() => setView('grid')} title="Grid view">▦</button>
          </span>
        </div>
        <div className="hint muted small">
          Import once, reuse many. <b>Use as base</b> for a single video, <b>+ Seq</b> to build a
          multi-clip montage, or <b>Add to track</b> for an overlay.
        </div>
      </div>

      <div className={view === 'grid' ? 'media-lib-list grid' : 'media-lib-list'}>
        {library.length === 0 ? (
          <div className="media-lib-empty muted">
            <p>No media yet.</p>
            <p className="small">
              Click <b>Import</b> or <b>Import folder</b> to add videos, audio, or images. Items stay
              here for reuse across projects.
            </p>
          </div>
        ) : (
          library.map((it) => (
            <MediaCard
              key={it.id}
              item={it}
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
        <div className="seq-strip" style={{ borderTop: '1px solid var(--border)', padding: 10, maxHeight: '38%', overflow: 'auto' }}>
          <div className="row" style={{ alignItems: 'center', marginBottom: 4 }}>
            <b style={{ fontSize: 12 }}>Base timeline · {seq.length} clip{seq.length > 1 ? 's' : ''}</b>
            <span className="spacer" style={{ flex: 1 }} />
            <button onClick={clearSequence} title="Remove all clips">Clear</button>
          </div>
          <div className="row" style={{ marginBottom: 5 }}>
            {!IS_CLOUD && (
              // Flatten needs the desktop/self-host encoder; in cloud you edit the
              // montage directly (Cut Lord + export are already montage-native).
              <button onClick={combineSequence} disabled={busy} title="Optional: flatten the clips into ONE video (you don't need this — edit directly on the timeline)">
                🔗 Flatten to one video
              </button>
            )}
            <button onClick={() => setShowExportModal(true)} disabled={busy} title="Export the clips concatenated">
              ⬇ Export
            </button>
          </div>
          <div className="hint muted small" style={{ marginBottom: 4 }}>
            These clips are your base — edit them right on the timeline below. <b>Transcribe</b> &amp;
            <b> Remove silence</b> run across all clips; <b>double-click a clip</b> to Fast Cut / clean it.
            Flatten is optional.
          </div>
          {seq.map((c, i) => {
            const dur = c.sourceDuration || c.sourceOut
            return (
              <div key={c.id} style={{ padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '22px 44px 1fr auto', gap: 8, alignItems: 'center' }}>
                  <span className="muted" style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{i + 1}</span>
                  <div style={{ width: 44, height: 28, borderRadius: 4, overflow: 'hidden', background: '#0c0e13', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {c.srcW ? <img src={mediaSrc(c.sourcePath)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} draggable={false} /> : <span>🎬</span>}
                  </div>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }} title={c.name}>
                    {c.name} <span className="muted">{fmtDur(c.sourceOut - c.sourceIn)}</span>
                  </span>
                  <span style={{ display: 'flex', gap: 2 }}>
                    <button className="mini" onClick={() => reorderSequence(i, i - 1)} disabled={i === 0} title="Move up">▲</button>
                    <button className="mini" onClick={() => reorderSequence(i, i + 1)} disabled={i === seq.length - 1} title="Move down">▼</button>
                    <button className="mini" onClick={() => removeSequenceClip(c.id)} title="Remove">✕</button>
                  </span>
                </div>
                <div className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 3, paddingLeft: 30, fontSize: 11 }}>
                  <span>In</span>
                  <input type="number" min={0} max={dur} step={0.1} value={Number(c.sourceIn.toFixed(1))}
                    onChange={(e) => trimSequenceClip(c.id, Number(e.target.value), c.sourceOut)} style={{ width: 58 }} />
                  <span>Out</span>
                  <input type="number" min={0} max={dur} step={0.1} value={Number(c.sourceOut.toFixed(1))}
                    onChange={(e) => trimSequenceClip(c.id, c.sourceIn, Number(e.target.value))} style={{ width: 58 }} />
                  <span>s · clip {fmtDur(dur)}</span>
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
  active,
  onBase,
  onMain,
  onOverlay,
  onSeq,
  onRemove
}: {
  item: LibraryItem
  active: boolean
  onBase: () => void
  onMain: () => void
  onOverlay: () => void
  onSeq: () => void
  onRemove: () => void
}): JSX.Element {
  return (
    <div
      className={'media-card' + (active ? ' active' : '')}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-ec-media', item.id)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      title="Drag onto the timeline (main, overlay or audio lane)"
    >
      <div className="media-thumb">
        {item.thumb ? (
          <img src={item.thumb} alt="" draggable={false} />
        ) : (
          <span className="media-thumb-icon">{KIND_ICON[item.kind]}</span>
        )}
        <span className="media-kind">{item.kind}</span>
        {item.duration > 0 && <span className="media-dur">{fmtDur(item.duration)}</span>}
        {active && <span className="media-active-badge">base</span>}
      </div>
      <div className="media-info">
        <div className="media-name" title={item.path}>
          {item.name}
        </div>
        <div className="media-actions">
          {item.kind !== 'image' && (
            <button className="mini" onClick={onBase} title="Load as the base (A-roll) track">
              Use as base
            </button>
          )}
          {item.kind !== 'audio' && (
            <button className="mini" onClick={onMain} title="Insert into the MAIN track at the playhead (images become 4s clips)">
              + Main
            </button>
          )}
          {item.kind === 'video' && (
            <button className="mini" onClick={onSeq} title="Add to the montage sequence">
              + Seq
            </button>
          )}
          {item.kind !== 'audio' && (
            <button className="mini" onClick={onOverlay} title="Add to an overlay track at the playhead">
              Add to track
            </button>
          )}
          <button className="mini" onClick={onRemove} title="Remove from library">
            ✕
          </button>
        </div>
      </div>
    </div>
  )
}
