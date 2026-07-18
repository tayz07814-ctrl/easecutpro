// Shared data model used by both the main (Node) and renderer (React) processes.

import type { TimelineDocument } from './timeline/types'

/** A single transcribed word with its time range in the SOURCE media (seconds). */
export interface Word {
  id: string
  text: string
  start: number
  end: number
  /** Optional ASR confidence/probability in [0,1], when the backend provides it. */
  conf?: number
  confidence?: number
  /** diarization speaker label (e.g. "A"/"B") when the transcript was diarized. */
  speaker?: string
  /** true = struck out / removed from the edit (still in source). */
  deleted?: boolean
}

/** A transcript segment (sentence-ish), grouping words. */
export interface Segment {
  id: string
  start: number
  end: number
  words: Word[]
}

export interface Transcript {
  segments: Segment[]
  /** flat convenience list of all words in order. */
  words: Word[]
}

/** A detected silence region in the SOURCE media (seconds). */
export interface SilenceRegion {
  id: string
  start: number
  end: number
  /** how the user chose to treat it. */
  action: 'keep' | 'remove' | 'shorten'
  /** target duration (seconds) when action === 'shorten'. */
  shortenTo?: number
  /** Retake β word-clamped silence: apply [start,end] VERBATIM in
   *  computeKeepRanges — NO edgeTrim / valley-snap / blip-absorb / bridge. The
   *  boundaries are already safe (guarded off the transcript words). FastCut /
   *  ProCut never set this, so their silence behaviour is unchanged. */
  protect?: boolean
}

export interface Waveform {
  peaksPerSec: number
  /** normalized 0..1 amplitude peaks. */
  peaks: number[]
}

export interface Thumb {
  time: number
  /** base64 jpeg data URL. */
  url: string
}

/** Probe metadata for a media file. */
export interface MediaInfo {
  path: string
  duration: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
  hasVideo: boolean
}

/**
 * An item in the reusable media library ("import once, reuse many").
 * Persisted to localStorage so it survives across projects/sessions.
 */
export interface LibraryItem {
  id: string
  path: string
  name: string
  kind: 'video' | 'audio' | 'image'
  duration: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
  hasVideo: boolean
  /** small preview: data URL (a video frame) or ecmedia URL (an image); absent for audio. */
  thumb?: string
}

/**
 * A clip placed on a timeline track.
 * sourceIn/sourceOut = the slice of the source media used.
 * start = where the clip begins on the timeline (seconds).
 */
export interface Clip {
  id: string
  name: string
  sourcePath: string
  sourceIn: number
  sourceOut: number
  start: number
  /** full duration of the source media, so trim handles can clamp/extend. */
  sourceDuration?: number
  /** true for still images (rendered as <img>, looped on export). */
  isImage?: boolean
  /** source pixel dimensions (for crop math / aspect). */
  srcW?: number
  srcH?: number
  /** transform on the base frame (fractions 0..1). x,y = top-left of overlay. */
  x: number
  y: number
  /** overlay width as a fraction of the base frame width. */
  scale: number
  /** crop, as fractions removed from each side of the source. */
  crop: { l: number; t: number; r: number; b: number }
  /** Ken Burns zoom across the clip: 1 = 100% (original). */
  zoomStart: number
  zoomEnd: number
  // ---- AI overlay link (set when an overlay rule placed this clip) ----
  /** the OverlayRule.overlayId that produced this clip (presence = AI-generated). */
  overlayRuleId?: string
  /** in/out animation for the overlay render. */
  overlayAnimation?: OverlayAnimation
  /** why it was placed (transcript moment) — tooltip / debug. */
  overlayReason?: string
}

export const DEFAULT_CROP = { l: 0, t: 0, r: 0, b: 0 }

/** A background-music / OST clip mixed under the edited timeline. */
export interface MusicClip {
  path: string
  name: string
  /** source duration (seconds). */
  duration: number
  /** playback gain (1 = original; preview caps at 1, export can boost). */
  gain: number
  /** where it starts on the EDITED timeline (seconds). */
  startAt: number
  /** where it stops on the EDITED timeline (seconds); undefined = end of edit. */
  endAt?: number
  /** loop to fill its span on the edited timeline. */
  loop: boolean
}

/** Export-only: an audio-lane clip folded out of the timeline document (detached
 *  audio, dropped audio, or the music lane) so the render mixes it under the edit
 *  at its EDITED-timeline position. Produced by documentToProject; not persisted
 *  for legacy projects (which use `music` instead). */
export interface ExtraAudioClip {
  path: string
  /** source in/out (seconds). */
  in: number
  out: number
  /** start on the EDITED timeline (seconds). */
  startAt: number
  /** playback gain (1 = original). */
  gain: number
}

