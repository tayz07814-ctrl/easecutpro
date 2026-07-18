import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { buildSilenceChips } from '@shared/cutlord'
import type { Word } from '@shared/types'
import { useSharedEngineSnapshot } from '../timelineEngine'
import { docEditedToSource, docSourceToEdited } from '../docTime'
import SilenceSettingsSheet from './SilenceSettingsSheet'

/**
 * Retake Cleaner — the redesigned right-panel view (VITE_NEW_EASECUT_UI only).
 *
 * PRESENTATION ONLY. It reads the SAME store fields the legacy panel does and
 * wires every button to the SAME existing actions — there is no second engine,
 * no duplicated Retake β state, and no new store action beyond the Smart Silence
 * Cutter preference (added at the orchestration layer). The six visual states are
 * DERIVED (pure `useMemo`) from real fields — nothing here stores a phase.
 */
type Phase = 'idle' | 'analyzing' | 'reviewing' | 'executed' | 'error'

function fmtSaved(s: number): string {
  if (s < 1) return '<1s'
  if (s < 60) return `${Math.round(s)}s`
  const m = Math.floor(s / 60)
  const r = Math.round(s % 60)
  return `${m}m${r ? ` ${r}s` : ''}`
}

export default function RetakeCleanerPanel(): JSX.Element {
  const project = useStore((s) => s.project)
  const job = useStore((s) => s.job)
  const selected = useStore((s) => s.selectedWordIds)
  const selectWord = useStore((s) => s.selectWord)
  const clearSelection = useStore((s) => s.clearSelection)
  const restoreSelected = useStore((s) => s.restoreSelected)
  const deleteSelected = useStore((s) => s.deleteSelected)
  const stagedSilences = useStore((s) => s.stagedSilences)
  const stagedSel = useStore((s) => s.stagedSilenceSel)
  const toggleStagedSilence = useStore((s) => s.toggleStagedSilence)
  const executeCuts = useStore((s) => s.executeCuts)
  // "Find Retakes & Silence" runs the REAL Retake β (procut-judge, Opus): the
  // artifact-aware prompt that removes slates / off-camera direction / intro-outro
  // chatter and cuts whole takes precisely. Retake δ (delta-judge) is unrouted —
  // its narrow prompt left that chatter behind and over-cut wide spans.
  const runRetakeCutBeta = useStore((s) => s.runRetakeCutBeta)
  const setShowSilenceSettings = useStore((s) => s.setShowSilenceSettings)
  const showSilenceSettings = useStore((s) => s.showSilenceSettings)
  const setPlayhead = useStore((s) => s.setPlayhead)
  const setPlaying = useStore((s) => s.setPlaying)
  const undo = useStore((s) => s.undo)
  const canUndo = useStore((s) => s.canUndo)
  const setShowExportModal = useStore((s) => s.setShowExportModal)
  const smartSilence = useStore((s) => s.smartSilenceCutter)
  const setSmartSilence = useStore((s) => s.setSmartSilenceCutter)

  const [lastClicked, setLastClicked] = useState<string | null>(null)
  const dragging = useRef(false)
  const anchor = useRef<string | null>(null)

  const transcript = project.transcript
  const jobActive = job.active

  // Delete/Escape parity with the legacy panel (both use the same store actions).
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

  // ---- DERIVED phase (pure; no stored state) ----
  const phase: Phase = useMemo(() => {
    if (jobActive && job.kind === 'transcribe') return 'analyzing'
    const msg = job.message ?? ''
    if (!jobActive && msg.startsWith('Executed:')) return 'executed'
    if (!jobActive && /^Retake β (couldn|failed)/.test(msg)) return 'error'
    if (transcript) return 'reviewing'
    return 'idle'
  }, [jobActive, job.kind, job.message, transcript])

  // Silence is only surfaced when Smart Silence Cutter is ON. When OFF we neither
  // show nor count staged silence (staging + execution are already blocked in the
  // store); already-committed project.silences stay visible as applied chips.
  const displayStaged = smartSilence ? stagedSilences : []
  const enabledStaged = displayStaged.filter((r) => stagedSel.has(r.id))
  const executable = selected.size + enabledStaged.length

  // ---- Summary metrics — REAL values only ----
  const summary = useMemo(() => {
    let regions = 0
    let wordTime = 0
    if (transcript) {
      const ws = transcript.words
      let i = 0
      while (i < ws.length) {
        if (selected.has(ws[i].id)) {
          const start = ws[i].start
          let end = ws[i].end
          let j = i
          while (j < ws.length && selected.has(ws[j].id)) {
            end = ws[j].end
            j++
          }
          regions++
          wordTime += Math.max(0, end - start)
          i = j
        } else {
          i++
        }
      }
    }
    const silenceTime = enabledStaged.reduce((n, r) => n + Math.max(0, r.end - r.start), 0)
    return {
      words: selected.size,
      pauses: enabledStaged.length,
      regions,
      timeSaved: wordTime + silenceTime
    }
  }, [transcript, selected, enabledStaged])

  // ---- transcript playhead highlight (edited → source), reusing shared helpers ----
  const snap = useSharedEngineSnapshot()
  const doc = project.timeline ? snap?.doc : undefined
  const srcPlayhead = docEditedToSource(doc, project.playhead)

  function handleDown(w: Word, e: React.MouseEvent): void {
    e.preventDefault()
    if (e.shiftKey && lastClicked) {
      selectWord(lastClicked, true, w.id)
    } else {
      selectWord(w.id, true)
      anchor.current = w.id
      dragging.current = true
    }
    setLastClicked(w.id)
  }
  function handleEnter(w: Word): void {
    if (dragging.current && anchor.current) selectWord(anchor.current, true, w.id)
  }
  function handleDouble(w: Word): void {
    setPlayhead(docSourceToEdited(doc, w.start))
    setPlaying(true)
  }

  const modal = showSilenceSettings ? <SilenceSettingsSheet /> : null

  // ---- header (shared across states) ----
  const header = (
    <div className="rc-head">
      <div className="rc-title">
        Retake Cleaner <span className="rc-beta">BETA</span>
      </div>
      <div className="rc-sub">Find retakes, production chatter, false starts, and long pauses.</div>
    </div>
  )

  // Smart Silence toggle (shared control)
  const silenceToggle = (
    <label className="rc-toggle" title="Also trim long pauses. When off, only retakes/words are cut.">
      <input type="checkbox" checked={smartSilence} onChange={(e) => setSmartSilence(e.target.checked)} />
      <span className="rc-toggle-track" aria-hidden="true">
        <span className="rc-toggle-knob" />
      </span>
      <span className="rc-toggle-label">Smart Silence Cutter</span>
    </label>
  )

  // -------------------------------------------------------------- ANALYZING
  if (phase === 'analyzing') {
    const pct = Math.max(0, Math.min(100, job.percent))
    const steps = [
      { label: 'Transcribing audio', done: pct >= 50, on: pct < 50 },
      { label: 'Finding retakes', done: pct >= 90, on: pct >= 50 && pct < 90 },
      { label: 'Checking silence', done: pct >= 100, on: pct >= 90 && pct < 100 }
    ]
    return (
      <div className="rc-panel">
        {header}
        <div className="rc-card">
          <div className="rc-row-between">
            <span className="rc-analyzing-msg">{job.message || 'Analyzing your video…'}</span>
            <span className="rc-mono">{pct}%</span>
          </div>
          <div className="rc-progress">
            <div className="rc-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="rc-steps">
            {steps.map((s) => (
              <div key={s.label} className={'rc-step' + (s.done ? ' done' : s.on ? ' on' : '')}>
                <span className="rc-step-dot">{s.done ? '✓' : ''}</span>
                {s.label}
              </div>
            ))}
          </div>
        </div>
        <div className="rc-hint">You can keep editing while this runs.</div>
      </div>
    )
  }

  // --------------------------------------------------------------- EXECUTED
  if (phase === 'executed') {
    return (
      <div className="rc-panel">
        {header}
        <div className="rc-card rc-success">
          <span className="rc-success-icon">✓</span>
          <div>
            <div className="rc-success-title">Cuts applied</div>
            <div className="rc-success-msg">{job.message}</div>
          </div>
        </div>
        <div className="rc-actions">
          <button onClick={undo} disabled={!canUndo}>Undo all</button>
          <button className="primary" onClick={() => setShowExportModal(true)}>Export</button>
        </div>
        <div className="rc-hint">Run again after more edits to catch new pauses.</div>
        <button className="rc-run-again" onClick={() => void runRetakeCutBeta()} disabled={jobActive}>
          🧪 Find Retakes &amp; Silence
        </button>
        {modal}
      </div>
    )
  }

  // ------------------------------------------------------------------ ERROR
  if (phase === 'error') {
    return (
      <div className="rc-panel">
        {header}
        <div className="rc-card rc-error">
          <span className="rc-error-icon">!</span>
          <div>
            <div className="rc-error-title">Analysis didn’t finish</div>
            {/* job.message is already masked via safeErrMessage — no stacks/providers/paths. */}
            <div className="rc-error-msg">{job.message || 'Something went wrong. Your project is untouched.'}</div>
          </div>
        </div>
        <button className="primary rc-hero" onClick={() => void runRetakeCutBeta()} disabled={jobActive}>
          Try again
        </button>
        {modal}
      </div>
    )
  }

  // ------------------------------------------------------------------- IDLE
  if (phase === 'idle') {
    return (
      <div className="rc-panel">
        {header}
        <button className="primary rc-hero" onClick={() => void runRetakeCutBeta()} disabled={jobActive}>
          🧪 Find Retakes &amp; Silence
        </button>
        <button className="rc-secondary" onClick={() => setShowSilenceSettings(true)} disabled={jobActive}>
          🔇 Silence Settings
        </button>
        {silenceToggle}
        <button className="rc-execute" disabled title="Nothing staged yet">
          ▶ Execute cuts
        </button>
        <div className="rc-note">Beta — review proposed cuts before executing. Nothing is removed without you.</div>
        {modal}
      </div>
    )
  }

  // ------------------------------------------------------- REVIEWING (results)
  const chips = buildSilenceChips(transcript!.words, displayStaged, project.silences)
  const chipAfter = new Map(chips.map((c) => [c.afterWordId, c]))
  const anyDeletedSelected = [...selected].some((id) => transcript!.words.find((w) => w.id === id)?.deleted)

  return (
    <div className="rc-panel">
      {header}

      {/* summary card — real values only */}
      <div className="rc-card rc-summary">
        <div className="rc-stat">
          <div className="rc-stat-n">{summary.words}</div>
          <div className="rc-stat-l">words to remove</div>
        </div>
        <div className="rc-stat">
          <div className="rc-stat-n cut">{summary.regions}</div>
          <div className="rc-stat-l">cut regions</div>
        </div>
        {smartSilence && (
          <div className="rc-stat">
            <div className="rc-stat-n sil">{summary.pauses}</div>
            <div className="rc-stat-l">pauses to trim</div>
          </div>
        )}
        <div className="rc-stat">
          <div className="rc-stat-n ok">~{fmtSaved(summary.timeSaved)}</div>
          <div className="rc-stat-l">time saved</div>
        </div>
      </div>

      <div className="rc-actions">
        <button className="primary" onClick={executeCuts} disabled={!executable || jobActive}>
          ▶ Execute cuts ({executable})
        </button>
        <button className="rc-secondary" onClick={() => setShowSilenceSettings(true)} disabled={jobActive}>
          🔇 Silence Settings
        </button>
      </div>
      {silenceToggle}

      <div className="rc-review-head">
        <span className="rc-review-title">Review transcript</span>
        <span className="rc-spacer" />
        <button className="rc-link" onClick={restoreSelected} disabled={!selected.size || !anyDeletedSelected}>Restore</button>
        <button className="rc-link" onClick={clearSelection} disabled={!selected.size}>Clear</button>
      </div>
      <div className="rc-review-hint">
        Click a word to keep or cut it{smartSilence ? ' · click a silence chip to keep the pause' : ''} · double-click plays
      </div>

      <div className="rc-transcript">
        {transcript!.segments.map((seg) => (
          <p className="rc-seg" key={seg.id}>
            {seg.words.map((w) => {
              const isSel = selected.has(w.id)
              const active = srcPlayhead >= w.start && srcPlayhead < w.end && !w.deleted
              const chip = chipAfter.get(w.id)
              return (
                <span key={w.id}>
                  <span
                    className={'rc-w' + (w.deleted ? ' deleted' : '') + (isSel ? ' cut' : '') + (active ? ' active' : '')}
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
                        'rc-chip' +
                        (chip.applied ? ' applied' : '') +
                        (chip.stagedId && stagedSel.has(chip.stagedId) ? ' on' : '') +
                        (chip.stagedId ? ' staged' : '')
                      }
                      title={chip.applied ? 'Silence already cut' : chip.stagedId ? 'Staged pause — click to keep it' : `Silence ${chip.durS}s`}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        if (chip.stagedId) toggleStagedSilence(chip.stagedId)
                      }}
                    >
                      {chip.durS}s
                    </span>
                  )}
                  {chip && ' '}
                </span>
              )
            })}
          </p>
        ))}
      </div>
      {modal}
    </div>
  )
}
