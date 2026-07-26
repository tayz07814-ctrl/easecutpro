// Stage C — Retake Cleaner adapter (screens 1c + the 1b right panel).
// DERIVES the design's 6-state machine and summary tiles from existing store
// fields; ORCHESTRATES the 0.07 Retake Final Boss action, review staging, and
// Execute flow without duplicating engine state in React.

import { useState } from 'react'
import { useStore } from '../../store'
import { buildSilenceChips } from '@shared/cutlord'
import { getSharedEngine } from '../../timelineEngine'
import { docSourceToEdited } from '../../docTime'

export type RetakeState = 'idle' | 'analyzing' | 'results' | 'executed' | 'error'

export interface RetakeModel {
  state: RetakeState
  job: { active: boolean; percent: number; message?: string }
  // summary tiles
  retakes: number // proxy: contiguous runs of staged word cuts (real count not stored — flagged)
  words: number // selectedWordIds.size  (real)
  pauses: number // selected staged silences (real)
  timeSavedS: number // sum of staged word + silence durations (derived)
  wordCount: number
  pauseCount: number
  executable: number
  hasTranscript: boolean
  // review
  segments: { id: string; words: { id: string; text: string; start: number; end: number }[] }[]
  silenceItems: { id: string; start: number; end: number; duration: number; selected: boolean }[]
  chipAfter: Map<string, { durS: number; stagedId?: string; applied?: boolean }>
  isSelected: (id: string) => boolean
  /** committed (already-executed) cut — word.deleted in the transcript. */
  isDeleted: (id: string) => boolean
  isChipSel: (stagedId?: string) => boolean
  /** count of committed (executed) word cuts still in effect. */
  deletedCount: number
  /** cuts applied by the latest Execute (words + silences). */
  appliedCount: number
  // actions
  find: () => void
  findSilence: () => void
  retry: () => void
  execute: () => void
  restore: () => void
  clear: () => void
  selectWord: (id: string, additive: boolean, rangeTo?: string) => void
  toggleChip: (id: string) => void
  /** toggle a committed cut (restore a struck word, or cut a kept one) — live. */
  toggleWord: (id: string) => void
  /** seek the preview to a word's SOURCE start time (double-click) and play. */
  seekWord: (sourceStartS: number) => void
  openSilenceSettings: () => void
}