/** One clip in a multi-clip base sequence (montage mode). Plays back-to-back with audio. */
export interface SequenceClip {
  id: string
  sourcePath: string
  name: string
  /** trimmed in/out within the source (seconds). */
  sourceIn: number
  sourceOut: number
  sourceDuration: number
  hasAudio: boolean
  srcW: number
  srcH: number
  fps: number
  /** still image used as a base clip (shown for `sourceOut` seconds). */
  isImage?: boolean
  // ---- per-clip cleaning (montage Phase 3) — same model as a single-clip edit ----
  transcript?: Transcript
  silences?: SilenceRegion[]
  manualCuts?: { start: number; end: number; final?: boolean }[]
  keepOverrides?: { start: number; end: number }[]
  silencePadding?: number
  /** free horizontal position on the timeline (seconds) when magnet is OFF.
   *  Absent = magnet-glued contiguous (laid out back-to-back). */
  laneStart?: number
  // ---- per-clip transform / speed / volume (doc-mode base clips; Basic tab) ----
  // Mirror the values SequencePreview applies to the base <video> so export
  // matches the preview. All optional; absent = identity (untransformed export
  // stays byte-identical). Populated by documentToProject from the doc clip.
  /** playback speed (1 = normal); edited length = (sourceOut-sourceIn)/speed. */
  speed?: number
  /** linear audio gain (1 = original volume). */
  gain?: number
  /** "Size" (ovScale): 1 = fill the frame; <1 shrinks (letterbox), >1 zooms in. */
  size?: number
  /** Ken Burns zoom start/end (>=1); animates across the clip. */
  zoomStart?: number
  zoomEnd?: number
  /** pan focal offset from centre, as a fraction (-0.5..0.5). */
  panX?: number
  panY?: number
}

/** A visual segment of the base (A-roll) track. */
export interface BaseSegment {
  start: number
  end: number
  kind: 'keep' | 'cut'
  /** a `cut` that was FINAL-deleted: render empty (no hatch), still reclaimable. */
  final?: boolean
}

/** An on-screen text overlay. Sizes are fractions for resolution independence. */
export interface TextClip {
  id: string
  text: string
  /** timeline time range (source seconds). */
  start: number
  end: number
  /** center position as a fraction of the frame (0..1). */
  x: number
  y: number
  fontFamily: string
  /** font size as a fraction of frame height (e.g. 0.07). */
  fontSize: number
  color: string
  align: 'left' | 'center' | 'right'
  bold: boolean
  italic: boolean
  /** stroke width as a fraction of font size. */
  strokeWidth: number
  strokeColor: string
  bgEnabled: boolean
  bgColor: string
  /** corner radius + padding as fractions of font size. */
  bgRadius: number
  bgPadding: number
  bgOpacity: number
  /** true = auto-generated from the transcript (Captions tab); lets a regenerate
   *  replace the previous batch without touching hand-added text. */
  caption?: boolean
}

export interface Track {
  id: string
  /** 0 = base (A-roll), 1 & 2 = overlay / b-roll. */
  index: number
  name: string
  muted: boolean
  hidden: boolean
  clips: Clip[]
}

export interface Project {
  version: number
  name: string
  /** the primary imported media (A-roll), for single-clip mode. */
  media?: MediaInfo
  /** multi-clip base sequence (montage mode). When non-empty, the base is these clips concatenated. */
  baseSequence?: SequenceClip[]
  transcript?: Transcript
  silences: SilenceRegion[]
  tracks: Track[]
  /** seconds; UI playhead position. */
  playhead: number
  /** pixels per second zoom for the timeline. */
  pxPerSec: number
  /** snapping / magnet enabled. */
  magnet: boolean
  /** Smart Smooth Cut (beta): per-segment audio fade at cut seams (ms).
   *  Unset = classic export behavior (no fades). Only the smart-smooth mode
   *  sets this. TODO: upgrade to true acrossfade between segments. */
  smoothAudioFadeMs?: number
  /** Cut Lord "trim cuts": extra splice trim on word cuts (seconds).
   *  Unset = classic 0.1s. Set by Execute cuts from the ⚙ profile. */
  wordCutPad?: number
  /** track lane height in px (CapCut-style adjustable). */
  trackHeight: number
  /** manual split points on the base track (source seconds). */
  baseSplits: number[]
  /** ranges deleted by hand from the base track (source seconds). `final` cuts
   *  render as empty/invisible (reclaim by dragging trim handles); soft cuts
   *  render greyed + red-hatched as a visible placeholder. */
  manualCuts: { start: number; end: number; final?: boolean }[]
  /** ranges force-KEPT even if a cut covers them (manual restore of a cut). */
  keepOverrides: { start: number; end: number }[]
  /** seconds of silence kept on each side of a removed gap (avoid clipping speech). */
  silencePadding: number
  /** show filmstrip thumbnails on the base track. */
  showThumbnails: boolean
  /** on-screen text overlays. */
  texts: TextClip[]
  /** background music / OST mixed under the edit. */
  music?: MusicClip
  /** the creator's INTENDED script (pasted in Cut Lord). FastCut and ProCut
   *  compare the verbatim transcript against it: content that deviates is a
   *  flub/aside/retake candidate, and the take closest to the script survives. */
  script?: string
  /** EXPORT-ONLY audio lanes folded out of the timeline document (detached audio,
   *  dropped audio, music). Present only on the project handed to the exporter in
   *  document mode; mixed under the base voice at each clip's edited position. */
  extraAudio?: ExtraAudioClip[]
  /** preview/output aspect ratio; 0 = use source aspect. */
  aspectW: number
  aspectH: number
  /** uploaded overlay images available for instruction-based placement. */
  overlayAssets?: OverlayAsset[]
  /** natural-language placement rules, one per overlay asset. */
  overlayRules?: OverlayRule[]
  /** minimum visible timeline length in seconds (default ~2h). VIEW-ONLY — the
   *  ruler/lane width floor so clips can be dragged past the media length. NEVER
   *  read by edit math (cuts/ripple/export use the real content duration). */
  timelineDuration?: number
  /** the new clip-based timeline model, once the user has edited it (the source
   *  of truth for the rebuilt editor). Absent for legacy/unedited projects, which
   *  hydrate via projectToDocument() from the fields above. */
  timeline?: TimelineDocument
}

