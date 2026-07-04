// The timeline data model. Two halves, deliberately separated:
//
//   TimelineDocument  — the UNDOABLE document (tracks, clips, markers). Every
//                       edit is a Command that maps a document to a new document;
//                       History snapshots documents for undo/redo.
//   SessionState      — NON-undoable view/session state (playhead, zoom,
//                       magnet/snap settings). Kept out of history so moving the
//                       playhead never pollutes undo and undo never yanks it.
//
// All timeline positions/durations are integer FRAMES at `TimelineDocument.timebase`.
// Source in/out points are SECONDS in the source media.

import type { Timebase } from './time'

export type TrackKind =
  | 'video'
  | 'audio'
  | 'text'
  | 'overlay'
  | 'subtitle'
  | 'effect'
  | 'adjustment'

export type ClipKind =
  | 'video'
  | 'audio'
  | 'image'
  | 'gif'
  | 'compound'
  | 'nested'
  | 'text'
  | 'title'
  | 'effect'
  | 'transition'
  | 'adjustment'
  | 'speed'
  | 'freeze'

// ---------------------------------------------------------------------------
// Keyframes / animatable properties
// ---------------------------------------------------------------------------

/** Interpolation into a keyframe from the previous one. */
export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'hold'

export interface Keyframe<T = number> {
  /** offset from the clip's own start, in timeline frames. */
  frame: number
  value: T
  /** easing applied on the segment ENTERING this keyframe (from the previous one). */
  easing: Easing
}

/** A property that is either constant (`static`) or driven by keyframes. */
export interface Animatable<T = number> {
  static: T
  keyframes?: Keyframe<T>[]
}

export interface Transform {
  /** x/y offset as a fraction of frame size; 0 = centered. */
  x: Animatable
  y: Animatable
  /** uniform scale; 1 = 100%. */
  scale: Animatable
  /** rotation in degrees. */
  rotation: Animatable
  /** 0..1. */
  opacity: Animatable
  /** anchor point within the clip (0..1); rotation/scale pivot. */
  anchorX: number
  anchorY: number
}

/** Fractions removed from each edge of the source. */
export interface Crop {
  left: number
  top: number
  right: number
  bottom: number
}

export interface ColorCorrection {
  brightness: number
  contrast: number
  saturation: number
  temperature: number
  tint: number
  hue: number
  exposure: number
  highlights: number
  shadows: number
  lift: number
  gamma: number
  gain: number
  /** optional LUT identifier / path. */
  lut?: string
}

export type MaskShape = 'rectangle' | 'ellipse' | 'linear' | 'radial' | 'polygon'

export interface Mask {
  id: string
  shape: MaskShape
  /** center + size as fractions of the frame. */
  x: number
  y: number
  width: number
  height: number
  rotation: number
  feather: number
  /** corner rounding for rectangle masks (0..1). */
  rounded: number
  inverted: boolean
  /** polygon vertices (fractions), when shape === 'polygon'. */
  points?: Array<{ x: number; y: number }>
}

export interface Effect {
  id: string
  /** effect identifier, e.g. "gaussianBlur", "glow". */
  type: string
  enabled: boolean
  params: Record<string, number | string | boolean>
  /** per-parameter keyframes (values sampled frame-relative to the clip). */
  keyframes?: Record<string, Keyframe[]>
}

export type TransitionKind =
  | 'crossDissolve'
  | 'fade'
  | 'wipe'
  | 'slide'
  | 'zoom'
  | 'glitch'
  | 'none'

export interface Transition {
  id: string
  kind: TransitionKind
  /** duration in timeline frames, centered on the cut. */
  durationFrames: number
  params?: Record<string, number | string | boolean>
}

/** Text payload for text / title / subtitle clips. Sizes are fractions of frame height. */
export interface TextContent {
  text: string
  fontFamily: string
  fontSize: number
  color: string
  align: 'left' | 'center' | 'right'
  bold: boolean
  italic: boolean
  underline: boolean
  strokeWidth: number
  strokeColor: string
  background: {
    enabled: boolean
    color: string
    opacity: number
    radius: number
    padding: number
  }
  shadow: {
    enabled: boolean
    color: string
    blur: number
    dx: number
    dy: number
  }
  letterSpacing: number
  lineHeight: number
}

export type ProxyState = 'none' | 'requested' | 'generating' | 'ready' | 'failed'

/** Handles into the background cache managers (waveform/thumbnail data lives there, not here). */
export interface CacheRefs {
  waveformKey?: string
  thumbnailKey?: string
  proxy: ProxyState
  proxyPath?: string
}

/**
 * A clip on a track.
 * Placement (`start`/`duration`/`end`) is in timeline FRAMES; `end` is derived
 * (start + duration) and kept consistent by the model. Source in/out are SECONDS.
 */
export interface Clip {
  id: string
  kind: ClipKind
  trackId: string
  name: string

