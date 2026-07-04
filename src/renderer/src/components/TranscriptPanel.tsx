import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { buildSilenceChips, CUTLORD_PRESETS, type CutLordMode } from '@shared/cutlord'
import type { Word } from '@shared/types'
import OverlayPanel from './OverlayPanel'

/**
 * Cut Lord — the all-in-one cleanup panel (formerly "Transcript").
 * Tab 1 ClutterCleaner: transcript with inline silence chips + FastCut / ProCut
 * (both REVIEW-ONLY: they highlight repeats/fillers/silences; nothing is cut
 * until "Execute cuts") + the ⚙ smooth/aggressive/manual VAD profile.
 * Tab 2 Auto Zoom & B-roll: zoom keyframes + the AI overlay (B-roll) tools.
 */
export default function TranscriptPanel(): JSX.Element {
  const [clTab, setClTab] = useState<'clutter' | 'zoom'>('clutter')

  return (
    <div className="transcript-panel">
      <div className="cl-head">
        <h3>🧙 Cut Lord</h3>
        <div className="cl-greet">Hi, I am Cut Lord — your all-in-one video editing assistant.</div>
        <div className="cl-tabs">
          <button className={clTab === 'clutter' ? 'on' : ''} onClick={() => setClTab('clutter')}>
            🧹 ClutterCleaner
          </button>
          <button className={clTab === 'zoom' ? 'on' : ''} onClick={() => setClTab('zoom')}>
            🎬 Auto Zoom & B-roll
          </button>
        </div>
      </div>
      {clTab === 'clutter' ? <ClutterCleaner /> : <ZoomBroll />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab 1 — ClutterCleaner
// ---------------------------------------------------------------------------

function ClutterCleaner(): JSX.Element {
  const project = useStore((s) => s.project)
  const selected = useStore((s) => s.selectedWordIds)
  const selectWord = useStore((s) => s.selectWord)
  const selectFillers = useStore((s) => s.selectFillers)
  const selectRepeats = useStore((s) => s.selectRepeats)
  const selectAICuts = useStore((s) => s.selectAICuts)
  const smartSmoothCut = useStore((s) => s.smartSmoothCut)
  const smartCutPreset = useStore((s) => s.smartCutPreset)
  const setSmartCutPreset = useStore((s) => s.setSmartCutPreset)
  const runFastCutLord = useStore((s) => s.runFastCutLord)
  const runProCut = useStore((s) => s.runProCut)
  const executeCuts = useStore((s) => s.executeCuts)
  const stagedSilences = useStore((s) => s.stagedSilences)
  const stagedSel = useStore((s) => s.stagedSilenceSel)
  const toggleStagedSilence = useStore((s) => s.toggleStagedSilence)
  const jobActive = useStore((s) => s.job.active)
  const openaiAvailable = useStore((s) => s.openaiAvailable)
  const deleteSelected = useStore((s) => s.deleteSelected)
  const restoreSelected = useStore((s) => s.restoreSelected)
  const clearSelection = useStore((s) => s.clearSelection)
  const setPlayhead = useStore((s) => s.setPlayhead)
  const setPlaying = useStore((s) => s.setPlaying)
  const [lastClicked, setLastClicked] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showMore, setShowMore] = useState(false)
  const playhead = project.playhead

  // Drag-to-select state (refs to avoid re-renders mid-drag).
  const dragging = useRef(false)
  const anchor = useRef<string | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        deleteSelected()
      } else if (e.key === 'Escape') {
        clearSelection()
      }
    }
    function onUp(): void {
      dragging.current = false
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mouseup', onUp)
    }
  }, [deleteSelected, clearSelection])

  const transcript = project.transcript
  const nStaged = stagedSilences.filter((r) => stagedSel.has(r.id)).length
  const executable = selected.size + nStaged

  // Mouse down on a word: TOGGLE just that word — an accidental tap must never
  // wipe an engine's highlighted set. Shift = range from the last click.
  function handleDown(w: Word, e: React.MouseEvent): void {
    e.preventDefault()
    if (e.shiftKey && lastClicked) {
      selectWord(lastClicked, true, w.id)
    } else {
      selectWord(w.id, true) // additive toggle — preserves all other highlights
      anchor.current = w.id
      dragging.current = true
    }
    setLastClicked(w.id)
  }

  function handleEnter(w: Word): void {
    if (dragging.current && anchor.current) {
      selectWord(anchor.current, true, w.id)
    }
  }

  function handleDouble(w: Word): void {
    setPlayhead(w.start)
    setPlaying(true)
  }

  if (!transcript) {
    return (
      <div className="transcript empty muted">
        No transcript yet. Click <b>📝 Transcribe</b> in the toolbar, then FastCut / ProCut will
        highlight fillers, repeats and silences here for you to review.
      </div>
    )
  }

  const anyDeletedSelected = [...selected].some(
    (id) => transcript.words.find((w) => w.id === id)?.deleted
  )
  const chips = buildSilenceChips(transcript.words, stagedSilences, project.silences)
  const chipAfter = new Map(chips.map((c) => [c.afterWordId, c]))

  return (
    <>
      <div className="transcript-head">
        <div className="row cl-actions">
          <button
            className="primary"
            onClick={() => void runFastCutLord()}
            disabled={jobActive}
            title="FastCut — offline repeat/retake engine + VAD silence scan (⚙ profile). Highlights only; nothing is cut until Execute."
          >
            ⚡ FastCut
          </button>
          <button
            className="primary"
            onClick={() => void runProCut()}
            disabled={jobActive}
            title="ProCut — premium 4-phase AI pipeline (whisper+Parakeet map → Claude → OpenAI listens) + VAD silence scan. Highlights only; nothing is cut until Execute."
          >
            ✂ ProCut
          </button>
          <button className="cl-gear" onClick={() => setShowSettings((v) => !v)} title="FastCut / ProCut silence-cleaning profile">
            ⚙
          </button>
          <span className="spacer" />
          <button
            className="danger"
            onClick={executeCuts}
            disabled={!executable || jobActive}
            title="Apply the reviewed cuts: delete highlighted words + clean highlighted silences"
          >
            ▶ Execute cuts ({executable})
          </button>
        </div>
        {showSettings && <CutLordSettingsDrop />}
        <div className="row">
          <button className="danger" onClick={deleteSelected} disabled={!selected.size}>
            Delete ({selected.size})
          </button>
          <button onClick={restoreSelected} disabled={!selected.size || !anyDeletedSelected}>
            Restore
          </button>
          <button onClick={clearSelection} disabled={!selected.size}>
            Clear
          </button>
          <span className="spacer" />
          <button className="mini" onClick={() => setShowMore((v) => !v)}>
            {showMore ? 'Less ▴' : 'More tools ▾'}
          </button>
        </div>
        {showMore && (
          <div className="row">
            <button onClick={selectFillers} title="Highlight filler words">✨ Fillers</button>
            <button onClick={selectRepeats} title="Highlight stutters & repeats">🔁 Repeats</button>
            {openaiAvailable && (
              <button onClick={() => void selectAICuts()} title="AI review (OpenAI)">✨ Smart cut (AI)</button>
            )}
            <button onClick={() => void smartSmoothCut()} disabled={jobActive} title="Experimental pause editor">
              🪄 Smooth Cut β
            </button>
            <select
              value={smartCutPreset}
              onChange={(e) => setSmartCutPreset(e.target.value as 'natural' | 'tiktok_smooth' | 'aggressive')}
              title="Smooth Cut style"
            >
              <option value="natural">natural</option>
              <option value="tiktok_smooth">tiktok smooth</option>
              <option value="aggressive">aggressive</option>
            </select>
          </div>
        )}
        <div className="hint muted">
          Click a word to (un)flag it · <b>Shift</b>-click = range · <b>Del</b> cuts now · double-click plays ·
          silence chips toggle on click
        </div>
      </div>

      <div className="transcript">
        {transcript.segments.map((seg) => (
          <p className="segment" key={seg.id}>
            {seg.words.map((w) => {
              const isSel = selected.has(w.id)
              const active = playhead >= w.start && playhead < w.end && !w.deleted
              const chip = chipAfter.get(w.id)
              return (
                <span key={w.id}>
                  <span
                    className={
                      'word' +
                      (w.deleted ? ' deleted' : '') +
                      (isSel ? ' sel' : '') +
                      (active ? ' active' : '')
                    }
                    onMouseDown={(e) => handleDown(w, e)}
                    onMouseEnter={() => handleEnter(w)}
                    onDoubleClick={() => handleDouble(w)}
                    title={`${w.start.toFixed(2)}s – ${w.end.toFixed(2)}s`}
                  >
                    {w.text}
                  </span>{' '}
                  {chip && (
                    <span
                      className={
                        'sil-chip' +
                        (chip.applied ? ' applied' : '') +
                        (chip.stagedId && stagedSel.has(chip.stagedId) ? ' sel' : '') +
                        (chip.stagedId ? ' staged' : '')
                      }
                      title={
                        chip.applied
                          ? 'Silence already cut'
                          : chip.stagedId
                            ? 'Staged silence cut — click to toggle'
                            : `Silence ${chip.durS}s`
                      }
                      onMouseDown={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        if (chip.stagedId) toggleStagedSilence(chip.stagedId)
                      }}
                    >
                      (silence {chip.durS}s)
                    </span>
                  )}
                  {chip && ' '}
                </span>
              )
            })}
          </p>
        ))}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// ⚙ dropdown — smooth / aggressive / manual profile
