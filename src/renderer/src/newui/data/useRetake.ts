// Stage C — Retake Cleaner adapter (screens 1c + the 1b right panel).
// DERIVES the design's 6-state machine and summary tiles from existing store
// fields; ORCHESTRATES existing actions (runRetakeCutBeta / executeCuts /
// selectWord / …). Does not touch Retake β or silence-engine internals.

import { useState } from 'react'
import { useStore } from '../../store'
import { buildSilenceChips } from '@shared/cutlord'

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
  // review
  segments: { id: string; words: { id: string; text: string; start: number; end: number }[] }[]
  chipAfter: Map<string, { durS: number; stagedId?: string; applied?: boolean }>
  isSelected: (id: string) => boolean
  /** committed (already-executed) cut — word.deleted in the transcript. */
  isDeleted: (id: string) => boolean
  isChipSel: (stagedId?: string) => boolean
  smartSilence: boolean
  /** count of committed (executed) word cuts still in effect. */
  deletedCount: number
  // actions
  find: () => void
  /** Retake δ (Delta): run the analysis with the creator's own HF-router model. */
  findDelta: () => void
  execute: () => void
  restore: () => void
  clear: () => void
  selectWord: (id: string, additive: boolean, rangeTo?: string) => void
  toggleChip: (id: string) => void
  /** toggle a committed cut (restore a struck word, or cut a kept one) — live. */
  toggleWord: (id: string) => void
  openSilenceSettings: () => void
  setSmartSilence: (v: boolean) => void
}

export function useRetake(): RetakeModel {
  const transcript = useStore((s) => s.project.transcript)
  const projSilences = useStore((s) => s.project.silences)
  const job = useStore((s) => s.job)
  const selected = useStore((s) => s.selectedWordIds)
  const staged = useStore((s) => s.stagedSilences)
  const stagedSel = useStore((s) => s.stagedSilenceSel)
  const smartSilence = useStore((s) => s.smartSilenceCutter)
  const setSmartSilence = useStore((s) => s.setSmartSilenceCutter)
  const runRetakeCutBeta = useStore((s) => s.runRetakeCutBeta)
  const runRetakeCutDelta = useStore((s) => s.runRetakeCutDelta)
  const executeCuts = useStore((s) => s.executeCuts)
  const restoreSelected = useStore((s) => s.restoreSelected)
  const clearSelection = useStore((s) => s.clearSelection)
  const selectWord = useStore((s) => s.selectWord)
  const toggleStagedSilence = useStore((s) => s.toggleStagedSilence)
  const setShowSilenceSettings = useStore((s) => s.setShowSilenceSettings)
  const toggleWordDeleted = useStore((s) => s.toggleWordDeleted)

  // "executed" and "error" aren't distinct store flags, so the panel tracks the
  // last terminal transition locally (reset when a new analysis starts).
  const [executed, setExecuted] = useState(false)

  const failed = !job.active && job.percent === 0 && !!job.message && /fail|couldn|could not|didn/i.test(job.message)
  const hasResults = !!transcript && (selected.size > 0 || staged.length > 0)

  let state: RetakeState
  if (job.active) state = 'analyzing'
  else if (executed) state = 'executed'
  else if (failed && !transcript) state = 'error'
  else if (hasResults) state = 'results'
  else state = 'idle'

  const words = selected.size
  const selStaged = staged.filter((r) => stagedSel.has(r.id))
  const pauses = smartSilence ? selStaged.length : 0

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
  if (smartSilence) for (const r of selStaged) timeSavedS += Math.max(0, r.end - r.start)

  const chips = transcript ? buildSilenceChips(transcript.words, smartSilence ? staged : [], projSilences) : []
  const chipAfter = new Map(chips.map((c) => [c.afterWordId, c]))

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
    deletedCount: deletedIds.size,
    segments: transcript?.segments ?? [],
    chipAfter,
    isSelected: (id) => selected.has(id),
    isDeleted: (id) => deletedIds.has(id),
    isChipSel: (stagedId) => (stagedId ? stagedSel.has(stagedId) : false),
    smartSilence,
    find: () => { setExecuted(false); void runRetakeCutBeta() },
    findDelta: () => { setExecuted(false); void runRetakeCutDelta() },
    execute: () => { setExecuted(true); void executeCuts() },
    restore: () => restoreSelected(),
    clear: () => clearSelection(),
    selectWord,
    toggleChip: (id) => toggleStagedSilence(id),
    toggleWord: (id) => toggleWordDeleted(id),
    openSilenceSettings: () => setShowSilenceSettings(true),
    setSmartSilence
  }
}
