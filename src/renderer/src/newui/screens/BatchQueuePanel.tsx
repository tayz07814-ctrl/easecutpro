import { css } from '../css'
import type { BatchQueue, BatchQueueFile } from '../../store'

// The dashboard's right-hand "Batch processing" column. Each queue is a card:
//   Batch processing queue N
//   Date : …   Time : …   Files to process : …   Status : …
//   file 1 …  file 2 …   (each row opens that project)
//   [ Auto export all ]
// Data + actions come from useProjects (the store's batchQueues). Purely a view.

const PURPLE = '#6E6AE8'
const MONO = "'IBM Plex Mono',monospace"

function fmtDate(t: number): string {
  try {
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return '—'
  }
}
function fmtTime(t: number): string {
  try {
    return new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  } catch {
    return '—'
  }
}

function counts(files: BatchQueueFile[]): { done: number; err: number; active: number; total: number } {
  let done = 0
  let err = 0
  let active = 0
  for (const f of files) {
    if (f.status === 'done') done++
    else if (f.status === 'error') err++
    else active++
  }
  return { done, err, active, total: files.length }
}

/** Human status line for the whole queue. */
function statusLabel(files: BatchQueueFile[]): string {
  const c = counts(files)
  if (c.active > 0) return `Processing ${c.done}/${c.total}`
  if (c.err > 0) return c.done ? `${c.done} ready · ${c.err} failed` : `${c.err} failed`
  return 'Ready to export'
}

const DOT: Record<BatchQueueFile['status'], string> = {
  queued: '#565C68',
  processing: '#E6B450',
  done: '#5FB878',
  error: '#D9686E'
}

