// Pure, headless timeline logic: factories, selectors, normalization and the
// document transforms the commands are built from. No IO, no React, no DOM.
// Every transform returns a NEW normalized document on change, or the SAME
// document reference when it is a no-op (so the engine can skip empty history
// entries and re-renders).

import type {
  Animatable,
  CacheRefs,
  Clip,
  ClipKind,
  ColorCorrection,
  Crop,
  Easing,
  Effect,
  Keyframe,
  Marker,
  SessionState,
  TimelineDocument,
  Track,
  TrackKind,
  TextContent,
  Transform
} from './types'
import { framesToSeconds, secondsToFrames, frameSeconds, FPS_30, type Timebase } from './time'
import { uid } from './ids'

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export function defaultTransform(): Transform {
  return {
    x: { static: 0 },
    y: { static: 0 },
    scale: { static: 1 },
    rotation: { static: 0 },
    opacity: { static: 1 },
    anchorX: 0.5,
    anchorY: 0.5
  }
}

export function defaultCrop(): Crop {
  return { left: 0, top: 0, right: 0, bottom: 0 }
}

export function defaultColor(): ColorCorrection {
  return {
    brightness: 0,
    contrast: 1,
    saturation: 1,
    temperature: 0,
    tint: 0,
    hue: 0,
    exposure: 0,
    highlights: 0,
    shadows: 0,
    lift: 0,
    gamma: 1,
    gain: 1
  }
}

export function defaultCache(): CacheRefs {
  return { proxy: 'none' }
}

const TRACK_KIND_HEIGHT: Record<TrackKind, number> = {
  // Main video lane is TALL by default: the waveform + filmstrip need vertical
  // room to be readable. Users can still drag any track's height (28-360).
  video: 96,
  audio: 44,
  text: 34,
  overlay: 52,
  subtitle: 32,
  effect: 30,
  adjustment: 30
}

/** Overlay lanes are kind 'video' too, but default to HALF the main lane's
 *  height — content dropped there shouldn't expand the lane to full size
 *  (users can still drag the height afterwards). */
const OVERLAY_LANE_H = TRACK_KIND_HEIGHT.video / 2

const TRACK_KIND_LABEL: Record<TrackKind, string> = {
  video: 'Video',
  audio: 'Audio',
  text: 'Text',
  overlay: 'Overlay',
  subtitle: 'Subtitle',
  effect: 'Effect',
  adjustment: 'Adjustment'
}

export function defaultTrackHeight(kind: TrackKind): number {
  return TRACK_KIND_HEIGHT[kind]
}

export function defaultTrackName(kind: TrackKind): string {
  return TRACK_KIND_LABEL[kind]
}

export interface NewClip {
  kind: ClipKind
  trackId: string
  start: number
  duration: number
  id?: string
  name?: string
  sourcePath?: string
  sourceIn?: number
  sourceOut?: number
  sourceDuration?: number
  srcW?: number
  srcH?: number
  srcFps?: number
  speed?: number
  reversed?: boolean
  freeze?: boolean
  text?: TextContent
  gain?: number
  hasAudio?: boolean
  metadata?: Record<string, string | number | boolean>
}

export function createClip(i: NewClip): Clip {
  const start = Math.max(0, Math.round(i.start))
  const duration = Math.max(1, Math.round(i.duration))
  return {
    id: i.id ?? uid('clip'),
    kind: i.kind,
    trackId: i.trackId,
    name: i.name ?? '',
    sourcePath: i.sourcePath,
    sourceIn: i.sourceIn ?? 0,
    sourceOut: i.sourceOut ?? 0,
    sourceDuration: i.sourceDuration,
    srcW: i.srcW,
    srcH: i.srcH,
    srcFps: i.srcFps,
    start,
    duration,
    end: start + duration,
    speed: i.speed ?? 1,
    reversed: i.reversed ?? false,
    freeze: i.freeze,
    hasAudio: i.hasAudio ?? (i.kind === 'video' || i.kind === 'audio' || i.kind === 'gif'),
    linkedClipIds: [],
    transform: defaultTransform(),
    crop: defaultCrop(),
    masks: [],
    effects: [],
    color: defaultColor(),
    gain: i.gain ?? 1,
    muted: false,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    text: i.text,
    enabled: true,
    metadata: i.metadata ?? {},
    cache: defaultCache()
  }
}

export interface NewTrack {
  kind: TrackKind
  order: number
  id?: string
  name?: string
  height?: number
  isMain?: boolean
  autoCreated?: boolean
}

export function createTrack(i: NewTrack): Track {
  return {
    id: i.id ?? uid('track'),
    kind: i.kind,
    name: i.name ?? defaultTrackName(i.kind),
    order: i.order,
    height: i.height ?? (i.kind === 'video' && !i.isMain ? OVERLAY_LANE_H : defaultTrackHeight(i.kind)),
    collapsed: false,
    locked: false,
    muted: false,
    hidden: false,
    solo: false,
    isMain: i.isMain,
    autoCreated: i.autoCreated,
    clips: []
  }
}

/** Which track kind a clip of the given kind belongs on (for auto-track creation / import). */
export function clipKindToTrackKind(kind: ClipKind): TrackKind {
  if (kind === 'audio') return 'audio'
  if (kind === 'text' || kind === 'title') return 'text'
  if (kind === 'adjustment') return 'adjustment'
  if (kind === 'effect' || kind === 'transition') return 'effect'
  return 'video' // video AND images/gifs share video lanes
}

export type DropPlan =
  | { type: 'existing'; trackId: string }
  | { type: 'new'; kind: TrackKind; order: number }

/**
 * Resolve where a dragged clip may land, honouring the lane regions:
 *   - video/image -> video lanes (upper region + main)
 *   - text        -> text lanes  (upper region, text-only)
 *   - audio       -> audio lanes (BELOW main only)
 * Dragging past the top spawns an upper lane of the clip's kind; past the bottom
 * spawns an audio lane (only for audio). Anything incompatible keeps the clip on
 * its origin lane (so you can't drop video onto text/audio, or audio above main).
 */
