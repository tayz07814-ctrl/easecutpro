import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { IS_CLOUD, IS_NEW_UI } from '../platform'
import RetakeCleanerPanel from './RetakeCleanerPanel'
import { buildSilenceChips } from '@shared/cutlord'
import type { Word } from '@shared/types'
import { useSharedEngineSnapshot } from '../timelineEngine'
import { docEditedToSource, docSourceToEdited } from '../docTime'
import OverlayPanel from './OverlayPanel'

/**
 * Cut Lord — the all-in-one cleanup panel (formerly "Transcript").
 * Tab 1 ClutterCleaner: transcript with inline silence chips + FastCut / ProCut
 * (both REVIEW-ONLY: they highlight repeats/fillers/silences; nothing is cut
 * until "Execute cuts") + the ⚙ smooth/aggressive/manual VAD profile.
 * Tab 2 Auto Zoom & B-roll: zoom keyframes + the AI overlay (B-roll) tools.
 */
export default function TranscriptPanel(): JSX.Element {
  // Redesigned UI (opt-in flag): the whole panel becomes the Retake Cleaner. The
  // legacy path below is untouched. IS_NEW_UI is a build-time constant, so this
  // early return is stable for the app's lifetime (no hooks-order concern).
  if (IS_NEW_UI) return <RetakeCleanerPanel />

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
  const runFastCutLord = useStore((s) => s.runFastCutLord)
  const runProCut = useStore((s) => s.runProCut)
  // "Find Retakes & Silence" runs the REAL Retake β (procut-judge, Opus): the
  // artifact-aware prompt that removes slates / off-camera direction / intro-outro
  // chatter and cuts whole takes precisely. (Retake δ / delta-judge was removed —
  // its narrow prompt left that chatter behind and over-cut wide spans.)
  const runRetakeCutBeta = useStore((s) => s.runRetakeCutBeta)
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
      {/* FastCut (offline) and ProCut are desktop/self-host only for now — the
          cloud beta ships Retake β alone. */}
      {!IS_CLOUD && (
        <button
          className="primary"
          onClick={() => void runFastCutLord()}
          disabled={jobActive}
          title="FastCut — offline repeat/retake engine + silence scan. Highlights only; nothing is cut until Execute."
        >
          ⚡ FastCut
        </button>
      )}
      {!IS_CLOUD && (
        <button
          className="primary"
          onClick={() => void runProCut()}
          disabled={jobActive}
          title="ProCut — premium AI cut + silence scan. Highlights only; nothing is cut until Execute."
        >
          ✂ ProCut
        </button>
      )}
      <button
        className={IS_CLOUD ? 'primary' : ''}
        onClick={() => void runRetakeCutBeta()}
        disabled={jobActive}
        title="Cut Lord — verbatim transcript, whole-take retake removal (never splices takes), filler triage. Highlights only; nothing is cut until Execute."
      >
        🧪 Find Retakes
      </button>
      {!IS_CLOUD && (
        <button className="cl-gear" onClick={() => setShowSettings((v) => !v)} title="FastCut / ProCut settings">
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

  return (
    <div className="cl-set-drop">
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

function ZoomBroll(): JSX.Element {
  return (
    <div className="cl-zoom-tab">
      <div className="cl-set-title">AI B-roll / Overlays</div>
      <OverlayPanel />
    </div>
  )
}
