// Stage C — Retake Cleaner adapter (screens 1c + the 1b right panel).
// DERIVES the design's 6-state machine and summary tiles from existing store
// fields; ORCHESTRATES existing actions (runRetakeCutBeta / executeCuts /
// selectWord / …). Does not touch Retake β or silence-engine internals.

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
  // review
  segments: { id: string; words: { id: string; text: string; start: number; end: number }[] }[]
  /** montage-time boundaries of each source clip (empty for a single-clip base),
   *  so the transcript can stack each video's words under a labelled divider. */
  clipBounds: { startS: number; name: string }[]
  chipAfter: Map<string, { durS: number; stagedId?: string; applied?: boolean }>
  isSelected: (id: string) => boolean
  /** committed (already-executed) cut — word.deleted in the transcript. */
  isDeleted: (id: string) => boolean
  isChipSel: (stagedId?: string) => boolean
  /** Selected staged silences as plain spans. "Find Silences" needs NO transcript,
   *  so when there is none these are the only cuts there are to show — the chip
   *  path below is anchored to transcript words and yields nothing. */
  stagedSilenceCuts: { id: string; startS: number; endS: number }[]
  /** Source runtime, for the summary when there is no transcript to measure. */
  sourceDurationS: number
  /** count of committed (executed) word cuts still in effect. */
  deletedCount: number
  // actions
  /** run Retake Beta — Claude Opus on our official Anthropic key. */
  find: () => void
  /** Clean Silence — the Silence Mastery engine: keep the word timestamps,
   *  stage everything else as review-first cuts (transcribes first if needed). */
  findSilences: () => void
  /** open the Silence settings modal (min silence / pads / trim edges). */
  openSilenceSettings: () => void
  /** transcribe ONLY (the AssemblyAI step Retake β uses) — no judge/cuts. */
  transcribeOnly: () => void
  /** run Ultracut Beta — a SEPARATE OpenRouter test engine (GLM 5.2), for A/B. */
  findUltracut: () => void
  /** run Premium Cut — Gemini 3.5 Flash LISTENS to the audio (transcript + cuts). */
  findPremium: () => void
  execute: () => void
  /** cut the currently-selected words (executed-state "Cut selected"). */
  cutSelected: () => void
  restore: () => void
  clear: () => void
  selectWord: (id: string, additive: boolean, rangeTo?: string) => void
  toggleChip: (id: string) => void
  /** toggle a committed cut (restore a struck word, or cut a kept one) — live. */
  toggleWord: (id: string) => void
  /** seek the preview to a word's SOURCE start time (double-click) and play. */
  seekWord: (sourceStartS: number) => void
  /** Auto Zoom — ask Gemma which cut clips to punch-in, then apply the zooms. */
  autoZoom: () => void
  /** true while an Auto Zoom pass is running. */
  autoZooming: boolean
}

