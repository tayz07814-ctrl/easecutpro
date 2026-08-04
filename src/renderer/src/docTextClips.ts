// Doc-native text clips. In the new UI the timeline document (project.timeline)
// is authoritative and text is stored as `kind: 'text'` clips on a text track —
// NOT project.texts, which only render in the legacy preview. TextLayer/export
// read the DOCUMENT in doc mode, so Add text, auto-captions and the Edit
// inspector must all create/edit these doc text clips. Mirrors the proven logic
// in TextPanel.tsx (kept here dependency-free so the store can use it too).

import { getSharedEngine } from './timelineEngine'
import { createClip } from '@shared/timeline/model'
import { secondsToFrames } from '@shared/timeline/time'
import * as C from '@shared/timeline/commands'
import type { Command } from '@shared/timeline/commands'
import type { TextContent, TimelineDocument } from '@shared/timeline/types'
import { getDefaultFont } from './customFonts'

export function defaultTextContent(): TextContent {
  return {
    text: 'Your text',
    // Honour the user's uploaded default font (falls back to the built-in) so new
    // text AND captions pick it up automatically.
    fontFamily: getDefaultFont() || 'Arial Black',
    fontSize: 0.08,
    color: '#ffffff',
    align: 'center',
    bold: true,
    italic: false,
    underline: false,
    strokeWidth: 0.06,
    strokeColor: '#000000',
    background: { enabled: false, color: '#000000', opacity: 1, radius: 0.3, padding: 0.3 },
    shadow: { enabled: false, color: '#000000', blur: 0, dx: 0, dy: 0 },
    letterSpacing: 0,
    lineHeight: 1.2
  }
}

export interface DocTextSpec {
  text: string
  /** EDITED-timeline seconds. */
  startS: number
  endS: number
  /** centre position as a fraction of the frame (default 0.5 / 0.8). */
  x?: number
  y?: number
  content?: Partial<TextContent>
  /** tag so a caption batch can be replaced/cleared without touching hand text. */
  caption?: boolean
}

/** Reuse the existing text lane, or spawn one above everything. */
function ensureTextTrack(doc: TimelineDocument, cmds: Command[]): string {
  const existing = doc.tracks.find((t) => t.kind === 'text' && !t.isMain)
  if (existing) return existing.id
  const order = Math.min(0, ...doc.tracks.map((t) => t.order)) - 1
  const id = `txt-${Date.now().toString(36)}`
  cmds.push(C.addTrack('text', { id, order }))
  return id
}

/** Add text clips to the document's text lane in one undoable batch. Returns the
 *  new clip ids; optionally selects a single one (so the Edit inspector opens). */
export function addDocTexts(items: DocTextSpec[], select = false): string[] {
  const engine = getSharedEngine()
  if (!engine || !items.length) return []
  const doc = engine.document
  const tb = doc.timebase
  const cmds: Command[] = []
  const trackId = ensureTextTrack(doc, cmds)
  const ids: string[] = []
  for (const it of items) {
    const clip = createClip({
      kind: 'text',
      trackId,
      name: it.caption ? 'Caption' : 'Text',
      start: secondsToFrames(it.startS, tb),
      duration: secondsToFrames(Math.max(0.3, it.endS - it.startS), tb),
      // it.text is the actual string (caption line / "Your text"); it.content is
      // styling only. Previously it.text was dropped, so every caption rendered
      // the default "Your text" — force it.text to win over the default.
      text: { ...defaultTextContent(), ...it.content, text: it.text }
    })
    clip.transform = {
      ...clip.transform,
      x: { ...clip.transform.x, static: (it.x ?? 0.5) - 0.5 },
      y: { ...clip.transform.y, static: (it.y ?? 0.8) - 0.5 }
    }
    if (it.caption) clip.metadata = { ...clip.metadata, caption: true }
    cmds.push(C.addClip(clip))
    ids.push(clip.id)
  }
  engine.batch(items.length > 1 ? 'Add captions' : 'Add text', cmds)
  if (select && ids.length === 1) engine.select([ids[0]])
  return ids
}

/** Remove every caption-tagged text clip. Returns the count removed. */
export function removeCaptionTexts(): number {
  const engine = getSharedEngine()
  if (!engine) return 0
  const doc = engine.document
  const ids: string[] = []
  for (const t of doc.tracks) if (t.kind === 'text') for (const c of t.clips) if (c.metadata?.caption) ids.push(c.id)
  if (ids.length) engine.batch('Clear captions', ids.map((id) => C.removeClip(id)))
  return ids.length
}

/** Push one look onto every caption clip in a single undo step. Captions arrive
 *  as dozens of clips, so restyling them one at a time is not a thing anyone
 *  would do — the Edit tab offers this the moment a caption is selected.
 *  Returns how many clips changed. */
export function applyStyleToAllCaptions(style: Partial<TextContent>): number {
  const engine = getSharedEngine()
  if (!engine) return 0
  const ids: string[] = []
  for (const t of engine.document.tracks) if (t.kind === 'text') for (const c of t.clips) if (c.metadata?.caption) ids.push(c.id)
  if (ids.length) engine.batch('Restyle captions', ids.map((id) => C.setClipText(id, style)))
  return ids.length
}

/** Count caption-tagged text clips in a document. */
export function countCaptionTexts(doc: TimelineDocument | undefined): number {
  if (!doc) return 0
  let n = 0
  for (const t of doc.tracks) if (t.kind === 'text') for (const c of t.clips) if (c.metadata?.caption) n++
  return n
}