/** A saved project in the library (web: per-user on the server; desktop: local). */
export interface ProjectMeta {
  id: string
  name: string
  /** small preview data URL (first frame). */
  thumb: string
  createdAt: number
  updatedAt: number
}
export interface ProjectRec extends ProjectMeta {
  project: Project | null
}

export const FONT_OPTIONS = [
  'Arial',
  'Arial Black',
  'Impact',
  'Verdana',
  'Tahoma',
  'Trebuchet MS',
  'Georgia',
  'Times New Roman',
  'Courier New',
  'Comic Sans MS',
  'Segoe UI'
]

// ---- IPC payloads ----

export interface ProgressEvent {
  jobId: string
  kind: 'probe' | 'transcribe' | 'silence' | 'export'
  percent: number
  message?: string
}

export interface ExportRequest {
  project: Project
  outPath: string
  /** burn nothing; just stitch kept ranges of base track + overlays. */
}

export interface ExportSettings {
  /** output resolution; content is fit (letterboxed) into it. */
  width: number
  height: number
  /** target video bitrate in Mbps. */
  bitrateMbps: number
  /** creator-chosen output file name (no extension needed); sanitized, .mp4
   *  appended. Falls back to the project name when empty. */
  filename?: string
}

/** A baked text overlay PNG (full-frame, base resolution) + its time window. */
export interface TextOverlayImage {
  png: string // data URL
  start: number
  end: number
}

/** Which engine produced (or should produce) the transcript. */
export type TranscribeBackend = 'local' | 'openai'

/** A local whisper.cpp model available for transcription. */
export interface WhisperModelInfo {
  /** stable id derived from the filename, e.g. "large-v3". */
  name: string
  /** human label for the dropdown. */
  label: string
  /** true for the highest-accuracy model present (the 'Auto' default). */
  best: boolean
}

/** One AI-suggested cut: a run of words to remove, with a reason. */
export interface AICut {
  /** word ids to remove (in order). */
  ids: string[]
  /** what kind of removable content this is. */
  kind: 'repeat' | 'stutter' | 'filler' | 'ramble'
  /** short human-readable justification. */
  reason: string
  /** the removed text (for review UI). */
  text: string
}

export interface AICutResult {
  /** flat set of all word ids to cut. */
  ids: string[]
  /** the individual suggestions, with reasons. */
  cuts: AICut[]
}

export interface SilenceDetectOptions {
  /** silence threshold in dB, e.g. -30 (Fast/dB mode). */
  noiseDb: number
  /** minimum silence duration in seconds to count. */
  minDuration: number
  /** 'vad' = Silero VAD (speech-aware, default when available); 'fast' = ffmpeg dB threshold. */
  mode?: 'fast' | 'vad'
  /** VAD speech-probability threshold 0..1 (higher = cut more). */
  vadThreshold?: number
  /** VAD: extend each speech segment by this many ms (avoids clipping word edges). */
  speechPadMs?: number
  /** VAD: silence kept BEFORE a word's onset (asymmetric lead-in). Falls back to speechPadMs. */
  padBeforeMs?: number
  /** VAD: silence kept AFTER a word's tail (asymmetric trailing guard). Falls back to speechPadMs. */
  padAfterMs?: number
  /** VAD: trim this many ms of EXTRA audio off both sides of every cut (tighter cuts). */
  edgeTrimMs?: number
  /** VAD: also remove breaths / quiet non-word fillers the VAD kept as speech
   *  (a spot the VAD called speech but whose audio is actually quiet). */
  removeBreaths?: boolean
  /** energy threshold (dB) below which in-speech audio is treated as a breath/
   *  quiet filler. Less negative = more aggressive. Default -32. */
  breathDb?: number
}