export function planDrop(
  doc: TimelineDocument,
  clipKind: ClipKind,
  opts: { trackId?: string; zone?: 'above' | 'below'; originTrackId: string }
): DropPlan {
  const needed = clipKindToTrackKind(clipKind)
  const orders = doc.tracks.map((t) => t.order)
  const minOrder = orders.length ? Math.min(...orders) : 0
  const maxOrder = orders.length ? Math.max(...orders) : -1

  if (opts.zone === 'above') {
    // upper region — video/image/text spawn a new lane at the top; audio can't go up
    return needed === 'audio'
      ? { type: 'existing', trackId: opts.originTrackId }
      : { type: 'new', kind: needed, order: minOrder - 1 }
  }
  if (opts.zone === 'below') {
    // lower region — only audio spawns a lane below; visual/text can't cross below main
    return needed === 'audio'
      ? { type: 'new', kind: 'audio', order: maxOrder + 1 }
      : { type: 'existing', trackId: opts.originTrackId }
  }
  if (opts.trackId) {
    const t = findTrack(doc, opts.trackId)
    if (t && t.kind === needed) return { type: 'existing', trackId: t.id }
    return { type: 'existing', trackId: opts.originTrackId } // incompatible lane → stay put
  }
  return { type: 'existing', trackId: opts.originTrackId }
}

export function createTimeline(timebase: Timebase = FPS_30): TimelineDocument {
  return { id: uid('tl'), timebase, tracks: [], markers: [], duration: 0 }
}

export function createSession(): SessionState {
  return {
    playhead: 0,
    zoom: 100,
    settings: { magnet: true, snapping: true, snapThresholdPx: 8, rippleAcrossTracks: false, waveformSize: 0.3 }
  }
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export function findTrack(doc: TimelineDocument, trackId: string): Track | undefined {
  return doc.tracks.find((t) => t.id === trackId)
}

export interface ClipLocation {
  track: Track
  clip: Clip
  index: number
}

export function findClip(doc: TimelineDocument, clipId: string): ClipLocation | undefined {
  for (const track of doc.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId)
    if (index >= 0) return { track, clip: track.clips[index], index }
  }
  return undefined
}

/** The clip on `track` that contains `frame`, if any. */
export function clipAtFrame(track: Track, frame: number): Clip | undefined {
  return track.clips.find((c) => frame >= c.start && frame < c.end)
}

export function trackContentEnd(track: Track): number {
  let end = 0
  for (const c of track.clips) if (c.end > end) end = c.end
  return end
}

export function documentDuration(doc: TimelineDocument): number {
  let end = 0
  for (const t of doc.tracks) {
    const e = trackContentEnd(t)
    if (e > end) end = e
  }
  return end
}

/** Gaps (in frames) between clips on a track within [0, end]. */
export function trackGaps(track: Track): Array<{ start: number; end: number }> {
  const sorted = [...track.clips].sort((a, b) => a.start - b.start)
  const gaps: Array<{ start: number; end: number }> = []
  let cursor = 0
  for (const c of sorted) {
    if (c.start > cursor) gaps.push({ start: cursor, end: c.start })
    if (c.end > cursor) cursor = c.end
  }
  return gaps
}

/** Whether a clip kind maps timeline frames onto a source time range (so trims move source in/out). */
export function isTimeBased(clip: Clip): boolean {
  if (clip.freeze) return false
  switch (clip.kind) {
    case 'video':
    case 'audio':
    case 'gif':
    case 'compound':
    case 'nested':
      return true
    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// Normalization — keep clips sorted, `end` consistent, tracks ordered, duration fresh
// ---------------------------------------------------------------------------

function withEnd(c: Clip): Clip {
  const end = c.start + c.duration
  return c.end === end ? c : { ...c, end }
}

export function normalizeTrack(track: Track): Track {
  let changed = false
  // One-time upgrade: video lanes still at the OLD default height (64) move to
  // the new taller default so waveform + filmstrip are readable. 64 was only
  // ever the default (never a drag detent), so a stored 64 = "never adjusted".
  if (track.kind === 'video' && track.isMain && track.height === 64) {
    track = { ...track, height: TRACK_KIND_HEIGHT.video }
    changed = true
  }
  // One-time upgrade: OVERLAY lanes (non-main video) stored at the main-video
  // default height drop to the overlay default — half the main lane — so content
  // landing on them doesn't expand the lane to full main height. The full height
  // was only ever the created default for these lanes ("never adjusted").
  if (track.kind === 'video' && !track.isMain && track.height === TRACK_KIND_HEIGHT.video) {
    track = { ...track, height: OVERLAY_LANE_H }
    changed = true
  }
  const clips = track.clips.map((c) => {
    const fixed = withEnd(c)
    if (fixed !== c) changed = true
    return fixed
  })
  clips.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  // detect resort
  if (!changed) {
    for (let i = 0; i < clips.length; i++) {
      if (clips[i] !== track.clips[i]) {
        changed = true
        break
      }
    }
  }
  return changed ? { ...track, clips } : track
}

export function normalizeDoc(doc: TimelineDocument): TimelineDocument {
  const tracks = [...doc.tracks].sort((a, b) => a.order - b.order).map(normalizeTrack)
  let orderChanged = tracks.length !== doc.tracks.length
  if (!orderChanged) {
    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i] !== doc.tracks[i]) {
        orderChanged = true
        break
      }
    }
  }
  let duration = 0
  for (const t of tracks) {
    const e = trackContentEnd(t)
    if (e > duration) duration = e
  }
  if (!orderChanged && duration === doc.duration) return doc
  return { ...doc, tracks, duration }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Replace one track by id via `fn`; returns same doc if unchanged. */
function mapTrack(
  doc: TimelineDocument,
  trackId: string,
  fn: (t: Track) => Track
): TimelineDocument {
  let changed = false
  const tracks = doc.tracks.map((t) => {
    if (t.id !== trackId) return t
    const nt = fn(t)
    if (nt !== t) changed = true
    return nt
  })
  return changed ? { ...doc, tracks } : doc
}

/** Replace one clip anywhere in the document. */
function replaceClip(doc: TimelineDocument, next: Clip): TimelineDocument {
  return mapTrack(doc, next.trackId, (t) => ({
    ...t,
    clips: t.clips.map((c) => (c.id === next.id ? withEnd(next) : c))
  }))
}

function shiftClip(c: Clip, deltaFrames: number): Clip {
  const start = Math.max(0, c.start + deltaFrames)
  return { ...c, start, end: start + c.duration }
}

// ---------------------------------------------------------------------------
// Keyframe-aware splitting (values sampled/partitioned exactly at the cut)
// ---------------------------------------------------------------------------

function evalEase(e: Easing, t: number): number {
  switch (e) {
    case 'hold':
      return 0
    case 'easeIn':
      return t * t
    case 'easeOut':
      return t * (2 - t)
    case 'easeInOut':
      return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
    default:
      return t
  }
}

