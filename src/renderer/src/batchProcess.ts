// Batch Processing pipeline — the RETAKE-aware sibling of batchClean.ts.
//
// Turns one raw video into a ready-to-edit, already-cleaned Project WITHOUT
// touching the editor's open project (state.project). Where batchClean's
// cleanVideo runs fillers + repeats + silence, this runs the SAME retake engine
// the "Find Retakes & Silence" button uses (window.api.retakeAwareCut →
// procut-judge, the production judge) and then APPLIES its proposal headlessly:
// the flagged words become word.deleted and the word-clamped silence regions
// become project.silences with action:'remove'. The cleaned base track is then
// DERIVED from these fields by computeKeepRanges() (see src/shared/edit.ts), so
// opening the project shows the cleaned timeline and export stitches the kept
// ranges — exactly as if the user had pressed Execute cuts.
//
// This mirrors Retake Final Boss (stage) + executeCuts (apply) from the store,
// but writes into an off-screen Project object so many files can be processed
// one-by-one without thrashing the live editor.
import type { Project } from '@shared/types'
import { createEmptyProject } from '@shared/project'
import type { RetakeFinalBossSettings } from '@shared/retakefinalboss'

export type BatchStep = (step: string) => void

export interface RetakeCleanOptions {
  finalBossSettings: RetakeFinalBossSettings
  /** word-splice trim (frames of extra padding around a word cut) from the
   *  Cut Lord profile — mirrors executeCuts' `wordCutPad(cutLordSettings)`. */
  wordCutPad: number
}

/** Clean one video into a Project + optional preview thumbnail using the retake
 *  engine, then apply the proposal (word.deleted + silences) headlessly. */
export async function retakeCleanVideo(
  path: string,
  name: string,
  opts: RetakeCleanOptions,
  onStep: BatchStep
): Promise<{ project: Project; thumb?: string; wordsCut: number; silencesCut: number }> {
  onStep('Reading video…')
  const info = await window.api.probe(path)
  const project = createEmptyProject(name.replace(/\.[^.]+$/, ''))
  project.media = {
    path,
    duration: info.duration,
    width: info.width,
    height: info.height,
    fps: info.fps,
    hasAudio: info.hasAudio,
    hasVideo: info.hasVideo
  }

  // --- Retake Final Boss: AssemblyAI -> Gemma -> fresh VAD ---
  // The engine owns the complete transcribe → judge → silence
  // pipeline; it emits its own progress through window.api.onProgress, but we
  // surface a coarse label here so the queue row shows life.
  onStep('Finding retakes & silence…')
  const res = await window.api.retakeAwareCut(path, undefined, opts.finalBossSettings)

  // --- Apply the proposal headlessly (mirror of executeCuts) ---
  // The engine ALWAYS returns its full verbatim transcript; the flagged ids
  // index into it. Mark exactly those words deleted (never splice / trim words
  // out of the transcript — the same review-first contract, just auto-accepted).
  onStep('Applying cuts…')
  const del = new Set(res.deleteWordIds)
  const mark = <W extends { id: string }>(w: W): W => (del.has(w.id) ? { ...w, deleted: true } : w)
  project.transcript = {
    words: res.transcript.words.map(mark),
    segments: res.transcript.segments.map((seg) => ({ ...seg, words: seg.words.map(mark) }))
  }

  // Final Boss always applies the fresh post-Gemma VAD proposal.
  const regions = res.silenceRegions ?? []
  project.silences = regions.map((r) => ({ ...r, action: 'remove' as const })).sort((a, b) => a.start - b.start)

  // Match executeCuts' export-time settings so a batch project cuts and fades
  // identically to one cleaned by hand.
  project.wordCutPad = opts.wordCutPad
  project.smoothAudioFadeMs = opts.finalBossSettings.audioOverlapMs

  // --- Best-effort preview thumbnail (web returns [] for local media on some paths) ---
  let thumb: string | undefined
  if (info.hasVideo) {
    try {
      const ths = await window.api.thumbnails(path, Math.max(1, info.duration || 1))
      thumb = ths[0]?.url
    } catch {
      /* a missing thumbnail is fine — the card falls back to a neutral tile */
    }
  }

  return { project, thumb, wordsCut: del.size, silencesCut: regions.length }
}
