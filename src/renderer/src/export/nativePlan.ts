// Native (Android) full export planner — builds the Media3 composition spec from
// the timeline and hands it to the native encoder. On Android this is the ONLY
// export path (no WebCodecs fallback): base video (trim + concat, audio kept),
// captions/text baked to full-frame bitmaps and composited by the native encoder,
// and extra audio tracks (music / voiceover) mixed in.
//
// Throws a clear error when it can't proceed (missing native file path, an image
// on the main track, no timeline) so the UI shows a real reason instead of a
// silent wrong output. Web/desktop never call this (they keep the WebCodecs path).

import type { Project } from '@shared/types'
import { getSharedEngine } from '../timelineEngine'
import { planFromDoc } from './localExport'
import { nativePathFor } from '../webmedia'
import { documentToProject } from '@shared/timeline/bridge'
import { renderTextPng } from '../textRender'
import {
  hasNativeExport,
  nativeExportReady,
  nativeExport,
  type NativeExportSpec,
  type NativeOverlay,
  type NativeAudioTrack
} from '../cloud/nativeExport'

export { hasNativeExport }

export interface NativeExportOutcome {
  savedTo?: string
  path: string
}

/** Bake the project's captions/text to timed full-frame PNG overlays (output res). */
function bakeCaptions(project: Project, width: number, height: number): NativeOverlay[] {
  const proj = project.timeline ? documentToProject(project.timeline, project) : project
  const out: NativeOverlay[] = []
  for (const t of proj.texts ?? []) {
    if (t.end - t.start <= 0.05 || !(t.text ?? '').trim()) continue
    const dataUrl = renderTextPng(t, width, height)
    const base64 = dataUrl.split(',')[1] ?? ''
    if (!base64) continue
    out.push({ base64, startMs: Math.round(t.start * 1000), endMs: Math.round(t.end * 1000) })
  }
  return out
}

/**
 * Run the full native export. Resolves with the gallery location, or throws with a
 * human-readable reason. Android-only (guarded by hasNativeExport()).
 */
export async function nativeExportFull(
  project: Project,
  settings: { width: number; height: number; bitrateMbps: number },
  filename: string,
  onProgress: (pct: number, msg: string) => void
): Promise<NativeExportOutcome> {
  const doc = getSharedEngine()?.document
  if (!doc) throw new Error('timeline not ready')

  const { segs, audio } = planFromDoc(doc, project)
  if (!segs.length) throw new Error('nothing on the timeline to export')

  // Base video segments — must be native-imported video (no in-browser decode).
  const segments = segs.map((s) => {
    if (s.isImage) {
      throw new Error('images on the main track aren’t supported by native export yet — remove them or re-add as video')
    }
    const path = nativePathFor(s.src)
    if (!path) {
      throw new Error('a source video isn’t available for native export — re-import it in the app')
    }
    const startMs = Math.max(0, Math.round(s.sourceStart * 1000))
    const endMs = Math.round(s.sourceEnd * 1000)
    return { uri: 'file://' + path, startMs, endMs: endMs > startMs ? endMs : startMs + 1 }
  })

  // Extra audio tracks (music / voiceover) that were natively imported.
  const audioTracks: NativeAudioTrack[] = []
  for (const a of audio) {
    const path = nativePathFor(a.src)
    if (!path) continue // can't include a non-native source; skip rather than fail the whole export
    const startMs = Math.max(0, Math.round(a.sourceIn * 1000))
    const endMs = Math.round((a.sourceIn + a.dur) * 1000)
    audioTracks.push({ uri: 'file://' + path, startMs, endMs: endMs > startMs ? endMs : startMs + 1 })
  }

  const captions = bakeCaptions(project, settings.width, settings.height)

  if (!(await nativeExportReady())) throw new Error('native export module isn’t responding')

  onProgress(3, 'Exporting with native codecs…')
  const spec: NativeExportSpec = {
    segments,
    captions,
    audioTracks,
    width: settings.width,
    height: settings.height,
    filename
  }
  const res = await nativeExport(spec, (p) =>
    onProgress(Math.max(3, Math.min(99, 3 + Math.round(p * 0.96))), 'Exporting with native codecs…')
  )
  onProgress(100, res.savedTo ? `Saved to ${res.savedTo}` : 'Export complete')
  return { savedTo: res.savedTo, path: res.path }
}