function FileRow({ file, onOpen }: { file: BatchQueueFile; onOpen: () => void }): JSX.Element {
  const clickable = file.status === 'done'
  return (
    <div
      onClick={clickable ? onOpen : undefined}
      title={file.error || (clickable ? 'Open project' : file.step)}
      style={css(
        'display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:8px;background:#191B20;' +
          (clickable ? 'cursor:pointer' : 'cursor:default')
      )}
    >
      <span
        style={css(
          `width:7px;height:7px;border-radius:50%;flex:none;background:${DOT[file.status]}` +
            (file.status === 'processing' ? ';box-shadow:0 0 0 3px rgba(230,180,80,.15)' : '')
        )}
      />
      <span style={css('flex:1;min-width:0;font-size:12px;color:#E9EAEE;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>
        {file.name}
      </span>
      <span style={css(`font-family:${MONO};font-size:9.5px;color:#8A90A0;flex:none`)}>
        {file.status === 'done' ? 'open' : file.status === 'error' ? 'failed' : file.step || file.status}
      </span>
    </div>
  )
}

function QueueCard({
  queue,
  exporting,
  onOpenFile,
  onAutoExport,
  onDismiss
}: {
  queue: BatchQueue
  exporting: { current: number; total: number; percent: number } | null
  onOpenFile: (projectId: string) => void
  onAutoExport: (queueId: string) => void
  onDismiss: (queueId: string) => void
}): JSX.Element {
  const c = counts(queue.files)
  const canExport = c.done > 0 && c.active === 0 && !exporting
  const meta = (k: string, v: string): JSX.Element => (
    <div style={css('display:flex;gap:6px;font-size:11px;line-height:1.7')}>
      <span style={css('color:#7E8393;width:104px;flex:none')}>{k}</span>
      <span style={css('color:#C6C9D2;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')}>{v}</span>
    </div>
  )
  return (
    <div style={css('background:#1E2026;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:13px 13px 12px')}>
      <div style={css('display:flex;align-items:flex-start;gap:8px')}>
        <div style={css('flex:1;min-width:0')}>
          <div style={css('font-size:13px;font-weight:600;color:#E9EAEE')}>{queue.label}</div>
        </div>
        <span
          onClick={() => onDismiss(queue.id)}
          title="Remove from list (keeps the projects)"
          style={css('color:#7E8393;font-size:13px;cursor:pointer;padding:1px 5px;border-radius:6px;margin:-2px -4px 0 0;flex:none')}
        >
          ✕
        </span>
      </div>
      <div style={css('margin-top:8px')}>
        {meta('Date', fmtDate(queue.createdAt))}
        {meta('Time', fmtTime(queue.createdAt))}
        {meta('Files to process', String(c.total))}
        {meta('Status', statusLabel(queue.files))}
      </div>
      {c.active > 0 && (
        <div style={css('height:3px;border-radius:2px;background:#2A2D36;overflow:hidden;margin-top:10px')}>
          <div style={css(`width:${Math.round((c.done / Math.max(1, c.total)) * 100)}%;height:100%;background:${PURPLE}`)} />
        </div>
      )}
      <div style={css('display:flex;flex-direction:column;gap:5px;margin-top:11px')}>
        {queue.files.map((f, i) => (
          // key by index: projectId is empty until a file finishes (deferred create),
          // and file order within a queue is stable.
          <FileRow key={i} file={f} onOpen={() => onOpenFile(f.projectId)} />
        ))}
      </div>
      {exporting && (
        <div style={css('margin-top:11px')}>
          <div style={css('display:flex;align-items:center;justify-content:space-between;font-size:11px;color:#9BA0AC;margin-bottom:5px')}>
            <span>Exporting {exporting.current}/{exporting.total}…</span>
            <span style={css(`font-family:${MONO};color:#B7B5F4`)}>{exporting.percent}%</span>
          </div>
          <div style={css('height:4px;border-radius:2px;background:#2A2D36;overflow:hidden')}>
            <div style={css(`width:${Math.max(3, exporting.percent)}%;height:100%;background:${PURPLE};transition:width .2s`)} />
          </div>
          <div style={css('font-size:10px;color:#686E7B;margin-top:5px')}>Files download to this device as each one finishes.</div>
        </div>
      )}
      <button
        onClick={() => canExport && onAutoExport(queue.id)}
        disabled={!canExport}
        style={css(
          'width:100%;margin-top:12px;border:none;font-family:inherit;font-size:12px;font-weight:600;border-radius:9px;padding:9px 0;' +
            (canExport
              ? `background:${PURPLE};color:#fff;cursor:pointer;box-shadow:0 5px 16px rgba(110,106,232,.3)`
              : 'background:#26272e;color:#666b78;cursor:not-allowed')
        )}
      >
        {exporting ? 'Exporting…' : c.active > 0 ? 'Processing…' : 'Auto export all'}
      </button>
    </div>
  )
}

export default function BatchQueuePanel({
  queues,
  batchExport,
  onOpenFile,
  onAutoExport,
  onDismiss
}: {
  queues: BatchQueue[]
  batchExport: { queueId: string; current: number; total: number; percent: number } | null
  onOpenFile: (projectId: string) => void
  onAutoExport: (queueId: string) => void
  onDismiss: (queueId: string) => void
}): JSX.Element | null {
  if (!queues.length) return null
  return (
    <div
      className="ec-newui"
      style={css(
        'width:300px;flex:none;height:100%;overflow-y:auto;border-left:1px solid rgba(255,255,255,.06);background:#141519;padding:20px 16px'
      )}
    >
      <div style={css('font-size:14px;font-weight:650;letter-spacing:-.01em;margin-bottom:4px')}>Batch processing</div>
      <div style={css('font-size:11.5px;color:#9BA0AC;margin-bottom:16px;line-height:1.5')}>
        Cleaned in the background — open one to review, or export the whole batch.
      </div>
      <div style={css('display:flex;flex-direction:column;gap:14px')}>
        {queues.map((q) => (
          <QueueCard
            key={q.id}
            queue={q}
            exporting={batchExport && batchExport.queueId === q.id ? batchExport : null}
            onOpenFile={onOpenFile}
            onAutoExport={onAutoExport}
            onDismiss={onDismiss}
          />
        ))}
      </div>
    </div>
  )
}
