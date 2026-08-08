import { useEffect, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react'
import { useStore } from '../store'
import { IS_CLOUD, IS_WEB } from '../platform'
import { probeEncodeCaps, whyNotLocal, type EncodeCaps } from '../export/localExport'
import { useSmoothProgress } from '../useSmoothProgress'
import { useSharedEngineSnapshot, getSharedEngine } from '../timelineEngine'
import { primePlayback } from '../clock'
import * as C from '@shared/timeline/commands'
import { Icon } from './mobile/Icon'
import { MobileTools } from './mobile/MobileTools'
import ProjectTitle from './ProjectTitle'
import VideoPreview from './VideoPreview'
import TimelinePanel from './timeline/TimelinePanel'
import MediaLibrary from './MediaLibrary'
import TranscriptPanel from './TranscriptPanel'
import TextPanel from './TextPanel'
import OstPanel from './OstPanel'
import BasicPanel from './BasicPanel'
import SettingsModal from './SettingsModal'

type Sheet = 'media' | 'music' | 'text' | 'transcript' | 'adjust' | 'export' | null

/** Phone layout — CapCut-style: preview, timeline, a scrollable action dock that
 *  swaps to a contextual toolbar when a clip/text is selected, and bottom sheets. */
export default function MobileApp(): JSX.Element {
  const s = useStore()
  const project = s.project
  const hasMedia = !!project.media
  // A montage base has no `media`; gate actions on hasBase so transcribe/tools work.
  const hasBase = hasMedia || ((project.baseSequence?.length ?? 0) > 0)
  const [sheet, setSheet] = useState<Sheet>(null)
  useEffect(() => {
    const open = (e: Event): void => setSheet((e as CustomEvent).detail as Sheet)
    window.addEventListener('ec:sheet', open)
    return () => window.removeEventListener('ec:sheet', open)
  }, [])
  // Preview height (vh): tall by default (~2/3 of the screen) and user-adjustable
  // by dragging the grab handle under the canvas — like the desktop divider.
  const [stageVh, setStageVh] = useState<number>(() => {
    const v = Number(localStorage.getItem('ec.mStageVh'))
    return v >= 22 && v <= 58 ? v : 46
  })
  useEffect(() => localStorage.setItem('ec.mStageVh', String(stageVh)), [stageVh])
  // Mirrors the clip-TRIM drag (which works on iOS + Android): preventDefault +
  // stopPropagation on the pointer-DOWN so iOS doesn't hijack the touch as a page
  // scroll before the drag starts (that was the "grip is frozen" bug — the down
  // event wasn't consumed), then window listeners drive the move. Pointer events
  // only (not touch+mouse) avoid the iOS double-drag from simulated mouse events.
  function startStageDrag(e: ReactPointerEvent<HTMLDivElement>): void {
    e.preventDefault()
    e.stopPropagation()
    const vh0 = stageVh
    const y0 = e.clientY
    const onMove = (ev: PointerEvent): void => {
      const dvh = ((ev.clientY - y0) / window.innerHeight) * 100
      setStageVh(Math.min(58, Math.max(22, vh0 + dvh)))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }
  const [pendingTranscript, setPendingTranscript] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [addMenu, setAddMenu] = useState(false)
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 1800)
    return () => clearTimeout(t)
  }, [toast])
  // Portrait-only: best-effort native orientation lock (works when installed /
  // in fullscreen; a harmless no-op in normal mobile Safari/Chrome). The CSS
  // rotate overlay below covers the browsers that can't lock.
  useEffect(() => {
    const so = (screen as unknown as { orientation?: { lock?: (o: string) => Promise<void> } }).orientation
    try {
      so?.lock?.('portrait')?.catch(() => undefined)
    } catch {
      /* lock needs fullscreen/PWA — the CSS overlay handles the rest */
    }
  }, [])
  const soon = (what: string): void => setToast(`${what} — coming soon`)

  const selClip = s.selectedClipId
  const selSeg = s.selectedSeg
  const selText = s.selectedTextId
  const selSeqClip = s.selectedSeqClipId

  // DOCUMENT mode: selection + edits live on the shared engine, not the legacy
  // store — so delete/split must read and drive the engine.
  const snap = useSharedEngineSnapshot()
  // Engine doc is authoritative even before project.timeline materializes
  // (fresh projects are bridged) — same gate fix as MobileTools.
  const docMode = !!snap?.doc
  const docSelId = docMode ? snap!.interaction.selection[0] ?? null : null
  const hasSelection = docMode ? !!docSelId : !!(selClip || selSeg || selText || selSeqClip)
  const engineDelete = (): void => {
    if (docMode) getSharedEngine()?.deleteSelection(true)
    else s.hotkeyDelete()
  }

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
    getSharedEngine()?.clearSelection()
  }

  function onScript(): void {
    // Open the Cut Lord panel; FastCut / ProCut transcribe on demand there
    // (FastCut with Parakeet, ProCut with OpenAI) — no separate transcribe step.
    setSheet('transcript')
  }

  // The green + adds an empty lane: overlay/text go ABOVE the main lane (order below
  // the current minimum), audio goes BELOW it (order above the current maximum).
  function addLane(kind: 'video' | 'text' | 'audio'): void {
    const e = getSharedEngine()
    setAddMenu(false)
    if (!e || !e.document.tracks.length) return
    const orders = e.document.tracks.map((t) => t.order)
    if (kind === 'audio') {
      e.dispatch(C.addTrack('audio', { name: 'Audio', order: Math.max(...orders) + 1 }))
    } else if (kind === 'text') {
      e.dispatch(C.addTrack('text', { name: 'Text', order: Math.min(...orders) - 1 }))
    } else {
      const n = e.document.tracks.filter((t) => t.kind === 'video' && !t.isMain).length + 1
      e.dispatch(C.addTrack('video', { name: `Overlay ${n}`, order: Math.min(...orders) - 1 }))
    }
  }

  return (
    <div className="m-app">
      {/* Portrait-only guard: shows over everything when a phone is turned landscape */}
      <div className="m-rotate-notice">
        <div className="m-rotate-inner">
          <div className="m-rotate-ic">📱</div>
          Please rotate your phone to <b>portrait</b> to keep editing.
        </div>
      </div>

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
      <div className="m-stage" style={{ height: `${stageVh}vh` }}>
        <VideoPreview />
      </div>
      <div
        className="m-stage-grip"
        onPointerDown={startStageDrag}
      >
        <span />
      </div>

      {/* Transport: undo/redo · play · keyframes + magnet/snap/delete (monochrome) */}
      <div className="m-transport">
        <div className="m-tp-side">
          <button className="m-ic" onClick={s.undo} disabled={!s.canUndo} title="Undo"><Icon name="undo" /></button>
          <button className="m-ic" onClick={s.redo} disabled={!s.canRedo} title="Redo"><Icon name="redo" /></button>
          <button className="m-ic m-zoom" onClick={() => s.setZoom((snap?.session.zoom ?? 60) - 24)} disabled={!hasBase} title="Zoom out">−</button>
          <button className="m-ic m-zoom" onClick={() => s.setZoom((snap?.session.zoom ?? 60) + 24)} disabled={!hasBase} title="Zoom in">+</button>
        </div>
        <button className="m-ic m-play" onClick={() => { if (!hasBase) return; const next = !s.playing; if (next) primePlayback(); s.setPlaying(next) }} disabled={!hasBase} title={s.playing ? 'Pause' : 'Play'}>
          <Icon name={s.playing ? 'pause' : 'play'} size={20} />
        </button>
        <div className="m-tp-side end">
          <button className="m-ic" onClick={() => soon('Keyframes')} disabled={!hasSelection} title="Previous keyframe"><Icon name="kfPrev" /></button>
          <button className="m-ic" onClick={() => soon('Keyframes')} disabled={!hasSelection} title="Add keyframe"><Icon name="kfNext" /></button>
          <button className={'m-ic' + (project.magnet ? ' on' : '')} onClick={s.toggleMagnet} title={`Magnet ${project.magnet ? 'on' : 'off'}`}><Icon name="magnet" /></button>
          <button
            className={'m-ic' + (snap?.session.settings.snapping ? ' on' : '')}
            onClick={() => { const e = getSharedEngine(); if (e) e.updateSettings({ snapping: !e.sessionState.settings.snapping }) }}
            title={`Snap ${snap?.session.settings.snapping ? 'on' : 'off'}`}
          ><Icon name="snap" /></button>
          <button className="m-ic danger" onClick={() => { if (hasSelection) { engineDelete(); clearSelection() } }} disabled={!hasSelection} title="Delete"><Icon name="trash" /></button>
        </div>
      </div>

      {/* Timeline with a + dropdown to add an overlay / text / audio track */}
      <div className="m-tl">
        <div className="m-add-track-wrap">
          <button
            className={'m-add-track' + (addMenu ? ' on' : '')}
            title="Add a track"
            disabled={!hasBase}
            onClick={() => setAddMenu((v) => !v)}
          >
            <Icon name="plus" size={20} />
          </button>
          {addMenu && (
            <>
              <div className="m-add-backdrop" onPointerDown={() => setAddMenu(false)} />
              <div className="m-add-menu" role="menu">
                <button onClick={() => addLane('video')}><Icon name="video" size={16} /> Overlay track</button>
                <button onClick={() => addLane('text')}><Icon name="text" size={16} /> Text track</button>
                <button onClick={() => addLane('audio')}><Icon name="music" size={16} /> Audio track</button>
              </div>
            </>
          )}
        </div>
        <TimelinePanel mobile />
      </div>

      {/* Bottom dock: contextual tools when a clip is selected, else Import + Cut Lord */}
      <div className="m-dock">
        <MobileTools
          onImport={() => setSheet('media')}
          onCutlord={onScript}
          onEditText={() => setSheet('text')}
        />
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
      {toast && <div className="m-toast">{toast}</div>}

      {s.showSettings && <SettingsModal />}
    </div>
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
  const shown = useSmoothProgress(job.active, job.percent, job.kind)
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
  // Doc-native projects never set the legacy media field — gate on the MAIN
  // lane actually having clips instead (why the buttons used to grey out).
  const expSnap = useSharedEngineSnapshot()
  const hasBase = !!expSnap?.doc.tracks.some((t) => t.isMain && t.clips.length > 0)
  const exportVideo = useStore((s) => s.exportVideo)
  const exportVideoOnDevice = useStore((s) => s.exportVideoOnDevice)
  const project = useStore((s) => s.project)
  const [caps, setCaps] = useState<EncodeCaps | null>(null)
  useEffect(() => {
    let alive = true
    void probeEncodeCaps().then((c) => alive && setCaps(c))
    return () => {
      alive = false
    }
  }, [])
  // Video-capable is the real on-device gate; audio may still be missing on
  // iOS Safari < 26, where we export video-only and warn instead of refusing.
  // IS_WEB gate: a narrow Electron window mounts this UI too, and desktop must
  // export through native ffmpeg (the ⬆ button below), never WebCodecs.
  const deviceOk = IS_WEB && !!caps?.video
  const audioMissing = !!caps?.video && !caps.audio
  const localGate = deviceOk ? whyNotLocal(project) : ''
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

          {deviceOk && (
            <>
              <button
                className="m-export-big"
                style={{ marginBottom: localGate ? 2 : 8 }}
                disabled={job.active || !!localGate}
                onClick={() => {
                  onClose()
                  void exportVideoOnDevice({ width: W, height: H, bitrateMbps: bitrate })
                }}
              >
                📱 Save to this device {RES[resIdx].label} (beta)
              </button>
              {/* tooltips don't exist on touch — say WHY it's disabled */}
              {localGate && (
                <p className="muted small" style={{ textAlign: 'center', margin: '0 0 8px' }}>
                  Not available yet: {localGate}
                </p>
              )}
              {audioMissing && !localGate && (
                <p className="muted small" style={{ textAlign: 'center', margin: '0 0 8px' }}>
                  Audio is encoded in-browser on iPhone/iPad (beta) — the first export may take a little longer.
                </p>
              )}
            </>
          )}
          {/* Cloud build: no server renderer — on-device export is the only path. */}
          {IS_CLOUD && caps && !caps.video && (
            <p className="muted small" style={{ textAlign: 'center' }}>
              This browser can't encode video — use Chrome on desktop or Android.
            </p>
          )}
          {!IS_CLOUD && (
            <button
              className="m-export-big"
              disabled={(!media && !hasBase) || job.active}
              onClick={() => exportVideo({ width: W, height: H, bitrateMbps: bitrate })}
            >
              ⬆ Export {RES[resIdx].label}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