/** Sample an animatable at a clip-relative frame. */
export function sampleAnimatable(a: Animatable, frame: number): number {
  const ks = a.keyframes
  if (!ks || ks.length === 0) return a.static
  if (frame <= ks[0].frame) return ks[0].value
  const last = ks[ks.length - 1]
  if (frame >= last.frame) return last.value
  for (let i = 0; i < ks.length - 1; i++) {
    const k0 = ks[i]
    const k1 = ks[i + 1]
    if (frame >= k0.frame && frame <= k1.frame) {
      if (k1.easing === 'hold') return k0.value
      const span = k1.frame - k0.frame
      const t = span <= 0 ? 0 : (frame - k0.frame) / span
      return k0.value + (k1.value - k0.value) * evalEase(k1.easing, t)
    }
  }
  return last.value
}

/** Split an animatable at a clip-relative offset into [left, right] halves. */
function splitAnimatable(a: Animatable, atOffset: number): [Animatable, Animatable] {
  if (!a.keyframes || a.keyframes.length === 0) {
    return [{ static: a.static }, { static: a.static }]
  }
  const boundary = sampleAnimatable(a, atOffset)
  const left: Keyframe[] = []
  const right: Keyframe[] = []
  for (const k of a.keyframes) {
    if (k.frame < atOffset) left.push({ ...k })
    else if (k.frame > atOffset) right.push({ ...k, frame: k.frame - atOffset })
  }
  left.push({ frame: atOffset, value: boundary, easing: 'linear' })
  right.unshift({ frame: 0, value: boundary, easing: 'linear' })
  return [
    { static: a.static, keyframes: left },
    { static: a.static, keyframes: right }
  ]
}

function splitTransform(tr: Transform, atOffset: number): [Transform, Transform] {
  const [xl, xr] = splitAnimatable(tr.x, atOffset)
  const [yl, yr] = splitAnimatable(tr.y, atOffset)
  const [sl, sr] = splitAnimatable(tr.scale, atOffset)
  const [rl, rr] = splitAnimatable(tr.rotation, atOffset)
  const [ol, or] = splitAnimatable(tr.opacity, atOffset)
  const base = { anchorX: tr.anchorX, anchorY: tr.anchorY }
  return [
    { ...base, x: xl, y: yl, scale: sl, rotation: rl, opacity: ol },
    { ...base, x: xr, y: yr, scale: sr, rotation: rr, opacity: or }
  ]
}

function splitEffects(effects: Effect[], atOffset: number): [Effect[], Effect[]] {
  const left: Effect[] = []
  const right: Effect[] = []
  for (const fx of effects) {
    if (!fx.keyframes) {
      left.push(fx)
      right.push({ ...fx, id: uid('fx') })
      continue
    }
    const lk: Record<string, Keyframe[]> = {}
    const rk: Record<string, Keyframe[]> = {}
    for (const [prop, ks] of Object.entries(fx.keyframes)) {
      const boundary = sampleAnimatable({ static: 0, keyframes: ks }, atOffset)
      const l: Keyframe[] = []
      const r: Keyframe[] = []
      for (const k of ks) {
        if (k.frame < atOffset) l.push({ ...k })
        else if (k.frame > atOffset) r.push({ ...k, frame: k.frame - atOffset })
      }
      l.push({ frame: atOffset, value: boundary, easing: 'linear' })
      r.unshift({ frame: 0, value: boundary, easing: 'linear' })
      lk[prop] = l
      rk[prop] = r
    }
    left.push({ ...fx, keyframes: lk })
    right.push({ ...fx, id: uid('fx'), keyframes: rk })
  }
  return [left, right]
}

// ---------------------------------------------------------------------------
// Transforms (the vocabulary the commands compose)
// ---------------------------------------------------------------------------

export function addTrackToDoc(doc: TimelineDocument, track: Track): TimelineDocument {
  return normalizeDoc({ ...doc, tracks: [...doc.tracks, track] })
}

export function removeTrackFromDoc(doc: TimelineDocument, trackId: string): TimelineDocument {
  if (!findTrack(doc, trackId)) return doc
  return normalizeDoc({ ...doc, tracks: doc.tracks.filter((t) => t.id !== trackId) })
}

export function updateTrackInDoc(
  doc: TimelineDocument,
  trackId: string,
  patch: Partial<Omit<Track, 'id' | 'clips'>>
): TimelineDocument {
  const t = findTrack(doc, trackId)
  if (!t) return doc
  return normalizeDoc(mapTrack(doc, trackId, (track) => ({ ...track, ...patch })))
}

/** Re-assign track order to the given id sequence (index = order). */
export function reorderTracksInDoc(doc: TimelineDocument, orderedIds: string[]): TimelineDocument {
  const rank = new Map(orderedIds.map((id, i) => [id, i]))
  const tracks = doc.tracks.map((t) => {
    const r = rank.get(t.id)
    return r === undefined || r === t.order ? t : { ...t, order: r }
  })
  return normalizeDoc({ ...doc, tracks })
}

/**
 * Clips on one lane must never stack: the nearest non-overlapping start for a
 * clip of `duration` given the lane's other clips. The requested start is
 * clamped into the closest gap that fits (past the lane's end always fits).
 */
export function resolveFreeStart(others: Clip[], start: number, duration: number): number {
  const sorted = [...others].sort((a, b) => a.start - b.start)
  let best: number | null = null
  const consider = (lo: number, hi: number): void => {
    if (hi < lo) return
    const c = Math.max(lo, Math.min(hi, start))
    if (best === null || Math.abs(c - start) < Math.abs(best - start)) best = c
  }
  let prevEnd = 0
  for (const c of sorted) {
    consider(prevEnd, c.start - duration)
    prevEnd = Math.max(prevEnd, c.end)
  }
  consider(prevEnd, Number.MAX_SAFE_INTEGER)
  return Math.max(0, Math.round(best ?? start))
}

export function addClipToDoc(doc: TimelineDocument, clip: Clip): TimelineDocument {
  const track = findTrack(doc, clip.trackId)
  if (!track) return doc
  // Adds land in the nearest free spot (e.g. "Add text" twice at the playhead
  // used to stack two clips exactly on top of each other).
  const c0 = withEnd(clip)
  const start = resolveFreeStart(track.clips, c0.start, c0.duration)
  const placed = start === c0.start ? c0 : { ...c0, start, end: start + c0.duration }
  return normalizeDoc(
    mapTrack(doc, clip.trackId, (t) => ({ ...t, clips: [...t.clips, placed] }))
  )
}

