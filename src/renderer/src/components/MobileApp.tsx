import { useEffect, useState, type ReactNode } from 'react'
import { useStore } from '../store'
import { useSmoothProgress } from '../useSmoothProgress'
import { editedDuration } from '@shared/edit'
import ProjectTitle from './ProjectTitle'
import VideoPreview from './VideoPreview'
import TimelinePanel from './timeline/TimelinePanel'
import MediaLibrary from './MediaLibrary'
import TranscriptPanel from './TranscriptPanel'
import TextPanel from './TextPanel'
import OstPanel from './OstPanel'
import SilencePanel from './SilencePanel'
import BasicPanel from './BasicPanel'
import SettingsModal from './SettingsModal'

type Sheet = 'media' | 'music' | 'text' | 'silence' | 'transcript' | 'adjust' | 'export' | null

/** Phone layout — CapCut-style: preview, timeline, a scrollable action dock that
 *  swaps to a contextual toolbar when a clip/text is selected, and bottom sheets. */
export default function MobileApp(): JSX.Element {
  const s = useStore()
  const project = s.project
  const hasMedia = !!project.media
  // A montage base has no `media`; gate actions on hasBase so transcribe/tools work.
  const hasBase = hasMedia || ((project.baseSequence?.length ?? 0) > 0)
  const [sheet, setSheet] = useState<Sheet>(null)
  const [pendingTranscript, setPendingTranscript] = useState(false)

  const selClip = s.selectedClipId
  const selSeg = s.selectedSeg
  const selText = s.selectedTextId
  const selSeqClip = s.selectedSeqClipId
  const hasSelection = !!(selClip || selSeg || selText || selSeqClip)
  // Delete acts on the selected base segment (kept or already-cut). "Delete all"
  // appears whenever there is removed footage (greyed cuts) to ripple away.
  const delSeg = selSeg
  const hasCuts = !!project.media && editedDuration(project) < project.media.duration - 0.1

  // When a transcription that we kicked off finishes, pop open the panel.
  useEffect(() => {
    if (pendingTranscript && project.transcript && !s.job.active) {
      setSheet('transcript')
      setPendingTranscript(false)
    }
  }, [pendingTranscript, project.transcript, s.job.active])

  function clearSelection(): void {
    s.selectClip(null)
    s.selectSeg(null)
    s.selectText(null)
    s.selectSeqClip(null)
  }

  function onScript(): void {
    if (project.transcript) {
      setSheet('transcript')
      return
    }
    if (!hasBase || s.job.active) return
    s.transcribe()
    setPendingTranscript(true)
  }

  return (
    <div className="m-app">
      {/* Top bar */}
      <header className="m-top">
        <button className="m-top-btn" onClick={() => s.goHome()} title="Projects">‹</button>
        <button className="m-top-btn" onClick={() => s.setShowSettings(true)} title="Settings">⚙</button>
        <ProjectTitle compact />
        <button className="m-res" onClick={() => setSheet('export')}>
          {project.aspectW && project.aspectH ? `${project.aspectW}:${project.aspectH}` : 'Source'} ▾
        </button>
        <button
          className="m-export"
          onClick={() => setSheet('export')}
          disabled={!hasBase || s.job.active}
        >
          Export
        </button>
      </header>

      {/* Preview (its built-in transport is hidden on mobile via CSS) */}
      <div className="m-stage">
        <VideoPreview />
      </div>

      {/* Compact transport: zoom + magnet (left) · play (centre) · undo/redo +
          delete (right). Magnet and Undo/Redo now sit on OPPOSITE sides so they
          can never overlap, and Play is alone in the centre cell = truly centred. */}
      <div className="m-transport">
        <div className="m-zoom">
          <button className="m-zoom-b" onClick={() => s.setZoom(project.pxPerSec - 20)} disabled={!hasBase}>−</button>
          <input
            className="m-zoom-slider"
            type="range" min={10} max={400} step={5}
            value={project.pxPerSec}
            onChange={(e) => s.setZoom(Number(e.target.value))}
            disabled={!hasBase}
            title="Zoom timeline"
          />
          <button className="m-zoom-b" onClick={() => s.setZoom(project.pxPerSec + 20)} disabled={!hasBase}>+</button>
          <button
            className={'m-zoom-b m-magnet' + (project.magnet ? ' on' : '')}
            onClick={s.toggleMagnet}
            title={`Magnet ${project.magnet ? 'on' : 'off'}`}
          >
            🧲
          </button>
          <button className="m-zoom-b" onClick={() => s.setPlayhead(0)} disabled={!hasBase} title="Jump to start">⏮</button>
        </div>

        <div className="m-transport-mid">
          <button
            className="m-tp m-play"
            onClick={() => hasBase && s.setPlaying(!s.playing)}
            disabled={!hasBase}
          >
            {s.playing ? '❚❚' : '▶'}
          </button>
        </div>

        <div className="m-del-group">
          <button className="m-tp" onClick={s.undo} disabled={!s.canUndo} title="Undo">↶</button>
          <button className="m-tp" onClick={s.redo} disabled={!s.canRedo} title="Redo">↷</button>
          {delSeg ? (
            <button
              className="m-del"
              onClick={() => {
                s.deleteBaseRange(delSeg.start, delSeg.end, true)
                s.selectSeg(null)
              }}
              title="Delete this clip"
            >
              🗑
            </button>
          ) : (
            hasCuts && (
              <button className="m-del all" onClick={() => s.deleteAllCuts()} title="Delete every greyed cut at once">🗑</button>
            )
          )}
        </div>
      </div>

      {/* Timeline */}
      <div className="m-tl">
        <TimelinePanel mobile />
      </div>

      {/* Bottom dock: contextual toolbar when something is selected, else main actions */}
      <div className="m-dock">
        {hasSelection ? (
          <ContextBar
            kind={selClip ? 'clip' : selText ? 'text' : selSeqClip ? 'seg' : selSeg?.kind === 'cut' ? 'cut' : 'seg'}
            onSplit={() => s.hotkeySplit()}
            onDelete={() => {
              s.hotkeyDelete()
              clearSelection()
            }}
            onRestore={() => {
              s.hotkeyUndelete()
              clearSelection()
            }}
            onAdjust={() => setSheet('adjust')}
            onEditText={() => setSheet('text')}
            onClose={clearSelection}
          />
        ) : (
          <MainBar
            onMedia={() => setSheet('media')}
            onScript={onScript}
            onMusic={() => setSheet('music')}
            onText={() => {
              s.addText()
              setSheet('text')
            }}
            onSilence={() => setSheet('silence')}
            hasMedia={hasBase}
          />
        )}
      </div>

      {/* Sheets */}
      {sheet === 'media' && (
        <MobileSheet title="Media" onClose={() => setSheet(null)}>
          <MediaLibrary />
        </MobileSheet>
      )}
      {sheet === 'music' && (
        <MobileSheet title="Music" onClose={() => setSheet(null)}>
          <OstPanel />
        </MobileSheet>
      )}
      {sheet === 'text' && (
        <MobileSheet title="Text" onClose={() => setSheet(null)}>
          <TextPanel />
        </MobileSheet>
      )}
      {sheet === 'silence' && (
        <MobileSheet title="Silence" onClose={() => setSheet(null)}>
          <SilencePanel />
        </MobileSheet>
      )}
      {sheet === 'adjust' && (
        <MobileSheet title="Adjust" onClose={() => setSheet(null)}>
          <BasicPanel />
        </MobileSheet>
      )}
      {sheet === 'transcript' && (
        <MobileSheet title="Transcript" onClose={() => setSheet(null)} tall>
          <TranscriptPanel />
        </MobileSheet>
      )}
      {sheet === 'export' && <MobileExport onClose={() => setSheet(null)} />}

      {/* Centered progress widget for long jobs (transcribe / silence / export) */}
      <ProgressWidget />

      {s.showSettings && <SettingsModal />}
    </div>
  )
}

