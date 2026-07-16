// Bridge: convert the app's existing `Project` (single media / montage
// baseSequence / overlay tracks / texts / music) into a clip-based
// TimelineDocument the new timeline renders. Times in the old model are SECONDS;
// they convert to frames at the project's timebase. This produces the timeline
// STRUCTURE (tracks + clips with correct source refs + timing) so the media
// managers can pull real waveforms/thumbnails by sourcePath. Pure & headless.

import type { Project, TextClip, SequenceClip, ExtraAudioClip, Clip as LegacyClip, Track as LegacyTrack, OverlayAsset, OverlayEvent } from '../types'
import type { Clip, TextContent, TimelineDocument } from './types'
import { positionToBox } from '../overlay'
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
import { computeKeepRanges, virtualKeepsToClipSegments, isMultiBase, baseClipSpans } from '../edit'

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

  // 1. text lane (top) — ALWAYS present (even empty) so every project has a place
  //    to drop captions on both the desktop and mobile timelines.
  const texts = project.texts ?? []
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

  // 4. music / BGM lane (below the main lane) — ALWAYS present (even empty), like the
  //    text + overlay lanes above, so every project shows a place to drop background
  //    music / voiceover. When `music` exists it fills this lane; otherwise it stays
  //    empty (an empty audio lane folds to nothing in export, so it's harmless).
  const aId = 'br-music'
  doc = addTrackToDoc(doc, createTrack({ kind: 'audio', order: order++, id: aId, name: project.music?.name || 'Audio' }))
  if (project.music) {
    const mu = project.music
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

/**
 * Guarantee the standard lane stack so every project shows a place to work: at
 * least one overlay (video) lane + one text lane ABOVE the main lane, and one
 * audio/BGM lane BELOW it. Empty lanes fold to nothing in export. Returns the doc
 * UNCHANGED (same identity) when it's already complete, so hydration never churns.
 *
 * Applied to freshly-built docs AND to already-migrated `project.timeline`s — those
 * never re-run projectToDocument, so without this an existing project (migrated
 * before the audio lane was added) would never gain one. That's exactly the "no
 * empty audio track below main" case.
 */
export function normalizeDefaultLanes(doc: TimelineDocument): TimelineDocument {
  const hasOverlay = doc.tracks.some((t) => t.kind === 'video' && !t.isMain)
  const hasText = doc.tracks.some((t) => t.kind === 'text')
  const hasAudio = doc.tracks.some((t) => t.kind === 'audio')
  if (hasOverlay && hasText && hasAudio) return doc
  let out = doc
  const minOrder = Math.min(0, ...doc.tracks.map((t) => t.order))
  const maxOrder = Math.max(0, ...doc.tracks.map((t) => t.order))
  if (!hasText) out = addTrackToDoc(out, createTrack({ kind: 'text', order: minOrder - 2, name: 'Text' }))
  if (!hasOverlay) out = addTrackToDoc(out, createTrack({ kind: 'video', order: minOrder - 1, name: 'Overlay 1' }))
  if (!hasAudio) out = addTrackToDoc(out, createTrack({ kind: 'audio', order: maxOrder + 1, name: 'Audio' }))
  return out
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

  const mnum = (v: unknown, d: number): number => (typeof v === 'number' ? v : d)
  const baseSequence: SequenceClip[] = (mainTrack?.clips ?? [])
    .filter((c) => !!c.sourcePath)
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((c) => {
      const m = c.metadata ?? {}
      return {
        id: c.id,
        sourcePath: c.sourcePath as string,
        name: c.name || 'clip',
        sourceIn: c.sourceIn,
        sourceOut: c.sourceOut,
        sourceDuration: c.sourceDuration ?? c.sourceOut,
        // A detached/muted base clip contributes NO audio (its sound now lives on an
        // audio lane, folded into extraAudio below) — matches the muted <video> in
        // the doc preview, so preview and export mix identically.
        hasAudio: c.hasAudio && !c.muted && !c.audioDetached,
        srcW: c.srcW ?? 1920,
        srcH: c.srcH ?? 1080,
        fps: c.srcFps ?? fps(tb),
        isImage: c.kind === 'image',
        // Per-clip transform / speed / volume — read EXACTLY the fields
        // SequencePreview applies to the base <video> (metadata ov*, clip.gain,
        // clip.speed) so the ffmpeg export renders the same Size/Zoom/Pan/Speed/
        // Volume the user sees in the preview.
        speed: typeof c.speed === 'number' && c.speed > 0 ? c.speed : 1,
        gain: typeof c.gain === 'number' ? c.gain : 1,
        size: mnum(m.ovScale, 1),
        zoomStart: mnum(m.ovZoomStart, 1),
        zoomEnd: mnum(m.ovZoomEnd, 1),
        panX: mnum(m.ovX, 0),
        panY: mnum(m.ovY, 0)
      }
    })

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

  // Audio lanes (music / detached audio / dropped audio) become export-only
  // extraAudio, positioned in EDITED seconds. The document is authoritative for
  // audio (the doc preview mixes these same lanes via <DocAudio>), so the legacy
  // single `music` slot is cleared to avoid mixing it twice.
  const extraAudio: ExtraAudioClip[] = doc.tracks
    .filter((t) => t.kind === 'audio' && !t.muted && !t.hidden)
    .flatMap((t) => t.clips)
    .filter((c) => !!c.sourcePath)
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((c) => ({
      path: c.sourcePath as string,
      in: c.sourceIn,
      out: c.sourceOut,
      startAt: f2s(c.start),
      gain: c.gain ?? 1
    }))

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
    music: undefined,
    extraAudio,
    timeline: doc
  }
}