// ---------------------------------------------------------------------------
// AI-controlled overlay image placement
// ---------------------------------------------------------------------------

export type OverlayPosition =
  | 'top_center' | 'center' | 'bottom_center'
  | 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right'

export type OverlayAnimation = 'none' | 'pop' | 'fade'

/** An uploaded overlay image the creator can place via instructions. */
export interface OverlayAsset {
  id: string
  /** the media-library item that holds the image (so it streams/exports like any image). */
  libraryItemId?: string
  /** image file path / url. */
  file: string
  /** display name, e.g. "No Bloating". */
  name: string
  /** AI vision description of what the image DEPICTS (e.g. "a red '50% OFF' badge").
   *  Cached after one vision pass; fed into matching/suggestion so placement keys
   *  on the overlay's CONTENT, not just its name. */
  description?: string
}

/** A downscaled overlay thumbnail (base64) sent to moment vision for image-to-image
 *  matching: given video FRAMES + these thumbnails, the model picks which overlay
 *  depicts what the creator is showing on camera. */
export interface OverlayThumb {
  id: string
  name: string
  /** base64 image bytes (no data: prefix). */
  image: string
  /** e.g. "image/jpeg". */
  mediaType: string
}

/** One sampled video frame (base64) for moment vision. Several are taken across a
 *  show-moment so the reveal is caught wherever in the line it lands. */
export interface MomentFrame {
  /** base64 image bytes (no data: prefix). */
  image: string
  /** e.g. "image/jpeg". */
  mediaType: string
}

/** Which mentions of a matched topic actually get the overlay. Deterministic —
 *  applied in code AFTER matching, never left to the AI to count. */
export type OverlayOccurrence = 'every' | 'first' | 'last'

/** A natural-language rule: when should this overlay appear, and how. */
export interface OverlayRule {
  overlayId: string
  name: string
  /** "Show this when I talk about bloating, digestion, gut health…".
   *  OPTIONAL — when empty, the overlay's NAME is used as the topic to match. */
  instruction: string
  position: OverlayPosition
  /** seconds the overlay stays on screen (clamped 2.5–4 at generation). */
  durationSeconds: number
  animation: OverlayAnimation
  /** which matched mentions to keep (default 'every', capped per overlay). */
  occurrence?: OverlayOccurrence
}

/** A concrete placement the AI/keyword matcher produced (SOURCE-time seconds). */
export interface OverlayEvent {
  overlayId: string
  start: number
  end: number
  position: OverlayPosition
  animation: OverlayAnimation
  /** why it was placed (transcript moment) — for logs / review. */
  reason: string
  /** which matcher produced it. */
  source?: 'llm' | 'keyword'
  /** matcher confidence 0..1 (LLM only) — for logs today, review UI later. */
  confidence?: number
}

export interface OverlayGenResult {
  events: OverlayEvent[]
  /** which path produced the events. */
  via: 'llm' | 'keyword' | 'none'
  /** human-readable log lines (rules in, matches found/rejected, …). */
  log: string[]
}

/** A proactive placement PROPOSAL from "Suggest" — the AI reads the whole
 *  transcript + the overlay library and proposes overlay↔moment pairs the
 *  creator reviews (accept/reject) before anything is placed. Unlike an
 *  OverlayEvent (already committed) a suggestion is pending review. */
export interface OverlaySuggestion {
  /** ephemeral id for the review list (not persisted). */
  id: string
  /** 'overlay' = place a library image card; 'label' = place an auto-generated text
   *  label of what the creator is SHOWING on screen (moment vision). */
  kind: 'overlay' | 'label'
  /** which library overlay this proposes (empty for 'label'). */
  overlayId: string
  /** the on-screen text for a 'label' suggestion (what the frame vision saw). */
  label?: string
  /** the proposed moment, SOURCE-time seconds. */
  start: number
  end: number
  position: OverlayPosition
  animation: OverlayAnimation
  /** why here (the beat / what the creator says) — shown on the review card. */
  reason: string
  /** the transcript sentence that triggered it — shown on the review card. */
  sentence: string
  /** model confidence 0..1. */
  confidence: number
}

export interface OverlaySuggestResult {
  suggestions: OverlaySuggestion[]
  /** 'llm' when the model produced suggestions, else 'none'. */
  via: 'llm' | 'none'
  log: string[]
}

export const TIMELINE_TRACK_COUNT = 3
