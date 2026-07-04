// Bridge: convert the app's existing `Project` (single media / montage
// baseSequence / overlay tracks / texts / music) into a clip-based
// TimelineDocument the new timeline renders. Times in the old model are SECONDS;
// they convert to frames at the project's timebase. This produces the timeline
// STRUCTURE (tracks + clips with correct source refs + timing) so the media
// managers can pull real waveforms/thumbnails by sourcePath. Pure & headless.

import type { Project, TextClip, SequenceClip, Clip as LegacyClip, Track as LegacyTrack } from '../types'
import type { Clip, TextContent, TimelineDocument } from './types'
import {
  createTimeline,
  createTrack,
  createClip,
  addTrackToDoc,
  addClipToDoc,
  findTrack,
  mainTrackId
} from './model'
import { timebaseFromFps, secondsToFrames, framesToSeconds, fps } from './time'
import { computeKeepRanges, virtualKeepsToClipSegments } from '../edit'

/** Overlay placement carried on the doc clip's metadata (legacy overlay semantics:
 *  x/y = top-left fraction, scale = width fraction, zoomStart/End = Ken Burns). The
 *  crop lives on the first-class clip.crop. Round-trips via legacyClipFrom. */
function overlayMetadata(c: LegacyClip): Record<string, string | number | boolean> {
  const m: Record<string, string | number | boolean> = {
    ovX: c.x ?? 0,
    ovY: c.y ?? 0,
    ovScale: c.scale ?? 0.45,
    ovZoomStart: c.zoomStart ?? 1,
    ovZoomEnd: c.zoomEnd ?? 1
  }
  if (c.overlayRuleId) m.overlayRuleId = c.overlayRuleId
  if (c.overlayAnimation) m.overlayAnimation = c.overlayAnimation
  if (c.overlayReason) m.overlayReason = c.overlayReason
  return m
}

function textContentFrom(t: TextClip): TextContent {
  return {
    text: t.text,
    fontFamily: t.fontFamily,
    fontSize: t.fontSize,
    color: t.color,
    align: t.align,
    bold: t.bold,
    italic: t.italic,
    underline: false,
    strokeWidth: t.strokeWidth,
    strokeColor: t.strokeColor,
    background: {
      enabled: t.bgEnabled,
      color: t.bgColor,
      opacity: t.bgOpacity,
      radius: t.bgRadius,
      padding: t.bgPadding
    },
    shadow: { enabled: false, color: '#000000', blur: 0, dx: 0, dy: 0 },
    letterSpacing: 0,
    lineHeight: 1.2
  }
}

