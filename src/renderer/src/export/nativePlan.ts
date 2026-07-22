// Native (Android) hardware-codec export planner.
//
// The on-device WebCodecs exporter decodes/re-encodes every frame by seeking a
// <video> — correct, but slow on a phone WebView and memory-heavy (the source of
// the "0→52%→restart" grind). For the COMMON case — a plain cut: trim + join base
// video clips, no text/overlays/speed/Ken Burns/added audio — Media3 Transformer
// does the same job with the device's hardware codecs in a fraction of the time,
// exactly like CapCut.
//
// This module decides whether the current timeline is that simple case and, if so,
// hands Media3 a list of {sourceFile, in, out} segments. Anything fancier returns
// null so the caller keeps the proven WebCodecs path. Native-only: every guard
// fails closed on web/desktop, so the browser export is untouched.

import type { Project } from '@shared/types'
import { getSharedEngine } from '../timelineEngine'
import { planFromDoc } from './localExport'
import { nativePathFor } from '../webmedia'
import { hasNativeExport, nativeExportReady, nativeExport } from '../cloud/nativeExport'

const EPS = 1e-3
const isOne = (v: number): boolean => Math.abs(v - 1) < EPS
const isZero = (v: number): boolean => Math.abs(v) < EPS

export interface NativeCutResult {
  savedTo?: string
  path: string
}

/**
 * Try a native trim+concat export of the current timeline. Returns the result on
 * success, or null when the project isn't a plain cut (caller must fall back to the
 * WebCodecs exporter). Never throws for ineligibility — only a genuine native
 * failure rejects.
 */
export async function tryNativeCutExport(
  project: Project,
  filename: string,
  onProgress: (pct: number, msg: string) => void
): Promise<NativeCutResult | null> {
  if (!hasNativeExport()) return null
  const doc = getSharedEngine()?.document
  if (!doc) return null

  // Only the MAIN track may carry clips. Any audio lane, video overlay, text, or
  // sticker track with clips means compositing is needed → WebCodecs path.
  const main = doc.tracks.find((t) => t.isMain)
  if (!main || !main.clips.length) return null
  for (const t of doc.tracks) {
    if (t === main) continue
    if (t.clips && t.clips.length) return null
  }
  // Added music also needs mixing.
  if (project.music?.path) return null
  // Baked text overlays (legacy field) need compositing too.
  if (project.texts && project.texts.some((t) => t.text?.trim())) return null

  const { segs, audio, total } = planFromDoc(doc, project)
  if (!segs.length || total <= 0) return null
  if (audio.length) return null // any separate audio clip → mix in WebCodecs

  // Every base clip must be a plain, untransformed video slice whose source was
  // imported natively (so a real file path exists for Media3 to read).
  const segments: { uri: string; startMs: number; endMs: number }[] = []
  for (const s of segs) {
    if (s.isImage) return null
    if (!isOne(s.speed)) return null
    if (s.muted) return null
    if (!isOne(s.gain)) return null
    // No Ken Burns / crop / overlay transform.
    if (!isOne(s.size) || !isOne(s.zs) || !isOne(s.ze) || !isZero(s.ox) || !isZero(s.oy)) return null
    const nativePath = nativePathFor(s.src)
    if (!nativePath) return null
    const startMs = Math.max(0, Math.round(s.sourceStart * 1000))
    const endMs = Math.round(s.sourceEnd * 1000)
    if (endMs <= startMs) return null
    segments.push({ uri: 'file://' + nativePath, startMs, endMs })
  }
  if (!segments.length) return null

  // Confirm the native module actually answers before committing to it.
  if (!(await nativeExportReady())) return null

  onProgress(3, 'Exporting with native codecs…')
  // Map the native encoder's 0–100 onto 3–99 so the bar animates during the encode.
  const res = await nativeExport(segments, filename, (p) =>
    onProgress(Math.max(3, Math.min(99, 3 + Math.round(p * 0.96))), 'Exporting with native codecs…')
  )
  onProgress(100, res.savedTo ? `Saved to ${res.savedTo}` : 'Export complete')
  return { savedTo: res.savedTo, path: res.path }
}