// ---------------------------------------------------------------------------

function CutLordSettingsDrop(): JSX.Element {
  const cfg = useStore((s) => s.cutLordSettings)
  const setCfg = useStore((s) => s.setCutLordSettings)
  const fillerWords = useStore((s) => s.fillerWords)
  const setFillerWords = useStore((s) => s.setFillerWords)
  const [fillerText, setFillerText] = useState(fillerWords.join(', '))

  const mode = (m: CutLordMode): void => setCfg({ mode: m })
  const p = CUTLORD_PRESETS

  return (
    <div className="cl-set-drop">
      <div className="cl-set-row">
        <button className={'cl-mode' + (cfg.mode === 'smooth' && !cfg.manual ? ' on' : '')} onClick={() => mode('smooth')} disabled={cfg.manual}
          title={`VAD ${p.smooth.vad.threshold * 100}% · trim ${p.smooth.vad.trimCuts}s · pad ${p.smooth.vad.padding}s · min gap ${p.smooth.vad.minGap}s`}>
          🌊 Smooth
        </button>
        <button className={'cl-mode' + (cfg.mode === 'aggressive' && !cfg.manual ? ' on' : '')} onClick={() => mode('aggressive')} disabled={cfg.manual}
          title={`VAD ${p.aggressive.vad.threshold * 100}% · trim ${p.aggressive.vad.trimCuts}s · pad ${p.aggressive.vad.padding}s · min gap ${p.aggressive.vad.minGap}s + dB pass ${p.aggressive.db.noiseDb}dB`}>
          🔥 Aggressive
        </button>
      </div>
      <label className="cl-switch">
        <input type="checkbox" checked={cfg.manual} onChange={(e) => setCfg({ manual: e.target.checked })} />
        <span>Manual settings (override Smooth/Aggressive)</span>
      </label>
      <div className={'cl-manual' + (cfg.manual ? '' : ' off')}>
        <div className="cl-set-title">VAD silence</div>
        <Slider label="Speech threshold" value={cfg.vad.threshold} min={0.2} max={0.95} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => setCfg({ vad: { ...cfg.vad, threshold: v } })} disabled={!cfg.manual} />
        <Slider label="Trim cuts" value={cfg.vad.trimCuts} min={0} max={0.4} step={0.01} fmt={(v) => `${v.toFixed(2)}s`}
          onChange={(v) => setCfg({ vad: { ...cfg.vad, trimCuts: v } })} disabled={!cfg.manual} />
        <Slider label="Padding" value={cfg.vad.padding} min={0} max={0.2} step={0.01} fmt={(v) => `${v.toFixed(2)}s`}
          onChange={(v) => setCfg({ vad: { ...cfg.vad, padding: v } })} disabled={!cfg.manual} />
        <Slider label="Min gap" value={cfg.vad.minGap} min={0.05} max={1} step={0.05} fmt={(v) => `${v.toFixed(2)}s`}
          onChange={(v) => setCfg({ vad: { ...cfg.vad, minGap: v } })} disabled={!cfg.manual} />
        <label className="cl-switch small">
          <input type="checkbox" checked={cfg.useDb} onChange={(e) => setCfg({ useDb: e.target.checked })} disabled={!cfg.manual} />
          <span>Fast dB pass</span>
        </label>
        <div className={'cl-db' + (cfg.useDb ? '' : ' off')}>
          <Slider label="Threshold" value={cfg.db.noiseDb} min={-60} max={-10} step={1} fmt={(v) => `${v}dB`}
            onChange={(v) => setCfg({ db: { ...cfg.db, noiseDb: v } })} disabled={!cfg.manual || !cfg.useDb} />
          <Slider label="Min gap" value={cfg.db.minGap} min={0.05} max={1} step={0.05} fmt={(v) => `${v.toFixed(2)}s`}
            onChange={(v) => setCfg({ db: { ...cfg.db, minGap: v } })} disabled={!cfg.manual || !cfg.useDb} />
          <Slider label="Padding" value={cfg.db.padding} min={0} max={0.1} step={0.01} fmt={(v) => `${v.toFixed(2)}s`}
            onChange={(v) => setCfg({ db: { ...cfg.db, padding: v } })} disabled={!cfg.manual || !cfg.useDb} />
        </div>
      </div>
      <div className="cl-set-title" style={{ marginTop: 4 }}>Fillers</div>
      <label className="cl-switch">
        <input
          type="checkbox"
          checked={cfg.fillers}
          onChange={(e) => setCfg({ fillers: e.target.checked })}
        />
        <span>Detect filler words (FastCut & ProCut flag them for review)</span>
      </label>
      <div className={'cl-fillers' + (cfg.fillers ? '' : ' off')}>
        <input
          className="cl-filler-input"
          type="text"
          value={fillerText}
          disabled={!cfg.fillers}
          placeholder="like, actually, literally, um, uh, you know…"
          onChange={(e) => setFillerText(e.target.value)}
          onBlur={() => setFillerWords(fillerText.split(',').map((s) => s.trim()).filter(Boolean))}
          title="Comma-separated list of fillers to flag — edit and click away to save"
        />
      </div>
    </div>
  )
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  fmt,
  onChange,
  disabled
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  fmt: (v: number) => string
  onChange: (v: number) => void
  disabled?: boolean
}): JSX.Element {
  return (
    <label className="cl-slider">
      <span className="cl-slider-lb">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))} />
      <input
        type="number"
        className="cl-slider-num"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)))
        }}
      />
      <span className="cl-slider-val">{fmt(value)}</span>
    </label>
  )
}

// ---------------------------------------------------------------------------
// Tab 2 — Auto Zoom & B-roll
// ---------------------------------------------------------------------------

function ZoomBroll(): JSX.Element {
  const addBaseKeyframe = useStore((s) => s.addBaseKeyframe)
  const hasBase = useStore((s) => !!s.project.media || ((s.project.baseSequence?.length ?? 0) > 0))
  return (
    <div className="cl-zoom-tab">
      <div className="cl-set-title">Auto Zoom</div>
      <p className="muted small">
        Add CapCut-style zoom/pan keyframes on the base at the playhead, then fine-tune them in the
        <b> Basic</b> tab.
      </p>
      <button className="primary" onClick={addBaseKeyframe} disabled={!hasBase}>
        ➕ Add zoom keyframe at playhead
      </button>
      <div className="cl-set-title" style={{ marginTop: 12 }}>AI B-roll / Overlays</div>
      <OverlayPanel />
    </div>
  )
}