/**
 * Remove a clip. `ripple` closes the gap by pulling later clips on the same
 * track left by the removed clip's duration (magnetic delete); otherwise the
 * gap is left in place (lift delete).
 */
export function removeClipFromDoc(
  doc: TimelineDocument,
  clipId: string,
  ripple: boolean
): TimelineDocument {
  const loc = findClip(doc, clipId)
  if (!loc) return doc
  const { track, clip } = loc
  return normalizeDoc(
    mapTrack(doc, track.id, (t) => {
      let clips = t.clips.filter((c) => c.id !== clipId)
      if (ripple) clips = clips.map((c) => (c.start >= clip.end ? shiftClip(c, -clip.duration) : c))
      return { ...t, clips }
    })
  )
}

/** Free move: place a clip on a (possibly different) track at a frame; negative
 *  time is clamped. Clips never stack — the drop is clamped into the nearest
 *  free spot — except with `noCollide` (group moves shift members sequentially,
 *  so mid-flight they'd collide with group-mates that haven't moved yet). */
export function moveClipInDoc(
  doc: TimelineDocument,
  clipId: string,
  toTrackId: string,
  toStart: number,
  noCollide = false
): TimelineDocument {
  const loc = findClip(doc, clipId)
  if (!loc) return doc
  const to = findTrack(doc, toTrackId)
  if (!to) return doc
  const { track, clip } = loc
  const want = Math.max(0, Math.round(toStart))
  const start = noCollide
    ? want
    : resolveFreeStart(to.clips.filter((c) => c.id !== clipId), want, clip.duration)
  if (toTrackId === track.id && start === clip.start) return doc
  let moved: Clip = { ...clip, trackId: toTrackId, start, end: start + clip.duration }
  // A MAIN clip promoted onto an overlay lane keeps its full-frame size: the
  // overlay renderers (preview + export) default a missing ovScale to a small
  // PiP (0.45), which silently SHRANK manually-moved clips. Stamp an explicit
  // full-size placement once at promotion — b-roll flows set their own.
  if (track.isMain && !to.isMain && to.kind === 'video' && typeof clip.metadata?.ovScale !== 'number') {
    moved = { ...moved, metadata: { ...clip.metadata, ovScale: 1, ovX: 0, ovY: 0 } }
  }
  const tracks = doc.tracks.map((t) => {
    if (t.id === track.id && t.id === toTrackId) {
      return { ...t, clips: t.clips.map((c) => (c.id === clipId ? moved : c)) }
    }
    if (t.id === track.id) return { ...t, clips: t.clips.filter((c) => c.id !== clipId) }
    if (t.id === toTrackId) return { ...t, clips: [...t.clips, moved] }
    return t
  })
  return normalizeDoc({ ...doc, tracks })
}

/** Seconds of source available before `sourceIn` / after `sourceOut`, expressed in TIMELINE frames. */
export function headroomBeforeFrames(clip: Clip, tb: Timebase): number {
  if (!isTimeBased(clip)) return Number.MAX_SAFE_INTEGER
  const availSec = clip.reversed
    ? (clip.sourceDuration ?? clip.sourceOut) - clip.sourceOut
    : clip.sourceIn
  return Math.max(0, secondsToFrames(availSec / clip.speed, tb))
}
export function headroomAfterFrames(clip: Clip, tb: Timebase): number {
  if (!isTimeBased(clip)) return Number.MAX_SAFE_INTEGER
  const availSec = clip.reversed
    ? clip.sourceIn
    : (clip.sourceDuration ?? clip.sourceOut) - clip.sourceOut
  return Math.max(0, secondsToFrames(availSec / clip.speed, tb))
}

/**
 * Trim the LEFT edge to `newStart` (frames). Moves the in-point; the clip's end
 * stays put. Clamps to the media head and to a 1-frame minimum. For time-based
 * clips the source in/out move with the edge (through the clip's speed).
 */
export function trimClipInInDoc(
  doc: TimelineDocument,
  clipId: string,
  newStart: number,
  tb: Timebase
): TimelineDocument {
  const loc = findClip(doc, clipId)
  if (!loc) return doc
  const { clip } = loc
  const minStart = Math.max(0, clip.start - headroomBeforeFrames(clip, tb))
  const maxStart = clip.end - 1
  const ns = Math.min(Math.max(Math.round(newStart), minStart), maxStart)
  if (ns === clip.start) return doc
  const deltaFrames = ns - clip.start
  const next: Clip = { ...clip, start: ns, duration: clip.end - ns, end: clip.end }
  if (isTimeBased(clip)) {
    const deltaSec = framesToSeconds(deltaFrames, tb) * clip.speed
    if (clip.reversed) next.sourceOut = clip.sourceOut - deltaSec
    else next.sourceIn = clip.sourceIn + deltaSec
  }
  next.fadeInFrames = Math.min(clip.fadeInFrames, next.duration)
  return normalizeDoc(replaceClip(doc, next))
}

/**
 * Trim the RIGHT edge to `newEnd` (frames). Moves the out-point; the clip's
 * start stays put. Clamps to the media tail and to a 1-frame minimum.
 */
export function trimClipOutInDoc(
  doc: TimelineDocument,
  clipId: string,
  newEnd: number,
  tb: Timebase
): TimelineDocument {
  const loc = findClip(doc, clipId)
  if (!loc) return doc
  const { clip } = loc
  const minEnd = clip.start + 1
  const maxEnd = clip.end + headroomAfterFrames(clip, tb)
  const ne = Math.min(Math.max(Math.round(newEnd), minEnd), maxEnd)
  if (ne === clip.end) return doc
  const deltaFrames = ne - clip.end
  const next: Clip = { ...clip, duration: ne - clip.start, end: ne }
  if (isTimeBased(clip)) {
    const deltaSec = framesToSeconds(deltaFrames, tb) * clip.speed
    if (clip.reversed) next.sourceIn = clip.sourceIn - deltaSec
    else next.sourceOut = clip.sourceOut + deltaSec
  }
  next.fadeOutFrames = Math.min(clip.fadeOutFrames, next.duration)
  return normalizeDoc(replaceClip(doc, next))
}