/**
 * Convert cut-engine removed ranges (base/virtual SECONDS — the domain the
 * transcript, silences and manual cuts live in) into edited-FRAME ranges on the
 * document's MAIN lane, by intersecting each removed source segment with the
 * main-lane clips that still carry that source. Footage already cut from the lane
 * is no longer present, so mapping the FULL removed set only yields the newly-cut
 * footage — which is what lets Fast/Pro/word/silence cuts flow into the document
 * WITHOUT wiping manual splits/drops (a split keeps a clip's source coverage
 * contiguous; a dropped clip of another source simply never matches). The frame
 * ranges are fed to `applyDeletionsToDocument` (split + ripple).
 *
 * Each intersecting clip contributes its OWN sub-range, so a removed span that
 * straddles a manual split boundary produces two adjacent per-clip ranges — the
 * shape `applyDeletionsToDocument` needs (it cuts one clip per range).
 */
export function removedRangesToMainFrames(
  doc: TimelineDocument,
  project: Project,
  removed: { start: number; end: number }[]
): { start: number; end: number }[] {
  const mainId = mainTrackId(doc)
  const main = mainId ? findTrack(doc, mainId) : undefined
  if (!main || removed.length === 0) return []

  // removed base/virtual-second ranges -> concrete source segments {path,in,out}
  const segs: { sourcePath: string; in: number; out: number }[] = []
  if (isMultiBase(project)) {
    const spans = baseClipSpans(project)
    for (const r of removed) {
      for (const s of spans) {
        const a = Math.max(r.start, s.vStart)
        const b = Math.min(r.end, s.vEnd)
        if (b - a > 0.001) {
          segs.push({
            sourcePath: s.clip.sourcePath,
            in: a - s.vStart + s.clip.sourceIn,
            out: b - s.vStart + s.clip.sourceIn
          })
        }
      }
    }
  } else if (project.media) {
    for (const r of removed) segs.push({ sourcePath: project.media.path, in: r.start, out: r.end })
  }

  // source segments -> main-lane edited-frame ranges (linear within each clip;
  // clip.duration already folds in speed, so the ratio maps through it correctly).
  const frames: { start: number; end: number }[] = []
  for (const seg of segs) {
    for (const c of main.clips) {
      if (c.sourcePath !== seg.sourcePath || c.reversed) continue
      const span = c.sourceOut - c.sourceIn
      if (span <= 1e-6) continue
      const a = Math.max(seg.in, c.sourceIn)
      const b = Math.min(seg.out, c.sourceOut)
      if (b - a <= 1e-4) continue
      const fA = c.start + ((a - c.sourceIn) / span) * c.duration
      const fB = c.start + ((b - c.sourceIn) / span) * c.duration
      if (fB - fA >= 1) frames.push({ start: fA, end: fB })
    }
  }
  return frames
}

/**
 * Turn AI overlay events (SOURCE seconds, from the transcript matcher) into
 * image clips on the document's first overlay lane, positioned in EDITED frames.
 * Each event's start is located on the main lane through the same source→edited
 * mapping the cut engine uses, so placements stay glued to the sentence that
 * triggered them no matter what has been cut. Events whose footage is no longer
 * on the main lane (cut out or manually deleted) are skipped with a note.
 * Pure — the caller wraps the clips in engine commands.
 */
export function overlayEventsToDocClips(
  doc: TimelineDocument,
  project: Project,
  events: OverlayEvent[],
  assets: OverlayAsset[]
): { clips: Clip[]; skipped: string[] } {
  const skipped: string[] = []
  const lane = doc.tracks
    .filter((t) => t.kind === 'video' && !t.isMain)
    .sort((a, b) => a.order - b.order)[0]
  if (!lane) return { clips: [], skipped: ['no overlay lane in the timeline'] }

  const assetById = new Map(assets.map((a) => [a.id, a]))
  const clips: Clip[] = []
  for (const ev of events) {
    const asset = assetById.get(ev.overlayId)
    if (!asset) continue
    const mapped = removedRangesToMainFrames(doc, project, [{ start: ev.start, end: ev.end }])
    if (mapped.length === 0) {
      skipped.push(`${asset.name}: moment at ${ev.start.toFixed(1)}s is cut from the timeline`)
      continue
    }
    const len = Math.max(0.5, ev.end - ev.start)
    const durFrames = Math.max(1, secondsToFrames(len, doc.timebase))
    const box = positionToBox(ev.position)
    clips.push(
      createClip({
        kind: 'image',
        trackId: lane.id,
        start: Math.max(0, Math.round(mapped[0].start)),
        duration: durFrames,
        sourcePath: asset.file,
        sourceIn: 0,
        sourceOut: len,
        sourceDuration: len,
        name: asset.name,
        hasAudio: false,
        metadata: {
          ovX: box.x,
          ovY: box.y,
          ovScale: box.scale,
          ovZoomStart: 1,
          ovZoomEnd: 1,
          overlayRuleId: asset.id,
          overlayAnimation: ev.animation,
          overlayReason: ev.reason
        }
      })
    )
  }
  return { clips, skipped }
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
