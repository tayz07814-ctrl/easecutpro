import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { IS_CLOUD } from '../platform'
import { buildSilenceChips, CUTLORD_PRESETS, type CutLordMode } from '@shared/cutlord'
import type { Word } from '@shared/types'
import { useSharedEngineSnapshot } from '../timelineEngine'
import { mainTrackId } from '@shared/timeline/model'
import { secondsToFrames, framesToSeconds } from '@shared/timeline/time'
import type { TimelineDocument } from '@shared/timeline/types'
import OverlayPanel from './OverlayPanel'
import SilenceSettingsModal from './SilenceSettingsModal'

/**
 * A single-source doc timeline runs the store playhead in EDITED time, but the
 * transcript words stay in SOURCE time — so `playhead >= w.start` drifts by the
 * cut amount and the highlighted word lags the audio. These map between the two
 * through the main lane. Montage (multiple source files) keeps the words' own
 * domain, so both return the value unchanged there (and in legacy mode).
 */
function docMainSingleSource(doc: TimelineDocument): TimelineDocument['tracks'][number] | null {
  const mainId = mainTrackId(doc)
  const main = mainId ? doc.tracks.find((t) => t.id === mainId) : undefined
  if (!main || !main.clips.length) return null
  return new Set(main.clips.map((c) => c.sourcePath)).size === 1 ? main : null
}
function docEditedToSource(doc: TimelineDocument | undefined, editedSec: number): number {
  const main = doc ? docMainSingleSource(doc) : null
  if (!doc || !main) return editedSec
  const f = secondsToFrames(editedSec, doc.timebase)
  const clips = [...main.clips].sort((a, b) => a.start - b.start)
  const clip = clips.find((c) => f >= c.start && f < c.end) ?? clips[clips.length - 1]
  const span = clip.sourceOut - clip.sourceIn
  return clip.duration > 0 ? clip.sourceIn + ((f - clip.start) / clip.duration) * span : editedSec
}
function docSourceToEdited(doc: TimelineDocument | undefined, srcSec: number): number {
  const main = doc ? docMainSingleSource(doc) : null
  if (!doc || !main) return srcSec
  const clips = [...main.clips].sort((a, b) => a.start - b.start)
  const clip = clips.find((c) => srcSec >= c.sourceIn && srcSec < c.sourceOut)
  if (!clip) {
    // the word was cut out: seek to the first kept clip that starts after it.
    const after = clips.find((c) => c.sourceIn >= srcSec) ?? clips[clips.length - 1]
    return framesToSeconds(after.start, doc.timebase)
  }
  const span = clip.sourceOut - clip.sourceIn
  const frac = span > 0 ? (srcSec - clip.sourceIn) / span : 0
  return framesToSeconds(clip.start + frac * clip.duration, doc.timebase)
}

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
          {/* AI zoom/B-roll generation runs on the PC engines — desktop/self-host only. */}
          {!IS_CLOUD && (
            <button className={clTab === 'zoom' ? 'on' : ''} onClick={() => setClTab('zoom')}>
              🎬 Auto Zoom & B-roll
            </button>
          )}
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
  const runRetakeCutBeta = useStore((s) => s.runRetakeCutBeta)
  const setShowSilenceSettings = useStore((s) => s.setShowSilenceSettings)
  const showSilenceSettings = useStore((s) => s.showSilenceSettings)
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
  const snap = useSharedEngineSnapshot()
  const doc = project.timeline ? snap?.doc : undefined
  // Highlight the word under the audio: map the EDITED playhead to SOURCE time in a
  // single-source doc timeline (no-op in montage / legacy, where they share a domain).
  const srcPlayhead = docEditedToSource(doc, playhead)

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
    // SOURCE-time word start -> EDITED playhead so the preview seeks to the word.
    setPlayhead(docSourceToEdited(doc, w.start))
    setPlaying(true)
  }

  // The engine buttons must exist BEFORE a transcript does — they're what
  // creates it. Shared between the empty state and the full panel.
  const engineActions = (
    <div className="row cl-actions">
      {/* FastCut is the offline Parakeet engine — desktop/self-host only. ProCut
          runs in the cloud too (AssemblyAI transcribes + Claude finalizes via the
          procut-judge edge fn), so it shows alongside Retake β everywhere. */}
      {!IS_CLOUD && (
        <button
          className="primary"
          onClick={() => void runFastCutLord()}
          disabled={jobActive}
          title="FastCut — offline repeat/retake engine + VAD silence scan (⚙ profile). Highlights only; nothing is cut until Execute."
        >
          ⚡ FastCut
        </button>
      )}
      <button
        className="primary"
        onClick={() => void runProCut()}
        disabled={jobActive}
        title={
          IS_CLOUD
            ? 'ProCut — premium AI cut: AssemblyAI transcribes, then Claude finalizes zero-repeat cuts + VAD silence. Highlights only; nothing is cut until Execute.'
            : 'ProCut — premium 4-phase AI pipeline (whisper+Parakeet map → Claude → OpenAI listens) + VAD silence scan. Highlights only; nothing is cut until Execute.'
        }
      >
        ✂ ProCut
      </button>
      <button
        className={IS_CLOUD ? 'primary' : ''}
        onClick={() => void runRetakeCutBeta()}
        disabled={jobActive}
        title="Cut Lord — verbatim transcript, whole-take retake removal (never splices takes), filler triage, AND conservative transcript-gap silence tightening. Highlights + silence chips only; nothing is cut until Execute."
      >
        🧪 Find Retakes &amp; Silence
      </button>
      <button
        onClick={() => setShowSilenceSettings(true)}
        disabled={jobActive}
        title="Retake β silence-detection settings (Retake β only — does not affect FastCut/ProCut)."
      >
        🔇 Silence Settings
      </button>
      {!IS_CLOUD && (
        <button className="cl-gear" onClick={() => setShowSettings((v) => !v)} title="FastCut / ProCut silence-cleaning profile">
          ⚙
        </button>
      )}
      <span className="spacer" />
      <button
        className="danger"
        onClick={executeCuts}
        disabled={!executable || jobActive}
        title="Apply the reviewed cuts: delete highlighted words + clean highlighted silences"
      >
        ▶ Execute cuts ({executable})
      </button>
      {showSilenceSettings && <SilenceSettingsModal />}
    </div>
  )

  if (!transcript) {
    return (
      <>
        <div className="transcript-head">
          {engineActions}
          {showSettings && <CutLordSettingsDrop />}
          <ScriptSection />
        </div>
        <div className="transcript empty muted">
          {IS_CLOUD ? (
            <>
              No transcript yet. Click <b>🧪 Find Retakes & Silence</b> — it transcribes automatically
              and highlights retakes, fillers and silences here for review.
            </>
          ) : (
            <>
              No transcript yet. Click <b>⚡ FastCut</b> or <b>✂ ProCut</b> — they transcribe automatically
              (FastCut with Parakeet, ProCut with OpenAI) and highlight fillers, repeats and silences here for review.
            </>
          )}
        </div>
      </>
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
        {engineActions}
        {showSettings && <CutLordSettingsDrop />}
        <ScriptSection />
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
            {/* Smart Smooth's judge runs on the PC server — desktop/self-host only. */}
            {!IS_CLOUD && (
              <>
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
              </>
            )}
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
              const active = srcPlayhead >= w.start && srcPlayhead < w.end && !w.deleted
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

/** Collapsible "Your script" box. When filled, FastCut and ProCut compare the
 *  verbatim transcript against it — off-script speech (flubs, asides, slates)
 *  becomes cut evidence and the take closest to the script survives. */
function ScriptSection(): JSX.Element {
  const script = useStore((s) => s.project.script ?? '')
  const setScript = useStore((s) => s.setScript)
  const [open, setOpen] = useState(script.length > 0)
  return (
    <div className="cl-script">
      <div className="row">
        <button className="mini" onClick={() => setOpen((v) => !v)}>
          {open ? '📜 Script ▴' : '📜 Script ▾'}
        </button>
        {!open && script.length > 0 && (
          <span className="muted mini-note">guiding cuts ({script.split(/\s+/).filter(Boolean).length} words)</span>
        )}
      </div>
      {open && (
        <>
          <textarea
            className="cl-script-box"
            rows={5}
            value={script}
            placeholder={'Paste the script you meant to say.\nFastCut + ProCut will keep the takes that match it and flag everything off-script (flubs, asides, retakes).'}
            onChange={(e) => setScript(e.target.value)}
          />
          {script.length > 0 && (
            <div className="row">
              <button className="mini" onClick={() => setScript('')}>Clear script</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

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
      <label className="cl-switch">
        <input
          type="checkbox"
          checked={cfg.vadDuringAnalysis}
          onChange={(e) => setCfg({ vadDuringAnalysis: e.target.checked })}
        />
        <span>
          Silero VAD during analysis <b>(test)</b> — ON: FastCut/ProCut stage silence chips for review ·
          OFF: silence is skipped in the engines and runs only when you Execute cuts
        </span>
      </label>
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
  return (
    <div className="cl-zoom-tab">
      <div className="cl-set-title">AI B-roll / Overlays</div>
      <OverlayPanel />
    </div>
  )
}