/**
 * Split a clip at an absolute timeline frame. The left half keeps the original
 * id (and transitionIn); the right half is a new clip (keeps transitionOut).
 * Source, keyframes, fades and transitions are partitioned exactly at the cut.
 */
export function splitClipInDoc(
  doc: TimelineDocument,
  clipId: string,
  atFrame: number,
  tb: Timebase
): TimelineDocument {
  const loc = findClip(doc, clipId)
  if (!loc) return doc
  const { clip } = loc
  const cut = Math.round(atFrame)
  if (cut <= clip.start || cut >= clip.end) return doc
  const offset = cut - clip.start
  const [tl, tr] = splitTransform(clip.transform, offset)
  const [fl, fr] = splitEffects(clip.effects, offset)

  // source split point
  let leftIn = clip.sourceIn
  let leftOut = clip.sourceOut
  let rightIn = clip.sourceIn
  let rightOut = clip.sourceOut
  if (isTimeBased(clip)) {
    const offSec = framesToSeconds(offset, tb) * clip.speed
    if (clip.reversed) {
      const mid = clip.sourceOut - offSec
      leftIn = mid
      leftOut = clip.sourceOut
      rightIn = clip.sourceIn
      rightOut = mid
    } else {
      const mid = clip.sourceIn + offSec
      leftIn = clip.sourceIn
      leftOut = mid
      rightIn = mid
      rightOut = clip.sourceOut
    }
  }

  const left: Clip = {
    ...clip,
    duration: offset,
    end: cut,
    sourceIn: leftIn,
    sourceOut: leftOut,
    transform: tl,
    effects: fl,
    transitionOut: undefined,
    fadeOutFrames: 0,
    masks: clip.masks.map((m) => ({ ...m }))
  }
  const right: Clip = {
    ...clip,
    id: uid('clip'),
    start: cut,
    duration: clip.end - cut,
    end: clip.end,
    sourceIn: rightIn,
    sourceOut: rightOut,
    transform: tr,
    effects: fr,
    transitionIn: undefined,
    fadeInFrames: 0,
    masks: clip.masks.map((m) => ({ ...m, id: uid('mask') }))
  }
  return normalizeDoc(
    mapTrack(doc, clip.trackId, (t) => ({
      ...t,
      clips: t.clips.flatMap((c) => (c.id === clipId ? [left, right] : [c]))
    }))
  )
}

export function setClipSpeedInDoc(
  doc: TimelineDocument,
  clipId: string,
  speed: number,
  tb: Timebase
): TimelineDocument {
  const loc = findClip(doc, clipId)
  if (!loc || !isTimeBased(loc.clip)) return doc
  const { clip } = loc
  const s = Math.max(0.1, Math.min(speed, 20))
  if (s === clip.speed) return doc
  const sourceSpanSec = clip.sourceOut - clip.sourceIn
  const newTimelineSec = sourceSpanSec / s
  const newDuration = Math.max(1, secondsToFrames(newTimelineSec, tb))
  const next: Clip = { ...clip, speed: s, duration: newDuration, end: clip.start + newDuration }
  return normalizeDoc(replaceClip(doc, next))
}

/** Merge keys into a clip's metadata (overlay placement, flags…). No geometry change. */
export function setClipMetadataInDoc(
  doc: TimelineDocument,
  clipId: string,
  patch: Record<string, string | number | boolean>
): TimelineDocument {
  const loc = findClip(doc, clipId)
  if (!loc) return doc
  const next: Clip = { ...loc.clip, metadata: { ...loc.clip.metadata, ...patch } }
  return mapTrack(doc, loc.track.id, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === clipId ? next : c)) }))
}

/** Merge a patch into a text clip's TextContent (nested background/shadow merge too). */
export function setClipTextInDoc(
  doc: TimelineDocument,
  clipId: string,
  patch: Partial<TextContent>
): TimelineDocument {
  const loc = findClip(doc, clipId)
  if (!loc || !loc.clip.text) return doc
  const cur = loc.clip.text
  const next: TextContent = {
    ...cur,
    ...patch,
    background: patch.background ? { ...cur.background, ...patch.background } : cur.background,
    shadow: patch.shadow ? { ...cur.shadow, ...patch.shadow } : cur.shadow
  }
  const clip: Clip = { ...loc.clip, text: next, name: next.text || loc.clip.name }
  return mapTrack(doc, loc.track.id, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === clipId ? clip : c)) }))
}

/** Merge into a clip's crop rectangle (fractions removed from each edge). */
export function setClipCropInDoc(
  doc: TimelineDocument,
  clipId: string,
  patch: { left?: number; top?: number; right?: number; bottom?: number }
): TimelineDocument {
  const loc = findClip(doc, clipId)
  if (!loc) return doc
  const next: Clip = { ...loc.clip, crop: { ...loc.clip.crop, ...patch } }
  return mapTrack(doc, loc.track.id, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === clipId ? next : c)) }))
}

/** Set a clip's audio gain (0 = silent, 1 = original; export may boost). */
export function setClipGainInDoc(doc: TimelineDocument, clipId: string, gain: number): TimelineDocument {
  const loc = findClip(doc, clipId)
  if (!loc) return doc
  const g = Math.max(0, Math.min(4, gain))
  if (g === loc.clip.gain) return doc
  const next: Clip = { ...loc.clip, gain: g }
  return mapTrack(doc, loc.track.id, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === clipId ? next : c)) }))
}

/** Set the static (non-keyframed) value of a clip's transform x / y / scale. */
export function setClipTransformStaticInDoc(
  doc: TimelineDocument,
  clipId: string,
  patch: { x?: number; y?: number; scale?: number }
): TimelineDocument {
  const loc = findClip(doc, clipId)
  if (!loc) return doc
  const t = loc.clip.transform
  const next: Clip = {
    ...loc.clip,
    transform: {
      ...t,
      x: patch.x !== undefined ? { ...t.x, static: patch.x } : t.x,
      y: patch.y !== undefined ? { ...t.y, static: patch.y } : t.y,
      scale: patch.scale !== undefined ? { ...t.scale, static: patch.scale } : t.scale
    }
  }
  return mapTrack(doc, loc.track.id, (tr) => ({ ...tr, clips: tr.clips.map((c) => (c.id === clipId ? next : c)) }))
}

export function addMarkerToDoc(doc: TimelineDocument, marker: Marker): TimelineDocument {
  return { ...doc, markers: [...doc.markers, marker].sort((a, b) => a.frame - b.frame) }
}

