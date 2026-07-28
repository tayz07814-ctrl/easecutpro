// Batch Video Cleaner — CLOUD path (0.01 web build, no PC server).
//
// The desktop batch (batchClean.ts) transcribes + removes fillers + detects
// silence through window.api's /api/* endpoints. Those don't exist in the Vercel
// cloud deploy (vercel.json only routes /edge/:fn; every other path rewrites to
// the static index.html), so POSTing /api/transcribe or /api/silence hit a static
// asset and return HTTP 405 — the "batch cleaner 405" the dashboard showed.
//
// This runs the SAME cloud Cut Lord the editor's Retake button uses
// (retakeAwareCutCloud: browser audio decode → ultracut-judge edge fn → the
// unified VAD silence pass) and bakes its result into a headless Project. No
// mounted timeline is required: the cleaned base is DERIVED from the deleted
// transcript words + project.silences by computeKeepRanges (shared/edit.ts), so
// opening the project shows the cleaned timeline and export stitches the kept
// ranges — exactly like the desktop batch, minus the /api round-trips.

import type { Project, Word } from '@shared/types'
import { createEmptyProject } from '@shared/project'
import type { VadSilenceSettings } from '@shared/vadsilence'
import { retakeAwareCutCloud } from './retakeEngine'

/** Clean one imported clip (a `webmedia:` id) into a Project + preview thumb,
 *  using the cloud retake+silence engine. Silence obeys the passed VAD profile
 *  (the store's vadSilenceSettings — the same presets the Silence Settings modal
 *  drives). */
export async function cleanVideoCloud(
  mediaId: string,
  name: string,
  vadSettings: VadSilenceSettings,
  onStep: (step: string) => void
): Promise<{ project: Project; thumb?: string }> {
  onStep('Reading video…')
  // webmedia ids resolve locally in window.api.probe/thumbnails — no /api call.
  const info = await window.api.probe(mediaId)
  const project = createEmptyProject(name.replace(/\.[^.]+$/, ''))
  project.media = {
    path: mediaId,
    duration: info.duration,
    width: info.width,
    height: info.height,
    fps: info.fps,
    hasAudio: info.hasAudio,
    hasVideo: info.hasVideo
  }

  // Cloud Cut Lord: transcribe → LLM retake cut → VAD silence, all in the browser
  // + the /edge judge. Progress messages ("Cleaning silence…", etc.) surface as
  // the job step. This REPLACES the desktop fillers-list + /api/silence path.
  const res = await retakeAwareCutCloud(mediaId, (_pct, msg) => msg && onStep(msg), vadSettings)

  // Bake the retake word-cuts into the transcript (deleted words) and the VAD
  // silences into project.silences — the two fields computeKeepRanges reads.
  const del = new Set(res.deleteWordIds)
  const mark = (w: Word): Word => (del.has(w.id) ? { ...w, deleted: true } : w)
  project.transcript = {
    words: res.transcript.words.map(mark),
    segments: res.transcript.segments.map((seg) => ({ ...seg, words: seg.words.map(mark) }))
  }
  // vadSilenceRegions already returns word-clamped { action:'remove', protect:true }
  // regions, so they drop straight into the project.
  project.silences = res.silenceRegions

  // Best-effort preview thumbnail (local for webmedia ids).
  let thumb: string | undefined
  if (info.hasVideo) {
    try {
      const ths = await window.api.thumbnails(mediaId, Math.max(1, info.duration || 1))
      thumb = ths[0]?.url
    } catch {
      /* a missing thumbnail is fine */
    }
  }

  return { project, thumb }
}