  // --- source media ---
  /** absent for pure text / adjustment / effect clips. */
  sourcePath?: string
  /** slice of the source used (seconds). */
  sourceIn: number
  sourceOut: number
  /** full source length (seconds); used to clamp trim handles. */
  sourceDuration?: number
  srcW?: number
  srcH?: number
  srcFps?: number

  // --- placement (frames) ---
  start: number
  duration: number
  /** = start + duration (maintained by the model). */
  end: number

  // --- time behavior ---
  /** 1 = normal, 2 = 2x, 0.5 = half. */
  speed: number
  reversed: boolean
  /** freeze-frame clip: holds a single source frame for its whole duration. */
  freeze?: boolean

  // --- linking / grouping / nesting ---
  /** ids of clips that move/trim together (e.g. detached A/V pair). */
  linkedClipIds: string[]
  groupId?: string
  /** compound/nested clips embed a sub-document. */
  nested?: TimelineDocument
  /** id of the compound definition this instance came from. */
  compoundOf?: string

  // --- visual ---
  transform: Transform
  crop: Crop
  masks: Mask[]
  effects: Effect[]
  color: ColorCorrection
  transitionIn?: Transition
  transitionOut?: Transition

  // --- audio ---
  /** the source carries an audio stream (video with sound, or an audio file). */
  hasAudio: boolean
  /** audio has been extracted to a linked audio clip; this clip renders video-only. */
  audioDetached?: boolean
  /** linear gain; 1 = 0 dB. */
  gain: number
  muted: boolean
  fadeInFrames: number
  fadeOutFrames: number

  // --- text (text/title/subtitle clips) ---
  text?: TextContent

  // --- misc ---
  enabled: boolean
  metadata: Record<string, string | number | boolean>
  cache: CacheRefs
}

export interface Track {
  id: string
  kind: TrackKind
  name: string
  /** stacking order; the model keeps `tracks` sorted ascending by this. */
  order: number
  /** lane height in px (independent per track). */
  height: number
  collapsed: boolean
  locked: boolean
  muted: boolean
  /** visibility toggle (video/overlay lanes); audio uses `muted`. */
  hidden: boolean
  solo: boolean
  /** the primary storyline: always gapless, receives imports first. Exactly one per document. */
  isMain?: boolean
  /** created on-the-fly by a drag/detach; auto-removed once it becomes empty. */
  autoCreated?: boolean
  /** kept sorted by `start`. */
  clips: Clip[]
}

export interface Marker {
  id: string
  frame: number
  name: string
  color: string
}

/** The undoable document. */
export interface TimelineDocument {
  id: string
  timebase: Timebase
  /** sorted ascending by `Track.order`. */
  tracks: Track[]
  markers: Marker[]
  /** content length in frames = max clip end across all tracks (maintained). */
  duration: number
}

export interface TimelineSettings {
  /** magnetic/ripple timeline: gaps close, neighbours push, insert edits. */
  magnet: boolean
  /** edge/playhead/marker snapping while dragging & trimming. */
  snapping: boolean
  snapThresholdPx: number
  /** ripple edits propagate across all tracks, not just the edited one. */
  rippleAcrossTracks: boolean
  /** fraction (0..1) of a clip's height its audio waveform occupies (CapCut: 30/60/100%). */
  waveformSize: number
}

/** Non-undoable session/view state. */
export interface SessionState {
  /** playhead position in frames. */
  playhead: number
  /** horizontal zoom in pixels-per-second. */
  zoom: number
  settings: TimelineSettings
}

export type DragKind = 'move' | 'trimIn' | 'trimOut' | 'slip' | 'slide' | 'roll'

/** A live, uncommitted drag/trim in progress. The renderer shows `preview`
 *  instead of the committed document; the drop commits ONE command. */
export interface DragState {
  kind: DragKind
  clipId: string
  /** the pointer frame at grab time (for slip/slide deltas). */
  grabFrame: number
  /** clip.start - grabFrame at begin, so the clip tracks the pointer without jumping. */
  grabOffset: number
  originTrackId: string
  originStart: number
  originDuration: number
  /** where the drop/edge currently lands (frames) — reused verbatim on commit. */
  dropFrame: number
  /** track the move would drop onto. */
  targetTrackId: string
  /** set when the drop would create a brand-new lane above/below the stack. */
  newTrackZone?: 'above' | 'below' | null
  /** stable id of that pending new lane (so the preview lane doesn't churn). */
  newTrackId?: string | null
  /** when moving a multi-selection: every selected clip's start at grab time. */
  group?: Array<{ clipId: string; originStart: number }> | null
  /** the whole document as it would look right now (uncommitted). */
  preview: TimelineDocument
  /** a snap guide line to draw (frames), or null. */
  snapLine: number | null
}

/** Transient interaction state (selection + in-flight drag). Not undoable. */
export interface InteractionState {
  selection: string[]
  drag: DragState | null
}