export function removeMarkerFromDoc(doc: TimelineDocument, markerId: string): TimelineDocument {
  const markers = doc.markers.filter((m) => m.id !== markerId)
  return markers.length === doc.markers.length ? doc : { ...doc, markers }
}

/** Duration of a single source frame in source seconds (helper for callers). */
export function sourceFrameSeconds(clip: Clip, tb: Timebase): number {
  return frameSeconds(tb) * clip.speed
}

// ---------------------------------------------------------------------------
// Magnetic timeline: gapless lanes. A magnetic lane keeps its clips butted in
// order from a fixed anchor (its earliest clip's start). Moving reorders; trims
// ripple. These are used when settings.magnet is on; the free variants above
// are used when it is off.
// ---------------------------------------------------------------------------

/** The frame a magnetic lane begins at. The main lane always starts at 0; other
 *  gapless lanes keep their earliest clip's start. */
function laneAnchor(track: Track): number {
  if (track.isMain) return 0
  let min = Number.POSITIVE_INFINITY
  for (const c of track.clips) if (c.start < min) min = c.start
  return Number.isFinite(min) ? Math.max(0, min) : 0
}

/** Lay clips out contiguously (in the given order) starting at `anchor`. */
function layoutFrom(clips: Clip[], anchor: number): Clip[] {
  let cursor = Math.max(0, anchor)
  return clips.map((c) => {
    const start = cursor
    cursor += c.duration
    return c.start === start && c.end === start + c.duration ? c : { ...c, start, end: start + c.duration }
  })
}

/** Insert index for a clip dropped at `dropStart`: after every clip whose midpoint it passed. */
function insertionIndexByMidpoint(clips: Clip[], dropStart: number): number {
  let i = 0
  for (const c of clips) {
    if (dropStart >= c.start + c.duration / 2) i++
    else break
  }
  return i
}

/** Re-lay a single track's clips gaplessly from its anchor (sort by start first). */
export function relayoutTrackGapless(track: Track): Track {
  if (track.clips.length === 0) return track
  const sorted = [...track.clips].sort((a, b) => a.start - b.start)
  const laid = layoutFrom(sorted, laneAnchor(track))
  let changed = laid.length !== track.clips.length
  if (!changed) for (let i = 0; i < laid.length; i++) if (laid[i] !== track.clips[i]) { changed = true; break }
  return changed ? { ...track, clips: laid } : track
}

/** Close all gaps in a lane (used when magnet is switched on). No-op if already tight. */
export function compactTrackInDoc(doc: TimelineDocument, trackId: string): TimelineDocument {
  if (!findTrack(doc, trackId)) return doc
  return normalizeDoc(mapTrack(doc, trackId, (t) => relayoutTrackGapless(t)))
}

/**
 * Magnetic move: reorder within a lane (or insert into another), keeping both
 * the origin and target lanes gapless. Insertion point is chosen by `dropStart`.
 */
export function magnetMoveInDoc(
  doc: TimelineDocument,
  clipId: string,
  toTrackId: string,
  dropStart: number
): TimelineDocument {
  const loc = findClip(doc, clipId)
  if (!loc || !findTrack(doc, toTrackId)) return doc
  const { track: originTrack, clip } = loc

  if (toTrackId === originTrack.id) {
    const others = originTrack.clips.filter((c) => c.id !== clipId).sort((a, b) => a.start - b.start)
    const idx = insertionIndexByMidpoint(others, dropStart)
    const ordered = [...others.slice(0, idx), clip, ...others.slice(idx)]
    const laid = layoutFrom(ordered, laneAnchor(originTrack))
    return normalizeDoc(mapTrack(doc, originTrack.id, (t) => ({ ...t, clips: laid })))
  }

  const targetTrack = findTrack(doc, toTrackId) as Track
  const originRemaining = originTrack.clips.filter((c) => c.id !== clipId).sort((a, b) => a.start - b.start)
  const originLaid = layoutFrom(originRemaining, laneAnchor(originTrack))
  const targetAnchor = targetTrack.clips.length ? laneAnchor(targetTrack) : Math.max(0, dropStart)
  const targetOthers = [...targetTrack.clips].sort((a, b) => a.start - b.start)
  const idx = insertionIndexByMidpoint(targetOthers, dropStart)
  const moved: Clip = { ...clip, trackId: toTrackId }
  const targetOrdered = [...targetOthers.slice(0, idx), moved, ...targetOthers.slice(idx)]
  const targetLaid = layoutFrom(targetOrdered, targetAnchor)

  const tracks = doc.tracks.map((t) => {
    if (t.id === originTrack.id) return { ...t, clips: originLaid }
    if (t.id === toTrackId) return { ...t, clips: targetLaid }
    return t
  })
  return normalizeDoc({ ...doc, tracks })
}

/** Magnetic left-edge trim: trim, then close the lane so neighbours ripple. */
export function magnetTrimInInDoc(
  doc: TimelineDocument,
  clipId: string,
  newStart: number,
  tb: Timebase
): TimelineDocument {
  const trimmed = trimClipInInDoc(doc, clipId, newStart, tb)
  if (trimmed === doc) return doc
  const loc = findClip(trimmed, clipId)
  if (!loc) return trimmed
  return normalizeDoc(mapTrack(trimmed, loc.track.id, (t) => relayoutTrackGapless(t)))
}

/** Magnetic right-edge trim: trim, then close the lane so neighbours ripple. */
export function magnetTrimOutInDoc(
  doc: TimelineDocument,
  clipId: string,
  newEnd: number,
  tb: Timebase
): TimelineDocument {
  const trimmed = trimClipOutInDoc(doc, clipId, newEnd, tb)
  if (trimmed === doc) return doc
  const loc = findClip(trimmed, clipId)
  if (!loc) return trimmed
  return normalizeDoc(mapTrack(trimmed, loc.track.id, (t) => relayoutTrackGapless(t)))
}

// ---------------------------------------------------------------------------
// Detach audio: extract a video clip's audio into a linked audio clip on an
// audio lane below (reuse the first audio lane free over the clip's span, else
// create a new one at the bottom). The video clip keeps its frames, goes muted,
// and is linked to the new audio clip so they can move together.
// ---------------------------------------------------------------------------