export function projectToDocument(project: Project): TimelineDocument {
  const fps = project.media?.fps ?? project.baseSequence?.[0]?.fps ?? 30
  const tb = timebaseFromFps(fps)
  const s2f = (s: number): number => secondsToFrames(s, tb)
  let doc = createTimeline(tb)
  let order = 0

  // 1. text lane (top)
  const texts = project.texts ?? []
  if (texts.length) {
    const tId = 'br-text'
    doc = addTrackToDoc(doc, createTrack({ kind: 'text', order: order++, id: tId, name: 'Text' }))
    for (const t of texts) {
      const clip = createClip({
        kind: 'text',
        trackId: tId,
        start: s2f(t.start),
        duration: Math.max(1, s2f(t.end - t.start)),
        name: t.text || 'Text',
        text: textContentFrom(t)
      })
      // legacy text x/y are CENTER fractions; the doc transform stores offset-from-centre.
      clip.transform = { ...clip.transform, x: { static: t.x - 0.5 }, y: { static: t.y - 0.5 } }
      doc = addClipToDoc(doc, clip)
    }
  }

  // 2. overlay lanes = project.tracks with index >= 1. Rendered EVEN WHEN EMPTY,
  //    so a fresh project shows the app's default lanes (base + 2 overlays).
  const overlays = [...(project.tracks ?? [])].filter((tr) => tr.index >= 1).sort((a, b) => a.index - b.index)
  for (const ot of overlays) {
    const tId = 'br-ov-' + ot.id
    doc = addTrackToDoc(doc, createTrack({ kind: 'video', order: order++, id: tId, name: ot.name || `Overlay ${ot.index}` }))
    for (const c of ot.clips) {
      const clip = createClip({
        kind: c.isImage ? 'image' : 'video',
        trackId: tId,
        start: s2f(c.start),
        duration: Math.max(1, s2f(c.sourceOut - c.sourceIn)),
        sourcePath: c.sourcePath,
        sourceIn: c.sourceIn,
        sourceOut: c.sourceOut,
        sourceDuration: c.sourceDuration,
        srcW: c.srcW,
        srcH: c.srcH,
        name: c.name,
        hasAudio: !c.isImage,
        metadata: overlayMetadata(c)
      })
      clip.crop = { left: c.crop?.l ?? 0, top: c.crop?.t ?? 0, right: c.crop?.r ?? 0, bottom: c.crop?.b ?? 0 }
      doc = addClipToDoc(doc, clip)
    }
  }

  // 3. MAIN lane = the CUT RESULT (computeKeepRanges), so FastCut / ProCut /
  //    word-cuts show up. Each kept segment becomes one already-trimmed clip,
  //    laid out gaplessly = the final edit.
  const mainId = 'br-main'
  doc = addTrackToDoc(doc, createTrack({ kind: 'video', order: order++, id: mainId, name: 'Main', isMain: true }))
  // computeKeepRanges expects the cut arrays present; guard a malformed project.
  const safe: Project = {
    ...project,
    silences: project.silences ?? [],
    manualCuts: project.manualCuts ?? [],
    keepOverrides: project.keepOverrides ?? [],
    baseSplits: project.baseSplits ?? []
  }
  const keeps = computeKeepRanges(safe)
  let cursor = 0
  if (project.baseSequence && project.baseSequence.length) {
    for (const seg of virtualKeepsToClipSegments(safe, keeps)) {
      const dur = Math.max(1, s2f(seg.out - seg.in))
      doc = addClipToDoc(
        doc,
        createClip({
          kind: seg.isImage ? 'image' : 'video',
          trackId: mainId,
          start: cursor,
          duration: dur,
          sourcePath: seg.sourcePath,
          sourceIn: seg.in,
          sourceOut: seg.out,
          srcW: seg.srcW,
          srcH: seg.srcH,
          name: 'clip',
          hasAudio: seg.hasAudio
        })
      )
      cursor += dur
    }
  } else if (project.media) {
    const m = project.media
    for (const k of keeps) {
      const dur = Math.max(1, s2f(k.end - k.start))
      doc = addClipToDoc(
        doc,
        createClip({
          kind: 'video',
          trackId: mainId,
          start: cursor,
          duration: dur,
          sourcePath: m.path,
          sourceIn: k.start,
          sourceOut: k.end,
          sourceDuration: m.duration,
          srcW: m.width,
          srcH: m.height,
          srcFps: m.fps,
          name: project.name || 'Video',
          hasAudio: m.hasAudio
        })
      )
      cursor += dur
    }
  }

  // 4. music lane (below)
  if (project.music) {
    const mu = project.music
    const aId = 'br-music'
    doc = addTrackToDoc(doc, createTrack({ kind: 'audio', order: order++, id: aId, name: mu.name || 'Music' }))
    const durSec = (mu.endAt ?? mu.startAt + mu.duration) - mu.startAt
    doc = addClipToDoc(
      doc,
      createClip({
        kind: 'audio',
        trackId: aId,
        start: s2f(mu.startAt),
        duration: Math.max(1, s2f(durSec)),
        sourcePath: mu.path,
        sourceIn: 0,
        sourceOut: mu.duration,
        sourceDuration: mu.duration,
        name: mu.name,
        hasAudio: true,
        gain: mu.gain
      })
    )
  }

  return doc
}

function legacyClipFrom(c: Clip, f2s: (f: number) => number): LegacyClip {
  const m = c.metadata ?? {}
  const num = (v: unknown, d: number): number => (typeof v === 'number' ? v : d)
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  return {
    id: c.id,
    name: c.name,
    sourcePath: c.sourcePath ?? '',
    sourceIn: c.sourceIn,
    sourceOut: c.sourceOut,
    sourceDuration: c.sourceDuration,
    isImage: c.kind === 'image',
    srcW: c.srcW,
    srcH: c.srcH,
    start: f2s(c.start),
    // placement round-trips through the doc clip's metadata + crop (see overlayMetadata)
    x: num(m.ovX, 0),
    y: num(m.ovY, 0),
    scale: num(m.ovScale, 0.45),
    crop: { l: c.crop.left, t: c.crop.top, r: c.crop.right, b: c.crop.bottom },
    zoomStart: num(m.ovZoomStart, 1),
    zoomEnd: num(m.ovZoomEnd, 1),
    overlayRuleId: str(m.overlayRuleId),
    overlayAnimation: str(m.overlayAnimation) as LegacyClip['overlayAnimation'],
    overlayReason: str(m.overlayReason)
  }
}