// ---- Main action dock (horizontally scrollable) ----
function MainBar({
  onMedia,
  onScript,
  onMusic,
  onText,
  onSilence,
  hasMedia
}: {
  onMedia: () => void
  onScript: () => void
  onMusic: () => void
  onText: () => void
  onSilence: () => void
  hasMedia: boolean
}): JSX.Element {
  return (
    <div className="m-dock-scroll">
      <Tool icon="🎬" label="Media" onClick={onMedia} />
      <Tool icon={<ScribeCutIcon />} label="ScribeCut" onClick={onScript} disabled={!hasMedia} accent />
      <Tool icon="🎵" label="Music" onClick={onMusic} disabled={!hasMedia} />
      <Tool icon="🅣" label="Text" onClick={onText} disabled={!hasMedia} />
      <Tool icon="🔇" label="Silence" onClick={onSilence} disabled={!hasMedia} />
    </div>
  )
}

// ---- Contextual toolbar for a selected clip / text / segment ----
function ContextBar({
  kind,
  onSplit,
  onDelete,
  onRestore,
  onAdjust,
  onEditText,
  onClose
}: {
  kind: 'clip' | 'text' | 'seg' | 'cut'
  onSplit: () => void
  onDelete: () => void
  onRestore: () => void
  onAdjust: () => void
  onEditText: () => void
  onClose: () => void
}): JSX.Element {
  return (
    <div className="m-ctx">
      <button className="m-ctx-close" onClick={onClose} title="Done">⌄</button>
      <div className="m-dock-scroll">
        {kind === 'cut' ? (
          <>
            <Tool icon="↩" label="Restore" onClick={onRestore} />
            <Tool icon="✂" label="Split" onClick={onSplit} />
          </>
        ) : kind === 'text' ? (
          <>
            <Tool icon="✎" label="Edit" onClick={onEditText} />
            <Tool icon="✂" label="Split" onClick={onSplit} />
            <Tool icon="🗑" label="Delete" onClick={onDelete} danger />
          </>
        ) : (
          <>
            <Tool icon="✂" label="Split" onClick={onSplit} />
            <Tool icon="🔍" label="Zoom" onClick={onAdjust} />
            {kind === 'clip' && <Tool icon="⤢" label="Scale" onClick={onAdjust} />}
            {kind === 'clip' && <Tool icon="⛶" label="Crop" onClick={onAdjust} />}
            <Tool icon="🗑" label="Delete" onClick={onDelete} danger />
          </>
        )}
      </div>
    </div>
  )
}