export function detachAudioInDoc(doc: TimelineDocument, clipId: string): TimelineDocument {
  const loc = findClip(doc, clipId)
  if (!loc) return doc
  const { clip } = loc
  if (!clip.hasAudio || clip.audioDetached || !isTimeBased(clip)) return doc

  const audioTracks = doc.tracks.filter((t) => t.kind === 'audio').sort((a, b) => a.order - b.order)
  const free = audioTracks.find(
    (t) => !t.clips.some((c) => c.start < clip.end && c.end > clip.start)
  )

  let working = doc
  let targetTrackId: string
  if (free) {
    targetTrackId = free.id
  } else {
    const order = doc.tracks.reduce((m, t) => Math.max(m, t.order), -1) + 1
    const track = createTrack({ kind: 'audio', order, name: `Audio ${audioTracks.length + 1}` })
    targetTrackId = track.id
    working = addTrackToDoc(doc, track)
  }

  const audioClip = createClip({
    kind: 'audio',
    trackId: targetTrackId,
    start: clip.start,
    duration: clip.duration,
    sourcePath: clip.sourcePath,
    sourceIn: clip.sourceIn,
    sourceOut: clip.sourceOut,
    sourceDuration: clip.sourceDuration,
    name: clip.name,
    speed: clip.speed,
    reversed: clip.reversed,
    hasAudio: true
  })
  audioClip.gain = clip.gain
  audioClip.linkedClipIds = [clip.id]

  working = addClipToDoc(working, audioClip)
  const video: Clip = {
    ...clip,
    audioDetached: true,
    muted: true,
    linkedClipIds: [...clip.linkedClipIds, audioClip.id]
  }
  return normalizeDoc(replaceClip(working, video))
}

// ---------------------------------------------------------------------------
// Per-track move. The main track (isMain) is always gapless — clips reorder and
// ripple; every other track is free-position. This replaces the global magnet
// switch for movement: whether a lane closes gaps is a property of the lane.
// ---------------------------------------------------------------------------

/** A lane is gapless (ripples on edits) only when it is the main lane AND magnet is on. */
function isGapless(track: Track, magnet: boolean): boolean {
  return track.isMain === true && magnet
}

/** The document's main (primary) track id, if any. */
export function mainTrackId(doc: TimelineDocument): string | undefined {
  return doc.tracks.find((t) => t.isMain)?.id
}

export function moveClipSmartInDoc(
  doc: TimelineDocument,
  clipId: string,
  toTrackId: string,
  dropStart: number,
  magnet: boolean,
  noCollide = false
): TimelineDocument {
  const loc = findClip(doc, clipId)
  const target = findTrack(doc, toTrackId)
  if (!loc || !target) return doc
  const origin = loc.track
  const clip = loc.clip
  const start = Math.max(0, Math.round(dropStart))

  // same track
  if (toTrackId === origin.id) {
    const same = isGapless(origin, magnet)
      ? magnetMoveInDoc(doc, clipId, toTrackId, start)
      : moveClipInDoc(doc, clipId, toTrackId, start, noCollide)
    return pruneEmptyAutoTracksInDoc(same)
  }

  // cross track: close the origin lane if it is gapless; leave the gap otherwise
  const originRemaining = origin.clips.filter((c) => c.id !== clipId).sort((a, b) => a.start - b.start)
  const originClips = isGapless(origin, magnet) ? layoutFrom(originRemaining, laneAnchor(origin)) : originRemaining

  const moved: Clip = { ...clip, trackId: toTrackId }
  let targetClips: Clip[]
  if (isGapless(target, magnet)) {
    const others = [...target.clips].sort((a, b) => a.start - b.start)
    const idx = insertionIndexByMidpoint(others, start)
    const anchor = target.clips.length ? laneAnchor(target) : start
    targetClips = layoutFrom([...others.slice(0, idx), moved, ...others.slice(idx)], anchor)
  } else {
    // Free-position lane: never stack — land in the nearest spot that fits.
    const s = noCollide ? start : resolveFreeStart(target.clips, start, clip.duration)
    targetClips = [...target.clips, { ...moved, start: s, end: s + clip.duration }]
  }

  const tracks = doc.tracks.map((t) => {
    if (t.id === origin.id) return { ...t, clips: originClips }
    if (t.id === toTrackId) return { ...t, clips: targetClips }
    return t
  })
  return pruneEmptyAutoTracksInDoc(normalizeDoc({ ...doc, tracks }))
}

/** Drop empty auto-created lanes (never the main lane or a user-added lane). */
export function pruneEmptyAutoTracksInDoc(doc: TimelineDocument): TimelineDocument {
  const keep = doc.tracks.filter((t) => !(t.autoCreated && !t.isMain && t.clips.length === 0))
  return keep.length === doc.tracks.length ? doc : normalizeDoc({ ...doc, tracks: keep })
}

/** Append a clip to the end of the main lane (imports land here, gaplessly). */
export function addClipToMainInDoc(doc: TimelineDocument, clip: Clip): TimelineDocument {
  const mainId = mainTrackId(doc)
  const track = (mainId && findTrack(doc, mainId)) || doc.tracks.find((t) => t.kind === 'video')
  if (!track) return doc
  const at = trackContentEnd(track)
  return addClipToDoc(doc, { ...clip, trackId: track.id, start: at, end: at + clip.duration })
}

/**
 * Insert a clip into the main lane at the drop frame, rippling the clips after
 * the insertion point to the right by the clip's duration so nothing is
 * overwritten (CapCut-style insert). The insertion lands on the clip BOUNDARY
 * nearest the drop (midpoint rule — same as a magnet move), so it slots between
 * clips rather than slicing one; a drop past the content end just appends. Gaps
 * before the insertion point are preserved (magnet-off lanes keep their layout).
 */
export function insertClipIntoMainInDoc(
  doc: TimelineDocument,
  clip: Clip,
  atFrame: number
): TimelineDocument {
  const mainId = mainTrackId(doc)
  const track = (mainId && findTrack(doc, mainId)) || doc.tracks.find((t) => t.kind === 'video')
  if (!track) return doc
  const sorted = [...track.clips].sort((a, b) => a.start - b.start)
  const at = Math.max(0, Math.round(atFrame))
  const idx = insertionIndexByMidpoint(sorted, at)
  const boundary = idx < sorted.length ? sorted[idx].start : trackContentEnd(track)
  const placed: Clip = { ...clip, trackId: track.id, start: boundary, end: boundary + clip.duration }
  const rippled = sorted.map((c) => (c.start >= boundary ? shiftClip(c, clip.duration) : c))
  return normalizeDoc(mapTrack(doc, track.id, (t) => ({ ...t, clips: [...rippled, placed] })))
}