function legacyTextFrom(c: Clip, f2s: (f: number) => number): TextClip {
  const t = c.text as TextContent
  return {
    id: c.id,
    text: t.text,
    start: f2s(c.start),
    end: f2s(c.end),
    x: 0.5 + c.transform.x.static,
    y: 0.5 + c.transform.y.static,
    fontFamily: t.fontFamily,
    fontSize: t.fontSize,
    color: t.color,
    align: t.align,
    bold: t.bold,
    italic: t.italic,
    strokeWidth: t.strokeWidth,
    strokeColor: t.strokeColor,
    bgEnabled: t.background.enabled,
    bgColor: t.background.color,
    bgRadius: t.background.radius,
    bgPadding: t.background.padding,
    bgOpacity: t.background.opacity
  }
}

/**
 * Reverse bridge: fold the clip document back into a `Project` so the existing
 * montage preview/export pipeline renders the edits unchanged. The main lane
 * becomes a `baseSequence` (each clip = one already-trimmed source segment, so
 * NO project-level cuts are needed — the sequence IS the final edit); overlay
 * video lanes become `tracks`; text lanes become `texts`. Extra audio lanes and
 * exact transforms are not represented in the legacy model (a known limitation).
 */
export function documentToProject(doc: TimelineDocument, base: Project): Project {
  const tb = doc.timebase
  const f2s = (f: number): number => framesToSeconds(f, tb)
  const mainId = mainTrackId(doc)
  const mainTrack = mainId ? findTrack(doc, mainId) : undefined

  const baseSequence: SequenceClip[] = (mainTrack?.clips ?? [])
    .filter((c) => !!c.sourcePath)
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((c) => ({
      id: c.id,
      sourcePath: c.sourcePath as string,
      name: c.name || 'clip',
      sourceIn: c.sourceIn,
      sourceOut: c.sourceOut,
      sourceDuration: c.sourceDuration ?? c.sourceOut,
      hasAudio: c.hasAudio,
      srcW: c.srcW ?? 1920,
      srcH: c.srcH ?? 1080,
      fps: c.srcFps ?? fps(tb),
      isImage: c.kind === 'image'
    }))

  const overlayTracks = doc.tracks.filter((t) => t.kind === 'video' && !t.isMain && t.clips.length > 0)
  const tracks: LegacyTrack[] = overlayTracks.map((t, i) => ({
    id: t.id,
    index: i + 1,
    name: t.name,
    muted: t.muted,
    hidden: t.hidden,
    clips: t.clips.map((c) => legacyClipFrom(c, f2s))
  }))

  const texts: TextClip[] = doc.tracks
    .filter((t) => t.kind === 'text')
    .flatMap((t) => t.clips.filter((c) => !!c.text).map((c) => legacyTextFrom(c, f2s)))

  return {
    ...base,
    media: undefined,
    baseSequence,
    // the baseSequence already reflects the final cut, so clear legacy cut state
    silences: [],
    manualCuts: [],
    keepOverrides: [],
    baseSplits: [],
    tracks,
    texts,
    timeline: doc
  }
}

/** A compact key of the project's STRUCTURE, so the timeline only rebuilds on
 *  structural edits (media/clips/texts/music), not on every playhead tick. */
export function projectStructureKey(p: Project): string {
  const parts: string[] = []
  parts.push('m:' + (p.media ? `${p.media.path}|${p.media.duration}|${p.media.fps}` : ''))
  parts.push('b:' + (p.baseSequence ?? []).map((c) => `${c.sourcePath}@${c.sourceIn}-${c.sourceOut}`).join(','))
  parts.push(
    't:' +
      (p.tracks ?? [])
        .map((tr) => tr.clips.map((c) => `${c.sourcePath}@${c.start}:${c.sourceIn}-${c.sourceOut}`).join('~'))
        .join('|')
  )
  parts.push('x:' + (p.texts ?? []).map((t) => `${t.start}-${t.end}`).join(','))
  parts.push('mu:' + (p.music ? `${p.music.path}@${p.music.startAt}-${p.music.endAt ?? ''}` : ''))
  // cut state — so FastCut / ProCut / word-cuts / silences re-render the Main lane
  parts.push('del:' + (p.transcript?.words.filter((w) => w.deleted).map((w) => w.id).join(',') ?? ''))
  parts.push('sil:' + (p.silences ?? []).map((s) => `${s.start}-${s.end}:${s.action}`).join(','))
  parts.push('mc:' + (p.manualCuts ?? []).map((c) => `${c.start}-${c.end}`).join(','))
  parts.push('ko:' + (p.keepOverrides ?? []).map((c) => `${c.start}-${c.end}`).join(','))
  parts.push('spl:' + (p.baseSplits ?? []).join(','))
  parts.push('pad:' + `${p.wordCutPad ?? ''}|${p.silencePadding ?? ''}`)
  return parts.join(';')
}