export function useRetake(): RetakeModel {
  const transcript = useStore((s) => s.project.transcript)
  const projSilences = useStore((s) => s.project.silences)
  const job = useStore((s) => s.job)
  const selected = useStore((s) => s.selectedWordIds)
  const staged = useStore((s) => s.stagedSilences)
  const stagedSel = useStore((s) => s.stagedSilenceSel)
  // "Retake Beta" runs the REAL Retake β (runRetakeCutBeta → procut-judge, Opus on
  // our official Anthropic key): the production-artifact-aware prompt that removes
  // slates / count-ins / off-camera direction / intro-outro chatter and cuts whole
  // takes precisely (never mid-sentence, only-copy untouchable). (Retake δ /
  // delta-judge was removed — its narrow whole-take prompt left intro/outro +
  // off-camera chatter behind and over-cut wide spans.)
  const runRetakeCutBeta = useStore((s) => s.runRetakeCutBeta)
  const runSilenceMastery = useStore((s) => s.runSilenceMastery)
  const setShowSilenceMasterySettings = useStore((s) => s.setShowSilenceMasterySettings)
  const transcribeOnly = useStore((s) => s.transcribeOnly)
  // Ultracut Beta — a separate OpenRouter test engine, wired to its own button.
  const runUltracut = useStore((s) => s.runUltracut)
  // Premium Cut — Gemini 3.5 Flash multimodal engine, wired to its own button.
  const runPremiumCut = useStore((s) => s.runPremiumCut)
  const runAutoZoom = useStore((s) => s.runAutoZoom)
  const autoZoomBusy = useStore((s) => s.autoZoomBusy)
  const executeCuts = useStore((s) => s.executeCuts)
  const restoreSelected = useStore((s) => s.restoreSelected)
  const deleteSelected = useStore((s) => s.deleteSelected)
  const clearSelection = useStore((s) => s.clearSelection)
  const selectWord = useStore((s) => s.selectWord)
  const toggleStagedSilence = useStore((s) => s.toggleStagedSilence)
  const toggleWordDeleted = useStore((s) => s.toggleWordDeleted)
  const setPlayhead = useStore((s) => s.setPlayhead)
  const setPlaying = useStore((s) => s.setPlaying)
  const hasTimeline = useStore((s) => !!s.project.timeline)

  // committed cuts (word.deleted) — struck-through in the executed-state review.
  const deletedIds = new Set<string>()
  if (transcript) for (const w of transcript.words) if (w.deleted) deletedIds.add(w.id)

  const failed = !job.active && job.percent === 0 && !!job.message && /fail|couldn|could not|didn/i.test(job.message)
  // NOT gated on a transcript: FSMN "Find Silences" stages cuts without ever
  // transcribing, and requiring one here dropped the panel straight back to its
  // idle screen — the silences were found and staged, but nothing was rendered.
  const hasResults = selected.size > 0 || staged.length > 0

  // The panel is in the EXECUTED review whenever committed cuts exist — no matter
  // HOW they were applied (the panel's Execute button, the import wizard, or a
  // re-opened project). Deriving this from the transcript itself (not a local
  // flag the wizard never sets) is what makes the applied cuts + the transcript
  // show up after an import / reopen instead of the empty "Find Retakes" screen.
  // Only a CUT job puts this panel in "Finding cuts…". An export, upload or probe
  // is also an active job, and claiming those made a render report itself here as
  // "Finding cuts… / Rendering frames…"; those own their own UI (the centered
  // CutProgressOverlay), so the panel keeps showing its results underneath.
  const cutJob = job.active && (job.kind === 'transcribe' || job.kind === 'silence' || job.kind === undefined)

  let state: RetakeState
  if (cutJob) state = 'analyzing'
  else if (failed && !transcript) state = 'error'
  // A LIVE review (freshly staged words or silences) outranks the executed
  // view. With 'executed' first, running Clean Silence (or a second Find
  // cuts) on a project that ALREADY has committed cuts staged its regions
  // into a state the panel never showed — no cards, no Apply button — so the
  // run looked like it did nothing and the silences stayed in the video.
  else if (hasResults) state = 'results'
  else if (deletedIds.size > 0) state = 'executed'
  // ALWAYS SHOW TRANSCRIPT: once a transcript exists (a run finished — even with 0
  // retakes, or a judge rate-limit where STT still succeeded), show it in the review
  // instead of falling back to the idle "Find Retakes & Silence" screen. A fresh
  // project with no transcript still shows idle.
  else if (transcript && transcript.words.some((w) => w.text.trim())) state = 'executed'
  else state = 'idle'

  const words = selected.size
  const selStaged = staged.filter((r) => stagedSel.has(r.id))
  const pauses = selStaged.length

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

  // Per-video boundaries in montage seconds (cumulative trimmed source durations),
  // used to group the montage transcript back into each imported video, in order.
  const baseSeq = useStore.getState().project.baseSequence
  const clipBounds: { startS: number; name: string }[] = []
  if (baseSeq && baseSeq.length > 1) {
    let acc = 0
    baseSeq.forEach((c, i) => {
      clipBounds.push({ startS: acc, name: c.name?.replace(/\.[^.]+$/, '') || `Video ${i + 1}` })
      acc += Math.max(0, (c.sourceOut ?? 0) - (c.sourceIn ?? 0))
    })
  }

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
    clipBounds,
    chipAfter,
    isSelected: (id) => selected.has(id),
    isDeleted: (id) => deletedIds.has(id),
    isChipSel: (stagedId) => (stagedId ? stagedSel.has(stagedId) : false),
    stagedSilenceCuts: selStaged.map((r) => ({ id: r.id, startS: r.start, endS: r.end })),
    sourceDurationS: useStore.getState().project.media?.duration ?? 0,
    find: () => void runRetakeCutBeta(),
    findSilences: () => void runSilenceMastery(),
    openSilenceSettings: () => setShowSilenceMasterySettings(true),
    transcribeOnly: () => void transcribeOnly(),
    findUltracut: () => void runUltracut(),
    findPremium: () => void runPremiumCut(),
    execute: () => void executeCuts(),
    /** cut the currently-selected words (used to add cuts in the executed review). */
    cutSelected: () => deleteSelected(),
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
    autoZoom: () => void runAutoZoom(),
    autoZooming: autoZoomBusy
  }
}