export function useRetake(): RetakeModel {
  const transcript = useStore((s) => s.project.transcript)
  const projSilences = useStore((s) => s.project.silences)
  const job = useStore((s) => s.job)
  const selected = useStore((s) => s.selectedWordIds)
  const staged = useStore((s) => s.stagedSilences)
  const stagedSel = useStore((s) => s.stagedSilenceSel)
  // On the cloud 0.07 branch this action resolves to Retake Final Boss:
  // AssemblyAI-only verbatim words -> fixed Gemma judge -> fresh Final Boss VAD.
  const runRetakeCutBeta = useStore((s) => s.runRetakeCutBeta)
  const runRetakeSilenceOnly = useStore((s) => s.runRetakeSilenceOnly)
  const executeCuts = useStore((s) => s.executeCuts)
  const restoreSelected = useStore((s) => s.restoreSelected)
  const clearSelection = useStore((s) => s.clearSelection)
  const selectWord = useStore((s) => s.selectWord)
  const toggleStagedSilence = useStore((s) => s.toggleStagedSilence)
  const setShowSilenceSettings = useStore((s) => s.setShowSilenceSettings)
  const toggleWordDeleted = useStore((s) => s.toggleWordDeleted)
  const setPlayhead = useStore((s) => s.setPlayhead)
  const setPlaying = useStore((s) => s.setPlaying)
  const hasTimeline = useStore((s) => !!s.project.timeline)
  const batchRunning = useStore((s) => s.batchRunning)

  // "executed" and "error" aren't distinct store flags, so the panel tracks the
  // last terminal transition locally (reset when a new analysis starts).
  const [executed, setExecuted] = useState(false)
  const [lastExecutedCount, setLastExecutedCount] = useState(0)

  const failed = !job.active && job.percent === 0 && !!job.message && /fail|couldn|could not|didn/i.test(job.message)
  // A successful Final Boss pass is still a real result when the judge and VAD
  // both return zero cuts. Previously that case fell back to `idle`, which hid
  // the freshly-written AssemblyAI transcript and made the run look broken.
  const completedReviewRun =
    !job.active &&
    job.percent === 100 &&
    (job.operation === 'retake-final-boss' || job.operation === 'silence-only')
  const hasResults = selected.size > 0 || staged.length > 0 || completedReviewRun
  // A project opened with RETAKE cuts ALREADY committed (batch-processed, or
  // reopened after a prior Execute) carries them on transcript.words[].deleted —
  // NOT in the staged sets. Surface them in the executed review so the panel
  // shows the transcript with its cuts instead of the idle "Find Retakes" button
  // (which, being the only CTA, would re-run and WIPE those committed cuts).
  const hasCommittedCuts = !!transcript && transcript.words.some((w) => w.deleted)

  let state: RetakeState
  // batchRunning: the headless batch pipeline emits into the SHARED job; ignore
  // that activity here so an opened/finished project never shows a phantom
  // "Analyzing…" bar while other files in the batch are still processing.
  if (job.active && !batchRunning) state = 'analyzing'
  else if (executed) state = 'executed'
  else if (failed) state = 'error'
  else if (hasResults) state = 'results'
  else if (hasCommittedCuts) state = 'executed'
  else state = 'idle'

  const words = selected.size
  const selStaged = staged.filter((r) => stagedSel.has(r.id))
  const pauses = selStaged.length

  // committed cuts (word.deleted) — struck-through in the executed-state review.
  const deletedIds = new Set<string>()
  if (transcript) for (const w of transcript.words) if (w.deleted) deletedIds.add(w.id)

  // retakes-found proxy: contiguous runs of staged word cuts across the transcript.
  let retakes = 0
  if (transcript) {
    let prev = false
    for (const w of transcript.words) {
      const cut = selected.has(w.id)
      if (cut && !prev) retakes++
      prev = cut
    }
  }

  // time saved (derived): staged word durations + selected silence durations.
  let timeSavedS = 0
  if (transcript) for (const w of transcript.words) if (selected.has(w.id)) timeSavedS += Math.max(0, w.end - w.start)
  for (const r of selStaged) timeSavedS += Math.max(0, r.end - r.start)

  const chips = transcript ? buildSilenceChips(transcript.words, staged, projSilences) : []
  const chipAfter = new Map(chips.map((c) => [c.afterWordId, c]))
  const silenceItems = staged.map((region) => ({
    id: region.id,
    start: region.start,
    end: region.end,
    duration: Math.max(0, region.end - region.start),
    selected: stagedSel.has(region.id)
  }))
  const appliedCount = executed
    ? lastExecutedCount
    : deletedIds.size + projSilences.filter((region) => region.action !== 'keep').length

  return {
    state,
    job,
    retakes,
    words,
    pauses,
    timeSavedS,
    wordCount: words,
    pauseCount: pauses,
    executable: words + pauses,
    hasTranscript: !!transcript && transcript.words.length > 0,
    deletedCount: deletedIds.size,
    appliedCount,
    segments: transcript?.segments ?? [],
    silenceItems,
    chipAfter,
    isSelected: (id) => selected.has(id),
    isDeleted: (id) => deletedIds.has(id),
    isChipSel: (stagedId) => (stagedId ? stagedSel.has(stagedId) : false),
    find: () => { setExecuted(false); setLastExecutedCount(0); void runRetakeCutBeta() },
    findSilence: () => { setExecuted(false); setLastExecutedCount(0); void runRetakeSilenceOnly() },
    retry: () => {
      setExecuted(false)
      setLastExecutedCount(0)
      if (job.operation === 'silence-only') void runRetakeSilenceOnly()
      else void runRetakeCutBeta()
    },
    execute: () => {
      setLastExecutedCount(words + pauses)
      setExecuted(true)
      void executeCuts()
    },
    restore: () => restoreSelected(),
    clear: () => clearSelection(),
    selectWord,
    toggleChip: (id) => toggleStagedSilence(id),
    toggleWord: (id) => toggleWordDeleted(id),
    // Words carry SOURCE time; a single-source doc runs the playhead in EDITED
    // time, so map through the main lane (no-op in montage / legacy).
    seekWord: (sourceStartS) => {
      const doc = hasTimeline ? getSharedEngine()?.document : undefined
      setPlayhead(docSourceToEdited(doc, sourceStartS))
      setPlaying(true)
    },
    openSilenceSettings: () => setShowSilenceSettings(true)
  }
}
