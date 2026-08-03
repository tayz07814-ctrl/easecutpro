// Batch Video Cleaner pipeline.
//
// Turns one raw video into a ready-to-edit, already-cleaned Project WITHOUT
// touching the editor's open project: transcribe -> mark fillers/repeats deleted.
// (No silence pass — every silence engine was removed from this branch.) The
// cleaned base track is then DERIVED from these fields by computeKeepRanges()
// (see src/shared/edit.ts), so opening the project shows the cleaned timeline
// and export stitches the kept ranges.
//
// Works on both desktop (real paths) and web (webmedia ids): window.api.*
// abstracts the difference, uploading lazily on transcribe as needed.
import type { Project, Transcript } from '@shared/types'
import { createEmptyProject } from '@shared/project'
import { detectCleanupIds } from '@shared/fillers'

export type BatchStep = (step: string) => void

/** Clean one video into a Project + optional preview thumbnail. */
export async function cleanVideo(
  path: string,
  name: string,
  fillerWords: string[],
  onStep: BatchStep
): Promise<{ project: Project; thumb?: string }> {
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

  // --- Transcription-based removal (fillers, stutters, repeats) ---
  onStep('Transcribing…')
  const transcript: Transcript = await window.api.transcribe(path)
  const removeIds = new Set(detectCleanupIds(transcript, fillerWords))
  project.transcript = {
    words: transcript.words.map((w) => (removeIds.has(w.id) ? { ...w, deleted: true } : w)),
    segments: transcript.segments.map((seg) => ({
      ...seg,
      words: seg.words.map((w) => (removeIds.has(w.id) ? { ...w, deleted: true } : w))
    }))
  }

  // --- Best-effort preview thumbnail (desktop; web returns [] for local media) ---
  let thumb: string | undefined
  if (info.hasVideo) {
    try {
      const ths = await window.api.thumbnails(path, Math.max(1, info.duration || 1))
      thumb = ths[0]?.url
    } catch {
      /* a missing thumbnail is fine */
    }
  }

  return { project, thumb }
}