/** Scissors-cutting-text glyph for the ScribeCut action (transcript editing). */
function ScribeCutIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 5.5h15M4 9h9" />
      <circle cx="6" cy="15.6" r="1.8" />
      <circle cx="6" cy="19.2" r="1.8" />
      <path d="M7.6 14.7 19 20M7.6 20.1 19 14.6" />
    </svg>
  )
}

function Tool({
  icon,
  label,
  onClick,
  disabled,
  danger,
  accent
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  accent?: boolean
}): JSX.Element {
  return (
    <button
      className={'m-tool' + (danger ? ' danger' : '') + (accent ? ' accent' : '')}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="m-tool-ic">{icon}</span>
      <span className="m-tool-lb">{label}</span>
    </button>
  )
}

// ---- Bottom sheet ----
function MobileSheet({
  title,
  onClose,
  children,
  tall
}: {
  title: string
  onClose: () => void
  children: ReactNode
  tall?: boolean
}): JSX.Element {
  return (
    <div className="m-sheet-backdrop" onPointerDown={onClose}>
      <div
        className={'m-sheet' + (tall ? ' tall' : '')}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="m-sheet-grab" />
        <div className="m-sheet-head">
          <span>{title}</span>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="m-sheet-body">{children}</div>
      </div>
    </div>
  )
}

// ---- Centered progress widget for long-running jobs ----
function ProgressWidget(): JSX.Element | null {
  const job = useStore((s) => s.job)
  const shown = useSmoothProgress(job.active, job.percent)
  if (!job.active || (job.kind !== 'transcribe' && job.kind !== 'export' && job.kind !== 'silence'))
    return null
  // Cut Lord persona labels; explicit server upload wording ONLY for export.
  const label =
    job.kind === 'export'
      ? /upload/i.test(job.message ?? '')
        ? 'Uploading to server'
        : 'Cut Lord is compiling'
      : job.kind === 'silence'
        ? 'Cut Lord is listening'
        : 'Cut Lord is working'
  const pct = Math.max(0, Math.min(100, Math.round(shown)))
  return (
    <div className="m-prog">
      <div className="m-prog-card">
        <div className="m-prog-spark">✦</div>
        <div className="m-prog-bar">
          <div className="m-prog-fill smooth" style={{ width: `${pct}%` }} />
        </div>
        <div className="m-prog-title">{label} {pct}%…</div>
        <div className="m-prog-sub muted small">{job.message || 'Cut Lord is working — longer videos take more time.'}</div>
      </div>
    </div>
  )
}