// ---------------------------------------------------------------------------
// Professional trims: roll (move a shared cut between two adjacent clips),
// slip (shift a clip's source content without moving it), slide (move a clip
// while its neighbours' adjacent edges absorb the shift). Each clamps to media.
// ---------------------------------------------------------------------------

/** Roll the cut between `leftClipId` and its right neighbour to `newBoundary`. */
export function rollEditInDoc(
  doc: TimelineDocument,
  leftClipId: string,
  newBoundary: number,
  tb: Timebase
): TimelineDocument {
  const ll = findClip(doc, leftClipId)
  if (!ll) return doc
  const left = ll.clip
  const right = ll.track.clips.find((c) => c.id !== left.id && c.start === left.end)
  if (!right) return doc
  const lo = Math.max(left.start + 1, left.end - headroomBeforeFrames(right, tb))
  const hi = Math.min(right.end - 1, left.end + headroomAfterFrames(left, tb))
  const nb = Math.max(lo, Math.min(Math.round(newBoundary), hi))
  if (nb === left.end) return doc
  let d = trimClipOutInDoc(doc, left.id, nb, tb)
  d = trimClipInInDoc(d, right.id, nb, tb)
  return d
}

/** Slip: shift a clip's source window by `deltaFrames` of timeline motion; its
 *  timeline start/duration stay put, only the visible content changes. */
export function slipClipInDoc(
  doc: TimelineDocument,
  clipId: string,
  deltaFrames: number,
  tb: Timebase
): TimelineDocument {
  const loc = findClip(doc, clipId)
  if (!loc || !isTimeBased(loc.clip)) return doc
  const clip = loc.clip
  const deltaSec = framesToSeconds(Math.round(deltaFrames), tb) * clip.speed
  const span = clip.sourceOut - clip.sourceIn
  const maxSrc = clip.sourceDuration ?? clip.sourceOut
  let inS = clip.sourceIn + deltaSec
  let outS = clip.sourceOut + deltaSec
  if (inS < 0) {
    inS = 0
    outS = span
  }
  if (outS > maxSrc) {
    outS = maxSrc
    inS = Math.max(0, maxSrc - span)
  }
  if (Math.abs(inS - clip.sourceIn) < 1e-9) return doc
  return normalizeDoc(replaceClip(doc, { ...clip, sourceIn: inS, sourceOut: outS }))
}

/**
 * Apply a set of TIMELINE frame ranges to remove from a track: split each range
 * out of the clip it falls in and ripple-delete it, closing the gap. This is how
 * the cut engines' output (deleted words + silence, converted to timeline frames)
 * becomes real edits on the clip model — so the clip model is the single source
 * of truth and preview == export both render it. Processed right-to-left so
 * earlier ranges keep their coordinates as later ripples shift the tail.
 */
export function applyDeletionsToDocument(
  doc: TimelineDocument,
  trackId: string,
  ranges: Array<{ start: number; end: number }>,
  tb: Timebase
): TimelineDocument {
  const sorted = ranges
    .map((r) => ({ start: Math.round(r.start), end: Math.round(r.end) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => b.start - a.start)
  let d = doc
  for (const r of sorted) {
    const track = findTrack(d, trackId)
    if (!track) break
    const mid = (r.start + r.end) / 2
    const clip = track.clips.find((c) => c.start < mid && c.end > mid)
    if (!clip) continue
    const f0 = Math.max(r.start, clip.start)
    const f1 = Math.min(r.end, clip.end)
    if (f1 - f0 < 1) continue
    // isolate [f0,f1] as its own clip (split right edge, then left edge)...
    d = splitClipInDoc(d, clip.id, f1, tb)
    d = splitClipInDoc(d, clip.id, f0, tb)
    const mt = findTrack(d, trackId)
    const middle = mt?.clips.find((c) => c.start === f0 && c.end === f1)
    // ...then ripple-delete it (closes the gap; main lane stays gapless).
    if (middle) d = removeClipFromDoc(d, middle.id, true)
  }
  return d
}

/** A concrete kept segment for preview/export: which source slice plays when. */
export interface KeptSegment {
  sourcePath: string
  /** source in/out (seconds). */
  in: number
  out: number
  /** where it starts on the timeline (frames). */
  start: number
  hasAudio: boolean
}

/**
 * The ordered kept segments of a lane (the base by default). Preview and export
 * both walk THIS off the clip model, so they render identically — the clip model
 * is the single source of truth and there is no separate keep-range derivation.
 */
export function documentMainKeeps(doc: TimelineDocument, trackId?: string): KeptSegment[] {
  const id = trackId ?? mainTrackId(doc)
  const track = id ? findTrack(doc, id) : undefined
  if (!track) return []
  return [...track.clips]
    .sort((a, b) => a.start - b.start)
    .filter((c) => !!c.sourcePath)
    .map((c) => ({ sourcePath: c.sourcePath as string, in: c.sourceIn, out: c.sourceOut, start: c.start, hasAudio: c.hasAudio }))
}

/** Slide: move a clip to `newStart`; the previous clip's out and next clip's in
 *  absorb the shift so the lane stays connected and the clip keeps its content. */
export function slideClipInDoc(
  doc: TimelineDocument,
  clipId: string,
  newStart: number,
  tb: Timebase
): TimelineDocument {
  const loc = findClip(doc, clipId)
  if (!loc) return doc
  const clip = loc.clip
  const track = loc.track
  const prev = track.clips.find((c) => c.id !== clip.id && c.end === clip.start)
  const next = track.clips.find((c) => c.id !== clip.id && c.start === clip.end)
  let shift = Math.round(newStart) - clip.start
  shift = Math.max(shift, -clip.start)
  if (prev) {
    shift = Math.min(shift, headroomAfterFrames(prev, tb))
    shift = Math.max(shift, prev.start + 1 - clip.start)
  }
  if (next) {
    shift = Math.min(shift, headroomBeforeFrames(next, tb))
    shift = Math.min(shift, next.end - 1 - clip.end)
  }
  if (shift === 0) return doc
  let d = doc
  if (prev) d = trimClipOutInDoc(d, prev.id, clip.start + shift, tb)
  if (next) d = trimClipInInDoc(d, next.id, clip.end + shift, tb)
  const cur = findClip(d, clipId)
  if (!cur) return doc
  return normalizeDoc(moveClipInDoc(d, clipId, track.id, cur.clip.start + shift))
}