// ---- Export sheet with sliders (resolution / bitrate / aspect) ----
const RES = [
  { label: '480p', h: 480 },
  { label: '720p', h: 720 },
  { label: '1080p', h: 1080 },
  { label: '2K', h: 1440 },
  { label: '4K', h: 2160 }
]
const ASPECTS: { label: string; r: [number, number] | null }[] = [
  { label: 'Source', r: null },
  { label: '9:16', r: [9, 16] },
  { label: '16:9', r: [16, 9] },
  { label: '1:1', r: [1, 1] },
  { label: '4:5', r: [4, 5] }
]

function MobileExport({ onClose }: { onClose: () => void }): JSX.Element {
  const media = useStore((s) => s.project.media)
  const exportVideo = useStore((s) => s.exportVideo)
  const setAspect = useStore((s) => s.setAspect)
  const aspectW = useStore((s) => s.project.aspectW)
  const aspectH = useStore((s) => s.project.aspectH)
  const job = useStore((s) => s.job)

  const [resIdx, setResIdx] = useState(1) // 720p
  const [brIdx, setBrIdx] = useState(2) // High (Low/Med/High)

  const srcW = media?.width || 1080
  const srcH = media?.height || 1920
  const srcAspect = srcW / srcH
  const ratio: [number, number] | null = aspectW && aspectH ? [aspectW, aspectH] : null
  const aspect = ratio ? ratio[0] / ratio[1] : srcAspect

  // Output dimensions: the chosen resolution is the SHORT edge for portrait.
  const targetH = RES[resIdx].h
  const isPortrait = aspect < 1
  const longEdge = targetH
  const w = isPortrait ? Math.round(longEdge * aspect) : longEdge
  const h = isPortrait ? longEdge : Math.round(longEdge / aspect)
  const W = Math.round(w / 2) * 2
  const H = Math.round(h / 2) * 2

  const bitrate = [4, 10, 20][brIdx]
  const estMb = Math.round((bitrate * 60) / 8)

  return (
    <div className="m-sheet-backdrop" onPointerDown={onClose}>
      <div className="m-sheet" onPointerDown={(e) => e.stopPropagation()}>
        <div className="m-sheet-grab" />
        <div className="m-sheet-head">
          <span>Export settings</span>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="m-sheet-body">
          <div className="m-exp-grp">
            <div className="m-exp-row">
              <span>Resolution</span>
              <span className="muted small">{RES[resIdx].label} · {W}×{H}</span>
            </div>
            <input
              type="range"
              min={0}
              max={RES.length - 1}
              step={1}
              value={resIdx}
              onChange={(e) => setResIdx(Number(e.target.value))}
            />
            <div className="m-exp-ticks">
              {RES.map((r) => <span key={r.label}>{r.label}</span>)}
            </div>
          </div>

          <div className="m-exp-grp">
            <div className="m-exp-row">
              <span>Aspect ratio</span>
            </div>
            <div className="m-exp-chips">
              {ASPECTS.map((a) => {
                const on = a.r ? a.r[0] === aspectW && a.r[1] === aspectH : !aspectW
                return (
                  <button
                    key={a.label}
                    className={'m-chip' + (on ? ' on' : '')}
                    onClick={() => setAspect(a.r ? a.r[0] : 0, a.r ? a.r[1] : 0)}
                  >
                    {a.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="m-exp-grp">
            <div className="m-exp-row">
              <span>Quality</span>
              <span className="muted small">{['Low', 'Medium', 'High'][brIdx]} · {bitrate} Mbps</span>
            </div>
            <input
              type="range"
              min={0}
              max={2}
              step={1}
              value={brIdx}
              onChange={(e) => setBrIdx(Number(e.target.value))}
            />
            <div className="m-exp-ticks"><span>Low</span><span>Medium</span><span>High</span></div>
          </div>

          <p className="muted small" style={{ textAlign: 'center' }}>≈ {estMb} MB per minute</p>

          <button
            className="m-export-big"
            disabled={!media || job.active}
            onClick={() => exportVideo({ width: W, height: H, bitrateMbps: bitrate })}
          >
            ⬆ Export {RES[resIdx].label}
          </button>
        </div>
      </div>
    </div>
  )
}
