import { create } from 'zustand'
import type {
  Project,
  Transcript,
  SilenceRegion,
  MediaInfo,
  Clip,
  Track,
  ProgressEvent,
  Waveform,
  Thumb,
  BaseSegment,
  ExportSettings,
  TextClip,
  LibraryItem,
  MusicClip,
  SequenceClip,
  TranscribeBackend,
  WhisperModelInfo,
  OverlayAsset,
  OverlayThumb,
  OverlayRule,
  OverlayEvent,
  OverlaySuggestion
} from '@shared/types'
import type { TimelineDocument, Clip as DocClip } from '@shared/timeline/types'
import { documentToProject, projectToDocument, normalizeDefaultLanes, overlayEventsToDocClips, labelSuggestionsToDocTextClips } from '@shared/timeline/bridge'
import * as TimelineCommands from '@shared/timeline/commands'
import type { Command } from '@shared/timeline/commands'
import { createClip, mainTrackId, findTrack } from '@shared/timeline/model'
import { secondsToFrames } from '@shared/timeline/time'
import { variationDuration, type Variation } from '@shared/variations'
import { generateVariationsCloud } from './cloud/variationEngine'
import { getSharedEngine } from './timelineEngine'
import { docSourceToEdited } from './docTime'
import { addDocTexts, removeCaptionTexts } from './docTextClips'
import { captionStyleContent } from './captionStyles'
import { insertLibraryItemAtPlayhead } from './timelineInsert'
import { exportOnDevice } from './export/localExport'
import { nativeExportFull, hasNativeExport } from './export/nativePlan'
import { renderTextPng } from './textRender'
import { TIMELINE_TRACK_COUNT } from '@shared/types'
import { detectFillerIds, detectRepeatIds, snapRetakeFlags, DEFAULT_FILLERS } from '@shared/fillers'
import { computeKeepRanges, subtractRanges, isMultiBase, stitchMontageWaveform, virtualToClip, baseTimelineDuration } from '@shared/edit'
import {
  DEFAULT_CUTLORD_SETTINGS,
  CUTLORD_PRESETS,
  wordCutPad,
  type CutLordSettings
} from '@shared/cutlord'
import { positionToBox, chunkTranscript, findShowMoments } from '@shared/overlay'
// Silence Mastery — the branch's ONE silence engine: keep the word timestamps,
// cut everything else (leading / inter-word / trailing), tuned by min-silence,
// pad left/right and trim-edges. Pure module; review-first staging here.
import {
  planSilenceMasteryDetailed,
  normalizeSilenceMastery,
  DEFAULT_SILENCE_MASTERY_SETTINGS,
  type SilenceMasterySettings
} from '@shared/silenceMastery'
import { mediaSrc, IS_WEB, IS_CLOUD, IS_NEW_UI } from './platform'
import { safeErrMessage } from './safeError'
import { createProject, saveProject, serializeProject, serializeProjectLite } from './projectsApi'
import { openSpaceProject, saveMyEdit, fmtBytes, type CoworkProject, type XferReporter } from './cloud/cowork'
import { hydrateProjectMedia } from './webapi'
import { cleanVideoCloud } from './cloud/batchCleanCloud'
import { saveSilenceDebug } from './cloud/silenceDebug'
import { getFile } from './webmedia'

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

/** Load an overlay image and return it as base64 + media type (for the vision pass).
 *  Uses fetch + FileReader (no canvas, so no cross-origin taint on any protocol);
 *  returns null on any problem so the vision pass degrades to name-only matching. */
async function imageToBase64(file: string): Promise<{ base64: string; mediaType: string } | null> {
  try {
    const res = await fetch(mediaSrc(file))
    const blob = await res.blob()
    if (!blob.size || !/^image\//.test(blob.type || '')) return null
    const dataUrl: string = await new Promise((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(String(fr.result))
      fr.onerror = () => reject(new Error('read failed'))
      fr.readAsDataURL(blob)
    })
    const comma = dataUrl.indexOf(',')
    if (comma < 0) return null
    return { base64: dataUrl.slice(comma + 1), mediaType: blob.type || 'image/png' }
  } catch {
    return null
  }
}

/** Downscale an overlay image to a small JPEG (base64) for moment-vision image-to-image
 *  matching — keeps the vision payload cheap. Overlays are same-origin, so the canvas is
 *  untainted; returns null on any problem (that overlay is just skipped from matching). */
async function imageToThumb(file: string, max = 256): Promise<{ base64: string; mediaType: string } | null> {
  try {
    const img = document.createElement('img')
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.src = mediaSrc(file)
    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('image timeout')), 8000)
      img.onload = () => { clearTimeout(to); resolve() }
      img.onerror = () => { clearTimeout(to); reject(new Error('image load error')) }
    })
    const iw = img.naturalWidth || max
    const ih = img.naturalHeight || max
    const scale = Math.min(1, max / Math.max(iw, ih))
    const w = Math.max(2, Math.round(iw * scale))
    const h = Math.max(2, Math.round(ih * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    // Overlays may be transparent PNGs; JPEG can't carry alpha, so composite on white
    // (a neutral background the model reads fine) instead of the canvas default black.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(img, 0, 0, w, h)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.7)
    const comma = dataUrl.indexOf(',')
    if (comma < 0) return null
    return { base64: dataUrl.slice(comma + 1), mediaType: 'image/jpeg' }
  } catch {
    return null
  }
}

/** Grab downscaled JPEG frames from the media at several SOURCE-time seconds, as base64.
 *  Loads the <video> ONCE and seeks to each time (so N frames cost one video load, not N).
 *  Uses an offscreen <video>+canvas; returns [] on any problem (e.g. cross-origin taint on
 *  desktop) so moment vision degrades gracefully. Cloud/web media are same-origin blobs. */
async function grabFrames(mediaUrl: string, times: number[]): Promise<{ base64: string; mediaType: string }[]> {
  const out: { base64: string; mediaType: string }[] = []
  if (!mediaUrl || !times.length) return out
  let v: HTMLVideoElement | null = null
  try {
    v = document.createElement('video')
    v.crossOrigin = 'anonymous'
    v.muted = true
    v.preload = 'auto'
    v.src = mediaUrl
    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('metadata timeout')), 8000)
      v!.onloadedmetadata = () => { clearTimeout(to); resolve() }
      v!.onerror = () => { clearTimeout(to); reject(new Error('video load error')) }
    })
    const dur = v.duration || 0
    const vw = v.videoWidth || 640
    const vh = v.videoHeight || 360
    const scale = Math.min(1, 640 / vw)
    const w = Math.max(2, Math.round(vw * scale))
    const h = Math.max(2, Math.round(vh * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return out
    for (const tSec of times) {
      const t = Math.max(0, Math.min(tSec, (dur || tSec) - 0.05))
      try {
        await new Promise<void>((resolve, reject) => {
          const to = setTimeout(() => reject(new Error('seek timeout')), 8000)
          v!.onseeked = () => { clearTimeout(to); resolve() }
          v!.currentTime = t
        })
        ctx.drawImage(v, 0, 0, w, h)
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7) // throws if tainted -> caught below
        const comma = dataUrl.indexOf(',')
        if (comma >= 0) out.push({ base64: dataUrl.slice(comma + 1), mediaType: 'image/jpeg' })
      } catch {
        /* skip this timestamp; keep any frames we already grabbed */
      }
    }
    return out
  } catch {
    return out
  } finally {
    if (v) { v.src = ''; v.removeAttribute('src') }
  }
}

/** Remove AI-generated overlay clips (metadata.overlayRuleId) from the live
 *  timeline document as ONE undoable engine edit. No-op without an engine (legacy
 *  mode / timeline unmounted); the callers also clean the legacy tracks. */
function removeGeneratedDocOverlays(label: string, match: (ruleId: string) => boolean): void {
  const engine = getSharedEngine()
  if (!engine) return
  const cmds: Command[] = []
  for (const t of engine.document.tracks) {
    for (const c of t.clips) {
      const rid = c.metadata?.overlayRuleId
      if (typeof rid === 'string' && match(rid)) cmds.push(TimelineCommands.removeClip(c.id))
    }
  }
  if (cmds.length) engine.batch(label, cmds)
}

/** Apply each overlay rule's SIZE (sizePct, 40–160) to its placed b-roll clips by
 *  scaling ovScale — so "Size" in the Overlays/Auto B-roll panel changes how big the
 *  image renders. Default (undefined / 100) leaves the position preset's scale. */
function withOverlaySizes(clips: DocClip[], rules: OverlayRule[]): DocClip[] {
  const pctById = new Map(rules.map((r) => [r.overlayId, r.sizePct]))
  return clips.map((c) => {
    const rid = typeof c.metadata?.overlayRuleId === 'string' ? c.metadata.overlayRuleId : undefined
    const pct = rid ? pctById.get(rid) : undefined
    if (!pct || pct === 100) return c
    const factor = Math.max(40, Math.min(160, pct)) / 100
    const base = typeof c.metadata?.ovScale === 'number' ? c.metadata.ovScale : 1
    return { ...c, metadata: { ...c.metadata, ovScale: base * factor } }
  })
}

/** Human-facing clip name. Prefer the original filename from the OS file picker;
 *  otherwise recover it from the still-registered browser File (single-file /
 *  overlay imports only carry the opaque id), then the path's basename. Never
 *  surface an opaque web-media id (webmedia:… / blob:…) — that's the id we use
 *  as a "path", not a name the creator recognizes. */
function mediaDisplayName(path: string, preferred?: string): string {
  const opaque = /^(webmedia|ecmedia|blob):/i
  const clean = (s: string | undefined): string => (s ?? '').trim()
  const p = clean(preferred)
  if (p && !opaque.test(p)) return p
  const fromReg = clean(getFile(path)?.name)
  if (fromReg && !opaque.test(fromReg)) return fromReg
  const base = clean(path.split(/[\\/]/).pop())
  if (!base || opaque.test(base) || opaque.test(path)) return 'Imported clip'
  return base
}

/** Per-source waveform cache so the montage waveform rebuilds instantly on
 *  trim/reorder without re-extracting each clip's peaks. */
const srcWaveCache = new Map<string, Waveform>()

/** Local/server file -> streaming URL (ecmedia:// in Electron, /media over HTTP on the web). */
function mediaUrl(filePath: string): string {
  return mediaSrc(filePath)
}

/** True if the EDIT content (not view/playhead) differs between two projects. */
function editChanged(a: Project, b: Project): boolean {
  return (
    a.transcript !== b.transcript ||
    a.silences !== b.silences ||
    a.tracks !== b.tracks ||
    a.baseSplits !== b.baseSplits ||
    a.manualCuts !== b.manualCuts ||
    a.keepOverrides !== b.keepOverrides ||
    a.baseSequence !== b.baseSequence ||
    a.texts !== b.texts ||
    a.music !== b.music ||
    a.silencePadding !== b.silencePadding
  )
}

/** Restore a historical edit state but keep the current view/transport fields. */
function withView(target: Project, cur: Project): Project {
  return {
    ...target,
    playhead: cur.playhead,
    pxPerSec: cur.pxPerSec,
    trackHeight: cur.trackHeight,
    magnet: cur.magnet,
    showThumbnails: cur.showThumbnails
  }
}

const DEFAULT_KEYBINDS = { split: 's', del: 'd', undelete: 'r', playPause: ' ' }
function loadKeybinds(): { split: string; del: string; undelete: string; playPause: string } {
  try {
    const raw = localStorage.getItem('ec.keybinds')
    if (raw) return { ...DEFAULT_KEYBINDS, ...JSON.parse(raw) }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_KEYBINDS }
}

function loadFillers(): string[] {
  try {
    const raw = localStorage.getItem('ec.fillers')
    if (raw) {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) return arr
    }
  } catch {
    /* ignore */
  }
  return [...DEFAULT_FILLERS]
}

/**
 * Transcription backend choice. A saved choice wins; otherwise default by device:
 * phone-sized viewports (mobile web) default to cloud whisper-1, desktop to local.
 * (Falls back to local at transcribe-time if no OpenAI key is configured.)
 */
function loadBackend(): TranscribeBackend {
  try {
    const saved = localStorage.getItem('ec.transcribeBackend')
    if (saved === 'openai' || saved === 'local') return saved
    const mobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 820px)').matches
    return mobile ? 'openai' : 'local'
  } catch {
    return 'local'
  }
}

// ---- Media library (persisted across sessions) ----
const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp)$/i

function loadLibrary(): LibraryItem[] {
  try {
    const raw = localStorage.getItem('ec.library')
    if (raw) {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) return arr
    }
  } catch {
    /* ignore */
  }
  return []
}
function saveLibrary(lib: LibraryItem[]): void {
  try {
    localStorage.setItem('ec.library', JSON.stringify(lib))
  } catch {
    /* ignore (quota) — library just won't persist this session */
  }
}

/** Probe a file and build a library item (with a small preview thumbnail).
 *  `preferredName` is the original filename from the OS picker — pass it so the
 *  clip keeps its real name instead of falling back to the opaque web-media id. */
async function buildLibraryItem(path: string, preferredName?: string): Promise<LibraryItem> {
  const info = await window.api.probe(path).catch(() => null)
  // Web media ids (webmedia:xxxx) carry no file extension, so extension sniffing
  // alone classified every browser-imported image as "video". The probe knows:
  // an image has visuals but no duration and no audio.
  const isImage = IMAGE_RE.test(path) || (!!info && info.hasVideo && !info.hasAudio && (info.duration || 0) === 0)
  const name = mediaDisplayName(path, preferredName)
  let kind: LibraryItem['kind'] = 'video'
  if (isImage) kind = 'image'
  else if (info && !info.hasVideo && info.hasAudio) kind = 'audio'

  let thumb: string | undefined
  if (isImage) {
    thumb = mediaUrl(path) // the image streams straight from the ecmedia protocol
  } else if (info?.hasVideo) {
    try {
      const ths = await window.api.thumbnails(path, Math.max(1, info.duration || 1))
      thumb = ths[0]?.url
    } catch {
      /* no thumbnail is fine */
    }
  }
  return {
    id: uid(),
    path,
    name,
    kind,
    duration: info?.duration ?? 0,
    width: info?.width ?? 0,
    height: info?.height ?? 0,
    fps: info?.fps ?? 0,
    hasAudio: info?.hasAudio ?? false,
    hasVideo: info?.hasVideo ?? isImage,
    thumb
  }
}

/** Rebuild the media-library list from a project's OWN sources so opening a project
 *  shows its media and a fresh project shows none — no cross-project bleed from the
 *  global import pool. Deduped by path; built from stored metadata (no re-probing). */
function libraryFromProject(p: Project): LibraryItem[] {
  const seen = new Set<string>()
  const out: LibraryItem[] = []
  const add = (
    path: string | undefined,
    name: string | undefined,
    kind: LibraryItem['kind'],
    w?: number,
    h?: number,
    dur?: number,
    hasAudio?: boolean,
    fps?: number
  ): void => {
    if (!path || seen.has(path)) return
    seen.add(path)
    out.push({
      id: uid(),
      path,
      name: mediaDisplayName(path, name),
      kind,
      duration: dur ?? 0,
      width: w ?? 0,
      height: h ?? 0,
      fps: fps ?? 30,
      hasAudio: hasAudio ?? kind !== 'image',
      hasVideo: kind === 'video',
      thumb: kind === 'image' ? mediaUrl(path) : undefined
    })
  }
  if (p.media) add(p.media.path, p.name, p.media.hasVideo ? 'video' : 'audio', p.media.width, p.media.height, p.media.duration, p.media.hasAudio, p.media.fps)
  for (const c of p.baseSequence ?? []) add(c.sourcePath, c.name, c.isImage ? 'image' : 'video', c.srcW, c.srcH, c.sourceDuration ?? c.sourceOut, c.hasAudio, c.fps)
  for (const t of p.tracks ?? []) for (const c of t.clips) add(c.sourcePath, c.name, c.isImage ? 'image' : 'video', c.srcW, c.srcH, c.sourceDuration, !c.isImage)
  for (const t of p.timeline?.tracks ?? []) {
    for (const c of t.clips) {
      if (!c.sourcePath) continue
      const kind: LibraryItem['kind'] = c.kind === 'image' ? 'image' : c.kind === 'audio' ? 'audio' : 'video'
      add(c.sourcePath, c.name, kind, c.srcW, c.srcH, c.sourceDuration ?? c.sourceOut, c.hasAudio, c.srcFps)
    }
  }
  return out
}

/** First visual (video/image) source path in a project, for a dashboard thumbnail.
 *  Prefers legacy project.media, then the timeline document's MAIN lane (the base),
 *  then any other lane — so doc-native projects (a clip dragged/clicked onto the
 *  timeline, with no project.media) still yield a thumbnail source. */
export function firstVideoSourcePath(p: Project): string | undefined {
  if (p.media?.path && p.media.hasVideo) return p.media.path
  const tracks = p.timeline?.tracks ?? []
  const pick = (clips: { start: number; kind?: string; sourcePath?: string }[]): string | undefined =>
    clips
      .slice()
      .sort((a, b) => a.start - b.start)
      .find((c) => c.kind !== 'audio' && !!c.sourcePath)?.sourcePath
  const main = tracks.find((t) => (t as { isMain?: boolean }).isMain) ?? tracks[0]
  const fromMain = main ? pick(main.clips) : undefined
  if (fromMain) return fromMain
  for (const t of tracks) {
    const p2 = pick(t.clips)
    if (p2) return p2
  }
  return undefined
}

function emptyTracks(): Track[] {
  return Array.from({ length: TIMELINE_TRACK_COUNT }, (_, i) => ({
    id: uid(),
    index: i,
    name: i === 0 ? 'A-roll (base)' : `Overlay ${i}`,
    muted: false,
    hidden: false,
    clips: []
  }))
}

function newProject(): Project {
  return {
    version: 1,
    name: 'Untitled',
    silences: [],
    tracks: emptyTracks(),
    playhead: 0,
    pxPerSec: 80,
    magnet: true,
    trackHeight: 96,
    baseSplits: [],
    manualCuts: [],
    keepOverrides: [],
    silencePadding: 0.08,
    showThumbnails: true,
    texts: [],
    aspectW: 0,
    aspectH: 0
  }
}

/** Which tool owns the shared progress bar. The AI tools each carry their own tag
 *  so a panel only renders the run it started — everything used to report as an
 *  untagged (or 'transcribe') job, so Variations and Auto b-roll drew their
 *  progress inside the Speech cleaner tab. */
export type JobKind = ProgressEvent['kind'] | 'variations' | 'zoom' | 'broll'

export interface Job {
  active: boolean
  kind?: JobKind
  percent: number
  message?: string
}

const IMAGE_SEQ_DUR = 4 // a still dropped into the base shows for this many seconds

/** Build a base-sequence clip from a library item (images get a default duration). */
function seqClipFromLibrary(it: LibraryItem): SequenceClip {
  const isImage = it.kind === 'image'
  const dur = isImage ? IMAGE_SEQ_DUR : it.duration || 0
  return {
    id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    sourcePath: it.path,
    name: it.name,
    sourceIn: 0,
    sourceOut: dur,
    sourceDuration: dur,
    hasAudio: isImage ? false : it.hasAudio,
    srcW: it.width || 1920,
    srcH: it.height || 1080,
    fps: it.fps || 30,
    isImage
  }
}

/** Natural, case-insensitive filename order (0501.MOV < 0502.MOV < 0510.MOV, and
 *  clip2 < clip10) — how "Add all to timeline" sequences clips, so numbered/named
 *  files line up the way the creator expects rather than in import order. */
function byClipName(a: LibraryItem, b: LibraryItem): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
}

/** Turn the current single base video into a sequence clip (so a dropped clip can
 *  be appended after it and the two combined into one base). */
function seqClipFromMedia(m: MediaInfo): SequenceClip {
  return {
    id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    sourcePath: m.path,
    name: mediaDisplayName(m.path),
    sourceIn: 0,
    sourceOut: m.duration || 0,
    sourceDuration: m.duration || 0,
    hasAudio: m.hasAudio,
    srcW: m.width || 1920,
    srcH: m.height || 1080,
    fps: m.fps || 30
  }
}

/** One file's progress in the Batch Video Cleaner (home screen). */
export interface BatchJob {
  projectId: string
  name: string
  status: 'queued' | 'processing' | 'done' | 'error'
  step: string
  error?: string
}

/** Which enhancements the New Project wizard should apply on import. */
export interface WizardOpts {
  /** VAD silence removal + Retake δ bad-take cutting, applied to the timeline. */
  cutSilenceBadTakes: boolean
  /** Generate styled caption clips from the transcript (runs after the editor opens). */
  captions: boolean
  /** Add AI punch-in zooms to the important clips (runs after the editor opens). */
  autoZoom: boolean
}

/** New Project wizard progress. `base`/`span` map the current engine's own 0-100
 *  `job.percent` into its slice of one continuous 0-100 wizard bar. */
export interface WizardJob {
  active: boolean
  label: string
  base: number
  span: number
}

/** Seam blend ("overlap") at cut joins — a short incoming-only fade that de-clicks
 *  the splice. A global render setting applied at export + preview. */
export interface SeamFadeSettings {
  enabled: boolean
  ms: number
}
export const DEFAULT_SEAM_FADE: SeamFadeSettings = { enabled: true, ms: 25 }
/** Clamp a possibly-partial persisted value back onto the defaults (0–60ms). */
export function normalizeSeamFade(v: Partial<SeamFadeSettings> | null | undefined): SeamFadeSettings {
  const d = DEFAULT_SEAM_FADE
  if (!v) return { ...d }
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : d.enabled,
    ms: Math.max(0, Math.min(60, typeof v.ms === 'number' && Number.isFinite(v.ms) ? v.ms : d.ms))
  }
}

/** A single Cloud Cowork file transfer (upload OR download) shown in the
 *  dashboard's right-side dock, with a live byte-progress bar. */
export interface CoworkTransfer {
  id: string
  name: string
  kind: 'upload' | 'download'
  step: string
  pct: number
  status: 'active' | 'done' | 'error'
}

interface AppState {
  project: Project
  /** reusable media library (import once, reuse many; persisted). */
  library: LibraryItem[]
  /** last overlay-generation log (transient; shown in the overlay panel). */
  overlayLog: string[]
  /** pending "Suggest" proposals awaiting the creator's accept/reject (transient). */
  overlaySuggestions: OverlaySuggestion[]
  /** object URL for the imported base media, for <video> playback. */
  mediaUrl: string | null
  waveform: Waveform | null
  /** amplitude peaks for the background-music clip (timeline display). */
  musicWaveform: Waveform | null
  thumbnails: Thumb[]
  selectedWordIds: Set<string>
  job: Job
  /** True while a "Find cuts" job is running — drives the centered blocking
   *  overlay (distinct from `job`, which many unrelated ops also use). */
  cutJobActive: boolean
  setCutJobActive: (v: boolean) => void
  /** Proactive seam-cache build after cuts apply. While active the editor is
   *  locked and a centered "Polishing cuts…" bar shows; DocPreview drives it. */
  polishing: { active: boolean; percent: number }
  setPolishing: (v: { active: boolean; percent: number }) => void
  /** Monotonic request id — bumped on every Apply so DocPreview's polish effect
   *  re-fires even when `active` was already true (a prior stuck build). */
  polishReq: number
  tools: { ffmpeg: boolean; ffprobe: boolean; whisper: boolean; whisperModel: boolean } | null
  playing: boolean
  scrubbing: boolean
  selectedClipId: string | null
  selectedSeg: BaseSegment | null
  selectedTextId: string | null
  toolsTab: 'transcript' | 'basic' | 'ost' | 'text' | 'overlays'
  keybinds: { split: string; del: string; undelete: string; playPause: string }
  fillerWords: string[]
  /** which engine transcribes: 'local' offline whisper (default) or 'openai' premium-merge. */
  transcribeBackend: TranscribeBackend
  /** whether an OpenAI key is configured on the backend (enables cloud options). */
  openaiAvailable: boolean
  /** is the backend reachable? Manual edit + on-device export work offline;
   *  transcription and the AI cut engines are gated off when this is false. */
  serverAvailable: boolean
  setServerAvailable: (v: boolean) => void
  /** Guard for server-only actions: returns true if the backend is reachable;
   *  otherwise posts a friendly "offline" status and returns false. */
  requireServer: (feature: string) => boolean
  /** local whisper models available to pick from (empty until loaded). */
  whisperModels: WhisperModelInfo[]
  /** selected local whisper model name ('' = Auto / best available). */
  whisperModel: string
  showSettings: boolean
  showCropModal: boolean
  showExportModal: boolean
  /** Batch Video Cleaner jobs shown on the home screen (newest first). */
  batchJobs: BatchJob[]
  // ---- App shell / accounts / projects (web) ----
  view: 'loading' | 'landing' | 'auth' | 'home' | 'editor' | 'terms' | 'privacy' | 'refund'
  user: { id: string; email: string } | null
  /** id of the montage clip currently open in the single-clip editor (null = not editing a clip). */
  editingClipId: string | null
  currentProjectId: string | null
  /** When editing a shared Cloud Cowork project (edits persist to R2, not the
   *  local `projects` table). null for ordinary local projects. `editUserId` is
   *  the member whose edit version is currently loaded (null = the most recent). */
  coworkSession: { spaceId: string; project: CoworkProject; editUserId: string | null } | null
  /** Live Cloud Cowork transfers (uploads + downloads, newest first) for the dock. */
  coworkTransfers: CoworkTransfer[]
  currentProjectName: string
  saveState: 'idle' | 'saving' | 'saved' | 'error'
  past: Project[]
  future: Project[]
  canUndo: boolean
  canRedo: boolean

  // setup
  init: () => Promise<void>

  // media library
  addToLibrary: () => Promise<void>
  /** import audio (music / voiceover) — opens files/storage, not the gallery. */
  addAudioToLibrary: () => Promise<void>
  /** import every media file in a chosen folder into the library at once. */
  importFolderToLibrary: () => Promise<void>
  /** append one library video to the base sequence (montage). */
  addToSequence: (libraryId: string) => void
  /** append ALL library videos to the base sequence, in order (numbered). */
  addAllToSequence: () => void
  addAllToTimeline: () => void
  /** drag-drop a clip onto the A-roll: append as a SEPARATE base clip (no merge). */
  dropOntoBase: (libraryId: string) => void
  /** reorder a base-sequence clip from one index to another. */
  reorderSequence: (from: number, to: number) => void
  /** remove a clip from the base sequence. */
  removeSequenceClip: (id: string) => void
  /** trim a base-sequence clip's in/out (source seconds). */
  trimSequenceClip: (id: string, sourceIn: number, sourceOut: number) => void
  /** free horizontal position of a base clip on the timeline (magnet OFF). */
  moveSequenceClip: (id: string, laneStart: number) => void
  /** write per-clip transcript/silences (after re-segmenting the combined montage). */
  storeSequenceCleaning: (
    transcriptMap?: Map<string, Transcript>,
    silenceMap?: Map<string, SilenceRegion[]>
  ) => void
  /** clear the whole base sequence. */
  clearSequence: () => void
  /** (multi-clip base) build a stitched montage waveform from the clip sources. */
  ensureMontageWaveform: () => Promise<void>
  /** combine the base-sequence clips into ONE base video so the whole thing edits as one. */
  combineSequence: () => Promise<void>
  /** open a sequence clip in the single-clip editor to clean it (transcribe / fillers / silence). */
  editSequenceClip: (id: string) => void
  /** save the current clip's cleaning back into the sequence and return to the montage. */
  finishSequenceClipEdit: () => void
  removeFromLibrary: (id: string) => void
  /** load a library item as the base (A-roll) track. */
  setBaseFromLibrary: (id: string) => void
  /** add a library item as an overlay clip at the playhead. */
  addLibraryToOverlay: (id: string, trackIndex?: number) => void
  /** Mobile: pick an image/video from the device and drop it on an overlay
   *  track at the playhead (CapCut-style Overlay button). */
  importOverlayFromDevice: () => Promise<void>

  // background music (OST)
  addMusic: () => Promise<void>
  updateMusic: (patch: Partial<MusicClip>) => void
  removeMusic: () => void

  // media + transcript
  importMedia: () => Promise<void>
  /** pick video(s) and append them to the base as separate clips (CapCut "+"). */
  appendToBase: () => Promise<void>
  transcribe: () => Promise<void>
  setSilences: (s: SilenceRegion[]) => void
  setSilenceAction: (id: string, action: SilenceRegion['action']) => void
  setSilenceShorten: (id: string, shortenTo: number) => void
  removeAllSilence: () => void
  setSilencePadding: (p: number) => void

  // transcript editing
  selectWord: (id: string, additive: boolean, rangeTo?: string) => void
  /** highlight filler words/phrases for review. */
  selectFillers: () => void
  /** highlight stutters, restarts, and repeated/retaken sentences for review. */
  selectRepeats: () => void
  /** choose the transcription engine (offline whisper vs OpenAI premium merge). */
  setTranscribeBackend: (b: TranscribeBackend) => void
  /** choose which local whisper model to use ('' = Auto / best). */
  setWhisperModel: (name: string) => void
  /** ask gpt-4o-mini which spans to cut (fillers/repeats/rambles) and highlight them. */
  selectAICuts: () => Promise<void>
  /** local heuristic+ML engine (no API) — flag retakes/repetitions to review. */
  selectFastCuts: () => Promise<void>
  // ---- Cut Lord / ClutterCleaner ----
  /** ⚙ profile for FastCut/ProCut word cutting (persisted). */
  cutLordSettings: CutLordSettings
  setCutLordSettings: (patch: Partial<CutLordSettings>) => void
  /** Seam blend ("overlap") at every cut: a short incoming-only fade that de-clicks
   *  the splice. Global render setting (export + preview).
   *  enabled=false → hard cuts; ms is the fade length (0–60ms). */
  seamFade: SeamFadeSettings
  setSeamFade: (patch: Partial<SeamFadeSettings>) => void
  /** Redesigned UI only: left media panel collapsed to a rail (persisted). Pure
   *  layout state — no effect on media, projects, or any engine. */
  mediaCollapsed: boolean
  setMediaCollapsed: (v: boolean) => void
  // ---- Silence Mastery (this branch's one silence engine) ----
  /** persisted engine settings: min silence, pad left/right, trim edges. */
  silenceMasterySettings: SilenceMasterySettings
  setSilenceMasterySettings: (patch: Partial<SilenceMasterySettings>) => void
  /** "Silence settings" modal open? */
  showSilenceMasterySettings: boolean
  setShowSilenceMasterySettings: (v: boolean) => void
  /** "Clean Silence": ensure a transcript, then stage every non-word region
   *  (review-first — nothing is cut until Apply/Execute). */
  runSilenceMastery: () => Promise<void>
  /** silence cuts staged for review (highlighted chips — NOT applied yet). */
  stagedSilences: SilenceRegion[]
  /** staged silences currently enabled (chip highlighted). */
  stagedSilenceSel: Set<string>
  /** the staged silences came from Retake β's OWN word-clamped VAD pass — Execute
   *  cuts must NOT re-run the shared aggressive VAD over them (would clobber). */
  retakeSilenceStaged: boolean
  toggleStagedSilence: (id: string) => void
  /** FastCut: word engine (flags repeats/fillers) + VAD silence staging. Review-only. */
  runFastCutLord: () => Promise<void>
  /** ProCut: the CutCutPro 4-phase pipeline + VAD silence staging. Review-only. */
  runProCut: () => Promise<void>
  /** Retake-Aware Cut Beta: separate experimental engine (verbatim provider +
   *  whole-take retake removal + filler triage). Review-only, like the others. */
  runRetakeCutBeta: () => Promise<void>
  /** Ultracut (Beta): a SEPARATE experimental engine that routes the cut judge to
   *  an OpenRouter test model (ultracut-judge, GLM 5.2). Shares nothing with Retake
   *  Beta's Opus judge — its own edge fn — so the two can be A/B'd. Cloud-only. */
  runUltracut: () => Promise<void>
  /** Premium Cut (Beta): a SEPARATE experimental engine — Gemini 3.5 Flash LISTENS
   *  to the raw audio (premium-cut edge fn) and returns the verbatim transcript +
   *  the word cuts itself; no STT. Same review-first contract. Cloud-only. */
  runPremiumCut: () => Promise<void>
  /** Variations: REPLACE the main lane with the creator's clip list, cut from the
   *  source and joined gapless in the given array order (out-of-order, repeated
   *  and overlapping ranges are all honoured). One undoable edit. */
  applyVariation: (variation: Variation) => void
  /** AI Variations: transcribe if needed, then ask the judge to cast the
   *  transcript into `count` short-form arrangements. Returns them for review —
   *  nothing is applied until the creator picks one. */
  generateVariations: (count: number) => Promise<Variation[]>
  /** Last AI-generated set, kept in the store so the panel survives a re-render. */
  aiVariations: Variation[]
  aiVariationWarnings: string[]
  aiVariationsBusy: boolean
  /** Additive: run ONLY the AssemblyAI transcribe step Retake β uses and store
   *  project.transcript — no judge, no word cuts. Powers the Transcript
   *  tab's transcribe-only button. */
  transcribeOnly: () => Promise<void>
  /** apply everything the user reviewed: delete selected words + cut enabled staged
   *  silences. */
  executeCuts: () => Promise<void>
  /** internal: transcribe with our inbuilt Parakeet (local-whisper fallback) and
   *  store the transcript — FastCut's auto-transcribe step. */
  _parakeetTranscribe: () => Promise<boolean>
  // ---- AI overlay placement ----
  /** register an image-library item as an overlay asset (+ a default rule). */
  addOverlayAsset: (libraryItemId: string) => void
  /** edit an overlay's rule (instruction/position/duration/animation). */
  updateOverlayRule: (overlayId: string, patch: Partial<OverlayRule>) => void
  /** remove an overlay asset, its rule, and any clips it generated. */
  removeOverlayAsset: (overlayId: string) => void
  /** run rule interpretation and place overlay clips on track 1. */
  generateOverlays: () => Promise<void>
  /** remove all AI-generated overlay clips (keeps assets/rules). */
  clearGeneratedOverlays: () => void
  /** update an overlay asset's fields (e.g. cache its vision description). */
  updateOverlayAsset: (overlayId: string, patch: Partial<OverlayAsset>) => void
  /** vision pass: fill in any missing overlay descriptions (cached on the asset). */
  ensureOverlayDescriptions: () => Promise<void>
  /** "Suggest": AI proposes overlay placements from the library into a review list. */
  suggestOverlays: () => Promise<void>
  /** place the given suggestions (or all pending) as overlay clips; removes them from review. */
  acceptSuggestions: (ids?: string[]) => void
  /** dismiss one pending suggestion without placing it. */
  dismissSuggestion: (id: string) => void
  /** clear the whole pending-suggestion review list. */
  clearSuggestions: () => void
  clearSelection: () => void
  deleteSelected: () => void
  restoreSelected: () => void
  toggleWordDeleted: (id: string) => void

  // timeline
  setPlayhead: (t: number) => void
  setPlaying: (p: boolean) => void
  setScrubbing: (b: boolean) => void
  setZoom: (px: number) => void
  setTrackHeight: (h: number) => void
  setAspect: (w: number, h: number) => void
  /** set the creator's intended script (guides FastCut/ProCut cut decisions). */
  setScript: (script: string) => void
  toggleMagnet: () => void
  toggleThumbnails: () => void
  addBrollToTrack: (trackIndex: number) => Promise<void>
  addClipFromSource: (
    trackIndex: number,
    sourceIn: number,
    sourceOut: number,
    start: number,
    name: string
  ) => void
  moveClip: (clipId: string, newStart: number) => void
  updateClip: (clipId: string, patch: Partial<Clip>) => void
  /** Persist the authoritative timeline document (written by the timeline engine
   *  on every edit). Preview/export read this when present. */
  setTimelineDoc: (doc: TimelineDocument) => void
  /** split clips under the playhead; omit trackIndex to split across all tracks. */
  splitAtPlayhead: (trackIndex?: number) => boolean
  removeClip: (clipId: string) => void
  /** add a manual split point on the base track at the playhead. */
  splitBaseAtPlayhead: () => boolean
  /** split the multi-clip base clip under the playhead into two clips. */
  splitSequenceAtPlayhead: () => boolean
  /** currently-selected multi-clip base clip (for delete/highlight). */
  selectedSeqClipId: string | null
  selectSeqClip: (id: string | null) => void
  /** delete a base source range (from splitting then removing a segment). */
  deleteBaseRange: (start: number, end: number, final?: boolean) => void
  /** ripple-remove every currently-greyed cut at once ("delete all cuts"). */
  deleteAllCuts: () => void
  /** reversible base trim: set (or clear) the manual cut within a region. */
  setBaseManualCut: (regionStart: number, regionEnd: number, cut: { start: number; end: number } | null) => void
  /** reversible cut trim: set (or clear) a force-kept override within a region. */
  setBaseKeepOverride: (regionStart: number, regionEnd: number, ov: { start: number; end: number } | null) => void
  /** clear manual base splits + deletions. */
  clearBaseEdits: () => void

  // selection + hotkeys
  selectClip: (id: string | null) => void
  selectSeg: (seg: BaseSegment | null) => void
  setToolsTab: (t: 'transcript' | 'basic' | 'ost' | 'text' | 'overlays') => void

  // text overlays
  addText: () => void
  updateText: (id: string, patch: Partial<TextClip>) => void
  removeText: (id: string) => void
  /** Captions tab: turn the transcript into styled subtitle TextClips (bottom-
   *  centre, one short line at a time). Replaces any previous caption batch.
   *  `styleId` picks a caption look preset (see captionStyles.ts). */
  generateCaptions: (styleId?: string) => Promise<void>
  /** remove every auto-generated caption clip (leaves hand-added text). */
  clearCaptions: () => void
  selectText: (id: string | null) => void
  moveText: (id: string, start: number) => void
  /** split the selected text clip at the playhead. */
  splitTextAtPlayhead: () => boolean
  hotkeySplit: () => void
  hotkeyDelete: () => void
  /** restore a selected deleted-word selection, or a selected cut base segment. */
  hotkeyUndelete: () => void
  hotkeyPlayPause: () => void
  setKeybind: (action: 'split' | 'del' | 'undelete' | 'playPause', key: string) => void
  setFillerWords: (list: string[]) => void
  setShowSettings: (b: boolean) => void
  setShowCropModal: (b: boolean) => void

  // history
  undo: () => void
  redo: () => void

  // io
  exportVideo: (settings: ExportSettings) => Promise<void>
  /** Render + encode entirely IN THIS BROWSER (WebCodecs) and save to the
   *  device — no upload. Falls back with a clear message when unsupported. */
  exportVideoOnDevice: (settings: ExportSettings) => Promise<void>
  setShowExportModal: (b: boolean) => void
  save: () => Promise<void>
  load: () => Promise<void>

  // app shell / accounts / projects
  setView: (v: 'loading' | 'auth' | 'home' | 'editor') => void
  setUser: (u: { id: string; email: string } | null) => void
  setSaveState: (s: 'idle' | 'saving' | 'saved' | 'error') => void
  /** rename the open project (persisted by autosave). */
  renameCurrentProject: (name: string) => void
  /** load a saved project record into the editor. `extra` overrides fields in the
   *  editor-open set (used by Cloud Cowork to attach a coworkSession). */
  openProjectRecord: (
    rec: { id: string; name: string; project: Project | null },
    extra?: Partial<{ currentProjectId: string | null; coworkSession: AppState['coworkSession'] }>
  ) => void
  /** Open a shared Cloud Cowork project: download the chosen (or latest) member
   *  edit + its media from R2, then enter the editor with edits bound to R2. */
  openCoworkProject: (
    cp: CoworkProject,
    editUserId?: string | null,
    onStep?: (s: string) => void
  ) => Promise<void>
  /** Persist the open cowork project as THIS member's R2 edit version. */
  saveCoworkEdit: () => Promise<void>
  /** Cloud Cowork transfer dock: start a row (returns its id), update it, finish it. */
  coworkXferStart: (name: string, kind: 'upload' | 'download') => string
  coworkXferPatch: (id: string, patch: Partial<CoworkTransfer>) => void
  coworkXferEnd: (id: string, error?: string) => void
  /** Clear finished/errored transfer rows (keeps any still active). */
  dismissCoworkXfers: () => void
  /** build a fresh empty project object (without entering the editor). */
  freshProject: () => Project
  /** leave the editor back to the home dashboard. */
  goHome: () => void
  /** Batch-clean multiple videos into auto-created projects (fillers + silences removed). */
  runBatchClean: (items: { path: string; name: string }[]) => Promise<void>
  /** Clear finished batch-clean jobs from the home screen. */
  dismissBatchJobs: () => void
  /** New Project wizard: import files (one project, clips in sequence), apply the
   *  ticked enhancements with a combined progress bar, then open the editor. */
  startImportWizard: (files: { path: string; name: string }[], opts: WizardOpts) => Promise<void>
  /** Combined progress for the import wizard (null when idle). */
  wizardJob: WizardJob | null
  /** Captions were requested at import — the editor runs them once the engine mounts. */
  pendingCaptions: boolean
  /** Editor calls this after generating the post-import captions (or to cancel). */
  clearPendingCaptions: () => void
  /** Auto Zoom was requested at import — the editor runs it once the engine mounts. */
  pendingAutoZoom: boolean
  /** Editor calls this after the post-import Auto Zoom pass (or to cancel). */
  clearPendingAutoZoom: () => void
  /** true while an Auto Zoom pass is running (drives the AI Cut button spinner). */
  autoZoomBusy: boolean
  /** Auto Zoom: ask Gemma which of the current cut clips to punch-in and apply it. */
  runAutoZoom: () => Promise<void>
}

/** A transfer reporter bound to the store — cowork.ts calls `.start()` per file
 *  and drives `.progress()`/`.done()`, which surface as live rows in the
 *  dashboard's transfer dock (uploads while sharing, downloads while opening). */
export function makeXferReporter(): XferReporter {
  return {
    start(name, kind) {
      const id = useStore.getState().coworkXferStart(name, kind)
      const verb = kind === 'upload' ? 'Uploading' : 'Downloading'
      return {
        progress: (loaded, total) =>
          useStore.getState().coworkXferPatch(id, {
            pct: total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : 0,
            step: total > 0 ? `${verb} · ${fmtBytes(loaded)} / ${fmtBytes(total)}` : `${verb} · ${fmtBytes(loaded)}`
          }),
        done: (error) => useStore.getState().coworkXferEnd(id, error)
      }
    }
  }
}

export const useStore = create<AppState>((set, get) => ({
  project: newProject(),
  library: loadLibrary(),
  overlayLog: [],
  overlaySuggestions: [],
  mediaUrl: null,
  waveform: null,
  musicWaveform: null,
  thumbnails: [],
  selectedWordIds: new Set(),
  job: { active: false, percent: 0 },
  cutJobActive: false,
  setCutJobActive: (v) => set({ cutJobActive: v }),
  polishing: { active: false, percent: 0 },
  setPolishing: (v) => set({ polishing: v }),
  polishReq: 0,
  tools: null,
  playing: false,
  scrubbing: false,
  selectedClipId: null,
  selectedSeg: null,
  selectedSeqClipId: null,
  selectedTextId: null,
  toolsTab: 'transcript',
  transcribeBackend: loadBackend(),
  openaiAvailable: false,
  serverAvailable: true, // assumed reachable until the boot probe says otherwise
  setServerAvailable: (v) => set({ serverAvailable: v }),
  requireServer: (feature) => {
    if (get().serverAvailable) return true
    set({
      job: {
        active: false,
        percent: 0,
        message: `⚡ Offline — ${feature} needs a connected server. Importing, splitting/trimming, cutting and exporting still work offline.`
      }
    })
    return false
  },
  whisperModels: [],
  whisperModel: (() => {
    try {
      return localStorage.getItem('ec.whisperModel') || ''
    } catch {
      return ''
    }
  })(),
  keybinds: loadKeybinds(),
  fillerWords: loadFillers(),
  showSettings: false,
  showCropModal: false,
  showExportModal: false,
  batchJobs: [],
  wizardJob: null,
  pendingCaptions: false,
  pendingAutoZoom: false,
  autoZoomBusy: false,
  view: IS_WEB ? 'loading' : 'home',
  user: null,
  editingClipId: null,
  currentProjectId: null,
  coworkSession: null,
  coworkTransfers: [],
  currentProjectName: 'Untitled',
  saveState: 'idle',
  past: [],
  future: [],
  canUndo: false,
  canRedo: false,

  init: async () => {
    // Offline (Capacitor bundle / no server): toolStatus is a server call and
    // will throw — swallow it so the editor still boots and manual editing works.
    try {
      set({ tools: await window.api.toolStatus() })
    } catch {
      set({ serverAvailable: false })
      return
    }
    // Is a cloud (OpenAI) key configured? Enables the premium transcription +
    // AI-cut options; falls back silently to local-only if unavailable.
    window.api
      .openaiStatus()
      .then(({ available }) => {
        set({ openaiAvailable: available })
        if (!available && get().transcribeBackend === 'openai') set({ transcribeBackend: 'local' })
      })
      .catch(() => set({ openaiAvailable: false }))
    // Load the local whisper models for the model selector.
    window.api
      .whisperModels()
      .then((models) => {
        set({ whisperModels: models })
        // Drop a stale saved selection that's no longer present.
        const sel = get().whisperModel
        if (sel && !models.some((m) => m.name === sel)) set({ whisperModel: '' })
      })
      .catch(() => {})
    window.api.onProgress((e: ProgressEvent) => {
      set({ job: { active: e.percent < 100, kind: e.kind, percent: e.percent, message: e.message } })
    })
  },

  addToLibrary: async () => {
    // Multi-select: creators can add several clips in one go. Duplicates
    // (already in the library) are skipped so re-picking is harmless.
    const picked = await window.api.openMediaDialogMulti()
    if (!picked || !picked.length) return
    set({ job: { active: true, kind: 'probe', percent: 0, message: picked.length > 1 ? `Adding ${picked.length} clips…` : 'Adding to library…' } })
    const lib = [...get().library]
    let added = 0
    let lastName = ''
    for (const p of picked) {
      if (lib.some((it) => it.path === p.path)) continue
      const item = await buildLibraryItem(p.path, p.name)
      lib.push(item)
      added++
      lastName = item.name
    }
    saveLibrary(lib)
    set({
      library: lib,
      job: {
        active: false,
        percent: 100,
        message: added === 0 ? 'Already in the library' : added === 1 ? `Added ${lastName} to the library` : `Added ${added} clips to the library`
      }
    })
  },

  addAudioToLibrary: async () => {
    // Audio picker (files/storage). Cloud exposes openAudioDialogMulti; desktop
    // falls back to the normal media dialog (its native file browser shows audio).
    const api = window.api as unknown as { openAudioDialogMulti?: () => Promise<{ path: string; name: string }[]> }
    const picked = api.openAudioDialogMulti ? await api.openAudioDialogMulti() : await window.api.openMediaDialogMulti()
    if (!picked || !picked.length) return
    set({ job: { active: true, kind: 'probe', percent: 0, message: 'Adding audio…' } })
    const lib = [...get().library]
    let added = 0
    let lastName = ''
    for (const p of picked) {
      if (lib.some((it) => it.path === p.path)) continue
      const item = await buildLibraryItem(p.path, p.name)
      lib.push(item)
      added++
      lastName = item.name
    }
    saveLibrary(lib)
    set({
      library: lib,
      job: { active: false, percent: 100, message: added === 0 ? 'Already in the library' : added === 1 ? `Added ${lastName}` : `Added ${added} audio files` }
    })
  },

  importFolderToLibrary: async () => {
    const items = await window.api.importFolder()
    if (!items.length) return
    set({ job: { active: true, kind: 'probe', percent: 0, message: `Importing ${items.length} file(s)…` } })
    const lib = [...get().library]
    let added = 0
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      if (lib.some((x) => x.path === it.path)) continue
      try {
        lib.push(await buildLibraryItem(it.path, it.name))
        added++
      } catch {
        /* skip unreadable file */
      }
      saveLibrary(lib)
      set({
        library: [...lib],
        job: {
          active: true,
          kind: 'probe',
          percent: Math.round(((i + 1) / items.length) * 100),
          message: `Imported ${added}/${items.length}…`
        }
      })
    }
    set({ library: [...lib], job: { active: false, percent: 100, message: `Imported ${added} file(s) into the library` } })
  },

  addToSequence: (libraryId) =>
    set((s) => {
      const it = s.library.find((x) => x.id === libraryId)
      if (!it || it.kind === 'audio') return {} // videos + images go in the base
      const seq = [...(s.project.baseSequence ?? []), seqClipFromLibrary(it)]
      return {
        project: { ...s.project, baseSequence: seq },
        job: { active: false, percent: 100, message: `Sequence: ${seq.length} clip(s)` }
      }
    }),

  addAllToSequence: () =>
    set((s) => {
      const vids = s.library.filter((it) => it.kind === 'video' || it.kind === 'image').slice().sort(byClipName)
      if (!vids.length) return { job: { active: false, percent: 0, message: 'No videos/images in the library to add' } }
      const seq = [...(s.project.baseSequence ?? []), ...vids.map(seqClipFromLibrary)]
      return {
        project: { ...s.project, baseSequence: seq },
        job: { active: false, percent: 100, message: `Sequence: ${seq.length} clip(s) — numbered in order` }
      }
    }),

  // Build the base timeline from EVERY video/image in the library, in filename
  // (natural/numeric) order, as one gapless sequence (montage). Doc-native: we rebuild the
  // authoritative timeline document HERE (the same proven path as
  // setBaseFromLibrary), so the live-engine timeline in the new UI shows the
  // sequence immediately — projectStructureKey changes → TimelinePanel replaces
  // the engine document from this project.
  addAllToTimeline: () => {
    const s = get()
    // Alphabetical / numeric filename order (0501 < 0502 < 0510), NOT import order.
    const vids = s.library.filter((it) => it.kind === 'video' || it.kind === 'image').slice().sort(byClipName)
    if (!vids.length) {
      set({ job: { active: false, percent: 0, message: 'No videos or images in the library to add' } })
      return
    }
    const cur = s.project
    // Only warn when there's real work to lose (a populated base + a transcript).
    const doc = getSharedEngine()?.document ?? cur.timeline
    const mainHasClips = doc ? doc.tracks.some((t) => t.isMain && t.clips.length > 0) : !!cur.media
    if ((mainHasClips || (cur.baseSequence?.length ?? 0) > 0) && cur.transcript) {
      const ok = window.confirm(
        'Build one sequence from all media clips? This replaces the current base track and clears its transcript and base edits.'
      )
      if (!ok) {
        set({ job: { active: false, percent: 0, message: 'Canceled' } })
        return
      }
    }
    const seq = vids.map(seqClipFromLibrary)
    // Replace ONLY the base track with the sequence; keep the project's overlays,
    // text, and music (spread ...cur, like dropOntoBase). Clear the base-specific
    // cut state (transcript/silences/cuts) since the base changed.
    const fresh: Project = {
      ...cur,
      baseSequence: seq,
      media: undefined,
      transcript: undefined,
      silences: [],
      manualCuts: [],
      keepOverrides: [],
      baseSplits: [],
      playhead: 0
    }
    fresh.timeline = normalizeDefaultLanes(projectToDocument(fresh))
    set({
      project: fresh,
      mediaUrl: null,
      waveform: null,
      thumbnails: [],
      selectedWordIds: new Set(),
      selectedClipId: null,
      selectedSeg: null,
      selectedTextId: null,
      job: { active: false, percent: 100, message: `Timeline: ${seq.length} clip(s) in a sequence` }
    })
  },

  // Drag a clip onto the A-roll → append it to the base as a SEPARATE clip (no
  // merge). The current single base becomes clip 1; the dropped clip is appended.
  // The clips show side-by-side in the multi-clip base timeline; they're only
  // merged into one video lazily when you Transcribe / Remove silence / Export.
  dropOntoBase: (libraryId) =>
    set((s) => {
      const it = s.library.find((x) => x.id === libraryId)
      if (!it || it.kind === 'audio') return {}
      const seq: SequenceClip[] = [...(s.project.baseSequence ?? [])]
      if (seq.length === 0 && s.project.media) {
        // Seed clip 1 from the current single-clip base — and CARRY OVER its
        // cleaning (transcript/silences/cuts are already in this media's source
        // time = clip-local), so dropping a 2nd clip onto an edited single-clip
        // project doesn't discard the work.
        seq.push({
          ...seqClipFromMedia(s.project.media),
          transcript: s.project.transcript,
          silences: s.project.silences,
          manualCuts: s.project.manualCuts,
          keepOverrides: s.project.keepOverrides,
          silencePadding: s.project.silencePadding
        })
      }
      seq.push(seqClipFromLibrary(it))
      return {
        project: {
          ...s.project,
          baseSequence: seq,
          media: undefined, // multi-clip base now → not a single combined video
          transcript: undefined,
          silences: [],
          manualCuts: [],
          keepOverrides: [],
          baseSplits: [],
          playhead: 0
        },
        mediaUrl: null,
        waveform: null,
        thumbnails: [],
        selectedWordIds: new Set(),
        selectedSeg: null,
        selectedClipId: null,
        selectedTextId: null,
        job: { active: false, percent: 100, message: `Base = ${seq.length} clips (separate). Transcribe / Remove silence merges + runs across all.` }
      }
    }),

  reorderSequence: (from, to) =>
    set((s) => {
      const seq = [...(s.project.baseSequence ?? [])]
      if (from < 0 || from >= seq.length || to < 0 || to >= seq.length) return {}
      const [m] = seq.splice(from, 1)
      seq.splice(to, 0, m)
      return { project: { ...s.project, baseSequence: seq } }
    }),

  removeSequenceClip: (id) =>
    set((s) => ({
      project: { ...s.project, baseSequence: (s.project.baseSequence ?? []).filter((c) => c.id !== id) }
    })),

  trimSequenceClip: (id, sourceIn, sourceOut) =>
    set((s) => ({
      project: {
        ...s.project,
        baseSequence: (s.project.baseSequence ?? []).map((c) => {
          if (c.id !== id) return c
          const dur = c.sourceDuration || c.sourceOut
          const inS = Math.max(0, Math.min(sourceIn, dur - 0.1))
          const outS = Math.max(inS + 0.1, Math.min(sourceOut, dur))
          return { ...c, sourceIn: inS, sourceOut: outS }
        })
      }
    })),

  moveSequenceClip: (id, laneStart) =>
    set((s) => ({
      project: {
        ...s.project,
        baseSequence: (s.project.baseSequence ?? []).map((c) =>
          c.id === id ? { ...c, laneStart: Math.max(0, laneStart) } : c
        )
      }
    })),

  storeSequenceCleaning: (transcriptMap, silenceMap) =>
    set((s) => ({
      project: {
        ...s.project,
        baseSequence: (s.project.baseSequence ?? []).map((c) => {
          const t = transcriptMap?.get(c.id)
          const sil = silenceMap?.get(c.id)
          if (t === undefined && sil === undefined) return c
          return { ...c, ...(t !== undefined ? { transcript: t } : {}), ...(sil !== undefined ? { silences: sil } : {}) }
        })
      }
    })),

  clearSequence: () => set((s) => ({ project: { ...s.project, baseSequence: [], transcript: undefined, silences: [] }, waveform: null })),

  ensureMontageWaveform: async () => {
    const p = get().project
    if (!isMultiBase(p)) return
    const paths = Array.from(new Set((p.baseSequence ?? []).map((c) => c.sourcePath)))
    // Stitch immediately from whatever is cached (so trim/reorder is instant)…
    const paint = (): void => {
      const sources: Record<string, Waveform | undefined> = {}
      for (const path of paths) sources[path] = srcWaveCache.get(path)
      const wf = stitchMontageWaveform(get().project, sources)
      if (wf) set({ waveform: wf })
    }
    paint()
    // …then fetch any missing source peaks and repaint as they arrive.
    const missing = paths.filter((path) => !srcWaveCache.has(path))
    if (!missing.length) return
    await Promise.all(
      missing.map(async (path) => {
        try {
          const wf = await window.api.waveform(path)
          if (wf) srcWaveCache.set(path, wf)
        } catch {
          /* ignore a source that can't be probed */
        }
      })
    )
    // Only repaint if we're still on the same montage (guard against races).
    if (isMultiBase(get().project)) paint()
  },

  combineSequence: async () => {
    const clips = get().project.baseSequence ?? []
    if (!clips.length) return
    set({ job: { active: true, kind: 'export', percent: 0, message: 'Cut Lord is compiling your clips…' } })
    try {
      const info = await window.api.combineClips(clips)
      set((s) => ({
        project: {
          ...s.project,
          media: info,
          baseSequence: [],
          transcript: undefined,
          silences: [],
          manualCuts: [],
          keepOverrides: [],
          baseSplits: [],
          playhead: 0
        },
        mediaUrl: mediaUrl(info.path),
        waveform: null,
        musicWaveform: null,
        thumbnails: [],
        selectedWordIds: new Set(),
        selectedClipId: null,
        selectedSeg: null,
        selectedTextId: null,
        editingClipId: null,
        past: [],
        future: [],
        canUndo: false,
        canRedo: false,
        job: { active: false, percent: 100, message: 'Combined into one base. Click 📝 Transcribe to caption/clean the whole video.' }
      }))
      window.api.waveform(info.path).then((wf) => set({ waveform: wf })).catch(() => undefined)
      window.api.thumbnails(info.path).then((t) => set({ thumbnails: t })).catch(() => undefined)
    } catch (e) {
      set({ job: { active: false, percent: 0, message: `Combine failed: ${safeErrMessage(e)}` } })
    }
  },

  editSequenceClip: (id) => {
    const s = get()
    const clip = (s.project.baseSequence ?? []).find((c) => c.id === id)
    if (!clip) return
    const media: MediaInfo = {
      path: clip.sourcePath,
      duration: clip.sourceDuration || clip.sourceOut,
      width: clip.srcW,
      height: clip.srcH,
      fps: clip.fps,
      hasAudio: clip.hasAudio,
      hasVideo: true
    }
    set({
      editingClipId: id,
      playing: false,
      project: {
        ...s.project,
        media,
        transcript: clip.transcript,
        silences: clip.silences ?? [],
        manualCuts: clip.manualCuts ?? [],
        keepOverrides: clip.keepOverrides ?? [],
        silencePadding: clip.silencePadding ?? 0.08,
        baseSplits: [],
        playhead: 0
      },
      mediaUrl: mediaUrl(clip.sourcePath),
      waveform: null,
      musicWaveform: null,
      thumbnails: [],
      selectedWordIds: new Set(),
      selectedClipId: null,
      selectedSeg: null,
      selectedTextId: null,
      past: [],
      future: [],
      canUndo: false,
      canRedo: false
    })
    window.api.waveform(clip.sourcePath).then((wf) => set({ waveform: wf })).catch(() => undefined)
    window.api.thumbnails(clip.sourcePath).then((t) => set({ thumbnails: t })).catch(() => undefined)
  },

  finishSequenceClipEdit: () => {
    const s = get()
    const id = s.editingClipId
    if (!id) return
    const p = s.project
    const updated = (p.baseSequence ?? []).map((c) =>
      c.id === id
        ? {
            ...c,
            transcript: p.transcript,
            silences: p.silences,
            manualCuts: p.manualCuts,
            keepOverrides: p.keepOverrides,
            silencePadding: p.silencePadding
          }
        : c
    )
    set({
      editingClipId: null,
      playing: false,
      project: {
        ...p,
        baseSequence: updated,
        media: undefined,
        transcript: undefined,
        silences: [],
        manualCuts: [],
        keepOverrides: [],
        baseSplits: [],
        playhead: 0
      },
      mediaUrl: null,
      waveform: null,
      musicWaveform: null,
      thumbnails: [],
      selectedWordIds: new Set(),
      selectedClipId: null,
      selectedSeg: null,
      selectedTextId: null,
      past: [],
      future: [],
      canUndo: false,
      canRedo: false
    })
  },

  removeFromLibrary: (id) => {
    const library = get().library.filter((it) => it.id !== id)
    saveLibrary(library)
    set({ library })
  },

  setBaseFromLibrary: (id) => {
    const item = get().library.find((it) => it.id === id)
    if (!item) return
    if (item.kind === 'image') {
      set({ job: { active: false, percent: 0, message: 'Images go on overlay tracks, not the base — use “Add to track”.' } })
      return
    }
    const cur = get().project
    // The timeline is authoritative: "already loaded" only when the MAIN lane
    // still carries this source. The legacy media field alone can be stale —
    // deleting the clip from the timeline never clears it, which used to lock
    // the library item out of "Use as base" forever.
    const doc = getSharedEngine()?.document ?? cur.timeline
    const onMainLane = doc
      ? doc.tracks.some((t) => t.isMain && t.clips.some((c) => c.sourcePath === item.path))
      : cur.media?.path === item.path
    if (onMainLane) {
      set({ job: { active: false, percent: 100, message: `${item.name} is already the base track` } })
      return
    }
    // Only warn when there's actually an edit to lose: a populated main lane
    // (or, pre-doc, a loaded media) plus a transcript.
    const mainHasClips = doc ? doc.tracks.some((t) => t.isMain && t.clips.length > 0) : !!cur.media
    if (mainHasClips && cur.transcript) {
      const ok = window.confirm(
        'Load this as the base track? The current transcript and base edits are cleared. ' +
          '(Your media library and any overlay/text clips for this base are also reset.)'
      )
      if (!ok) {
        set({ job: { active: false, percent: 0, message: 'Canceled' } })
        return
      }
    }
    // Track 0 (base/A-roll) is DERIVED from the edit (keep ranges); overlay
    // tracks 1 & 2 hold manually-placed b-roll/overlay clips.
    const media: MediaInfo = {
      path: item.path,
      duration: item.duration,
      width: item.width,
      height: item.height,
      fps: item.fps,
      hasAudio: item.hasAudio,
      hasVideo: item.hasVideo
    }
    // Build the timeline document HERE (doc-native: it's authoritative from the
    // first render). The legacy sig-diff rebuild in TimelinePanel can't be relied
    // on — reloading the SAME video produces an identical structure key, so the
    // engine would keep whatever lane state it had (e.g. an emptied main lane).
    const fresh: Project = { ...newProject(), name: item.name, media }
    fresh.timeline = normalizeDefaultLanes(projectToDocument(fresh))
    set({
      project: fresh,
      mediaUrl: mediaUrl(item.path),
      waveform: null,
      thumbnails: [],
      selectedWordIds: new Set(),
      selectedClipId: null,
      selectedSeg: null,
      selectedTextId: null
    })
    // Waveform + filmstrip in the background. Transcription is NOT automatic —
    // the user clicks "Transcribe" when ready.
    window.api.waveform(item.path).then((wf) => set({ waveform: wf })).catch(() => undefined)
    if (media.hasVideo) {
      window.api.thumbnails(item.path).then((t) => set({ thumbnails: t })).catch(() => undefined)
    }
    set({ job: { active: false, percent: 100, message: `Loaded ${item.name}. Click Transcribe to generate the transcript.` } })
  },

  importOverlayFromDevice: async () => {
    const path = await window.api.openMediaDialog()
    if (!path) return
    set({ job: { active: true, kind: 'probe', percent: 0, message: 'Adding overlay…' } })
    let item = get().library.find((it) => it.path === path)
    if (!item) {
      item = await buildLibraryItem(path)
      const library = [...get().library, item]
      saveLibrary(library)
      set({ library })
    }
    // Engine-native: the clip lands on a real overlay lane of the authoritative
    // timeline at the playhead (the lane is created on first use). The legacy
    // project.tracks path is invisible to doc-native projects.
    const ok = insertLibraryItemAtPlayhead(item, 'overlay')
    set({
      job: {
        active: false,
        percent: 100,
        message: ok ? `Overlay added at the playhead — drag or use Adjust to place it` : 'Import a base video first'
      }
    })
  },

  addLibraryToOverlay: (id, trackIndex = 1) => {
    const item = get().library.find((it) => it.id === id)
    if (!item) return
    const isImage = item.kind === 'image'
    const dur = isImage ? 4 : item.duration || 4
    const clip: Clip = {
      id: uid(),
      name: item.name,
      sourcePath: item.path,
      sourceIn: 0,
      sourceOut: dur,
      sourceDuration: isImage ? 3600 : item.duration || dur,
      isImage,
      srcW: item.width || 1920,
      srcH: item.height || 1080,
      start: get().project.playhead,
      x: 0.28,
      y: 0.28,
      scale: 0.45,
      crop: { l: 0, t: 0, r: 0, b: 0 },
      zoomStart: 1,
      zoomEnd: 1
    }
    set((s) => ({
      project: {
        ...s.project,
        tracks: s.project.tracks.map((t) =>
          t.index === trackIndex ? { ...t, clips: [...t.clips, clip] } : t
        )
      },
      job: { active: false, percent: 100, message: `Added ${item.name} to ${trackIndex === 1 ? 'Overlay 1' : 'Overlay 2'}` }
    }))
  },

  addMusic: async () => {
    const path = await window.api.openMediaDialog()
    if (!path) return
    set({ job: { active: true, kind: 'probe', percent: 0, message: 'Adding music…' } })
    const info = await window.api.probe(path).catch(() => null)
    const music: MusicClip = {
      path,
      name: mediaDisplayName(path),
      duration: info?.duration ?? 0,
      gain: 0.5,
      startAt: 0,
      loop: true
    }
    set((s) => ({
      project: { ...s.project, music },
      musicWaveform: null,
      job: { active: false, percent: 100, message: `Added music: ${music.name}` }
    }))
    window.api.waveform(path).then((wf) => set({ musicWaveform: wf })).catch(() => undefined)
  },

  updateMusic: (patch) =>
    set((s) => ({
      project: { ...s.project, music: s.project.music ? { ...s.project.music, ...patch } : s.project.music }
    })),

  removeMusic: () => set((s) => ({ project: { ...s.project, music: undefined }, musicWaveform: null })),

  importMedia: async () => {
    // Multi-select import: every picked clip lands in the library; the first
    // becomes the base you start editing.
    const picked = await window.api.openMediaDialogMulti()
    if (!picked || !picked.length) return
    set({ job: { active: true, kind: 'probe', percent: 0, message: picked.length > 1 ? `Importing ${picked.length} clips…` : 'Probing media' } })
    const lib = [...get().library]
    const items: LibraryItem[] = []
    for (const p of picked) {
      let item = lib.find((it) => it.path === p.path)
      if (!item) {
        item = await buildLibraryItem(p.path, p.name)
        lib.push(item)
      }
      items.push(item)
    }
    saveLibrary(lib)
    set({ library: lib })
    if (items[0]) get().setBaseFromLibrary(items[0].id)
  },

  appendToBase: async () => {
    const picked = await window.api.openMediaDialogMulti()
    if (!picked || !picked.length) return
    set({ job: { active: true, kind: 'probe', percent: 0, message: 'Importing…' } })
    const lib = [...get().library]
    const fresh: LibraryItem[] = []
    for (const p of picked) {
      let item = lib.find((x) => x.path === p.path)
      if (!item) {
        item = await buildLibraryItem(p.path, p.name)
        lib.push(item)
      }
      fresh.push(item)
    }
    saveLibrary(lib)
    set((s) => {
      const seq: SequenceClip[] = [...(s.project.baseSequence ?? [])]
      // A single-clip base becomes clip 1 (carry its cleaning), then append.
      if (seq.length === 0 && s.project.media) {
        seq.push({
          ...seqClipFromMedia(s.project.media),
          transcript: s.project.transcript,
          silences: s.project.silences,
          manualCuts: s.project.manualCuts,
          keepOverrides: s.project.keepOverrides,
          silencePadding: s.project.silencePadding
        })
      }
      for (const it of fresh) if (it.kind !== 'audio') seq.push(seqClipFromLibrary(it))
      return {
        library: lib,
        project: {
          ...s.project,
          baseSequence: seq,
          media: undefined,
          transcript: undefined,
          silences: [],
          manualCuts: [],
          keepOverrides: [],
          baseSplits: [],
        },
        mediaUrl: null,
        waveform: null,
        thumbnails: [],
        job: { active: false, percent: 100, message: `Base = ${seq.length} clip(s)` }
      }
    })
  },

  transcribe: async () => {
    if (!get().requireServer('Transcribe')) return
    const p0 = get().project
    // Multi-clip base: transcribe across ALL clips WITHOUT flattening — combine the
    // audio to a temp file, transcribe once, then re-split the words back per clip
    // so the clips stay separate on the timeline.
    if ((p0.baseSequence?.length ?? 0) > 0 && !p0.media) {
      const clips = p0.baseSequence!
      const { transcribeBackend, openaiAvailable, whisperModel } = get()
      const backend: TranscribeBackend = transcribeBackend === 'openai' && openaiAvailable ? 'openai' : 'local'
      set({ job: { active: true, kind: 'transcribe', percent: 0, message: 'Cut Lord is working…' } })
      try {
        const combined = await window.api.combineClips(clips, true) // audio-only = fast
        set({ job: { active: true, kind: 'transcribe', percent: 45, message: 'Cut Lord is listening…' } })
        const transcript: Transcript = await window.api.transcribe(
          combined.path,
          backend,
          backend === 'local' ? whisperModel || undefined : undefined
        )
        // Store the WHOLE transcript at project level, in montage (virtual) time.
        // The base stays a multi-clip sequence; computeKeepRanges now treats it as
        // one continuous timeline, so the Transcript panel / Fast Cut / Smart Cut
        // all operate across the clips without merging them.
        set((s) => ({
          project: { ...s.project, transcript },
          job: { active: false, percent: 100, message: `Transcribed ${transcript.words.length} words across ${clips.length} clip(s)` }
        }))
      } catch (e) {
        set({ job: { active: false, percent: 0, message: (e as Error).message } })
      }
      return
    }
    const { project, transcribeBackend, openaiAvailable, whisperModel } = get()
    if (!project.media) return
    const backend: TranscribeBackend = transcribeBackend === 'openai' && openaiAvailable ? 'openai' : 'local'
    const label = 'Cut Lord is listening…'
    set({ job: { active: true, kind: 'transcribe', percent: 0, message: label } })
    try {
      const transcript: Transcript = await window.api.transcribe(
        project.media.path,
        backend,
        backend === 'local' ? whisperModel || undefined : undefined
      )
      set((s) => ({
        project: { ...s.project, transcript },
        job: { active: false, percent: 100, message: `Transcribed ${transcript.words.length} words` }
      }))
    } catch (e) {
      set({ job: { active: false, percent: 0, message: (e as Error).message } })
    }
  },

  setTranscribeBackend: (b) => {
    try {
      localStorage.setItem('ec.transcribeBackend', b)
    } catch {
      /* ignore */
    }
    set({ transcribeBackend: b })
  },

  setWhisperModel: (name) => {
    try {
      localStorage.setItem('ec.whisperModel', name)
    } catch {
      /* ignore */
    }
    set({ whisperModel: name })
  },

  setSilences: (silences) => set((s) => ({ project: { ...s.project, silences } })),

  setSilenceAction: (id, action) =>
    set((s) => ({
      project: {
        ...s.project,
        silences: s.project.silences.map((r) => (r.id === id ? { ...r, action } : r))
      }
    })),

  setSilenceShorten: (id, shortenTo) =>
    set((s) => ({
      project: {
        ...s.project,
        silences: s.project.silences.map((r) =>
          r.id === id ? { ...r, action: 'shorten', shortenTo } : r
        )
      }
    })),

  removeAllSilence: () =>
    set((s) => ({
      project: {
        ...s.project,
        silences: s.project.silences.map((r) => ({ ...r, action: 'remove' }))
      }
    })),

  setSilencePadding: (p) =>
    set((s) => ({ project: { ...s.project, silencePadding: Math.max(0, Math.min(1, p)) } })),

  selectWord: (id, additive, rangeTo) => {
    const { project, selectedWordIds } = get()
    const words = project.transcript?.words ?? []
    if (rangeTo) {
      const i1 = words.findIndex((w) => w.id === id)
      const i2 = words.findIndex((w) => w.id === rangeTo)
      if (i1 >= 0 && i2 >= 0) {
        const [lo, hi] = i1 < i2 ? [i1, i2] : [i2, i1]
        const next = new Set(additive ? selectedWordIds : [])
        for (let i = lo; i <= hi; i++) next.add(words[i].id)
        set({ selectedWordIds: next })
        return
      }
    }
    const next = new Set(additive ? selectedWordIds : [])
    if (additive && next.has(id)) next.delete(id)
    else next.add(id)
    set({ selectedWordIds: next })
  },

  clearSelection: () => set({ selectedWordIds: new Set() }),

  selectFillers: () => {
    const t = get().project.transcript
    if (!t) {
      set({ job: { active: false, percent: 0, message: 'Transcribe first to find fillers' } })
      return
    }
    const ids = new Set(detectFillerIds(t, get().fillerWords))
    set({
      selectedWordIds: ids,
      job: {
        active: false,
        percent: 100,
        message: ids.size
          ? `Highlighted ${ids.size} filler word(s) — press Delete to remove`
          : 'No fillers found'
      }
    })
  },

  selectRepeats: () => {
    const t = get().project.transcript
    if (!t) {
      set({ job: { active: false, percent: 0, message: 'Transcribe first to find repeats' } })
      return
    }
    const ids = new Set(detectRepeatIds(t))
    set({
      selectedWordIds: ids,
      job: {
        active: false,
        percent: 100,
        message: ids.size
          ? `Highlighted ${ids.size} repeat/retake word(s) — press Delete to remove`
          : 'No repeats or extra takes found'
      }
    })
  },

  selectAICuts: async () => {
    if (!get().requireServer('AI Smart Cut')) return
    const t = get().project.transcript
    if (!t) {
      set({ job: { active: false, percent: 0, message: 'Transcribe first to run AI cuts' } })
      return
    }
    if (!get().openaiAvailable) {
      set({
        job: {
          active: false,
          percent: 0,
          message: 'AI cuts need an OpenAI key — add OPENAI_API_KEY to .env and restart'
        }
      })
      return
    }
    set({ job: { active: true, kind: 'transcribe', percent: 0, message: 'Cut Lord is thinking…' } })
    try {
      const res = await window.api.suggestCuts(t)
      // Union the AI judgment with the deterministic heuristic repeat-finder, so
      // Smart Cut never misses an obvious in-text repeat the offline detector
      // would catch. (Can't recover repeats whisper collapsed during transcription.)
      const ids = new Set([...res.ids, ...detectRepeatIds(t)])
      set({
        selectedWordIds: ids,
        job: {
          active: false,
          percent: 100,
          message: ids.size
            ? `Flagged ${ids.size} word(s) (AI + repeat scan) — review, then press Delete`
            : 'Nothing worth cutting found'
        }
      })
    } catch (e) {
      set({ job: { active: false, percent: 0, message: (e as Error).message } })
    }
  },

  cutLordSettings: ((): CutLordSettings => {
    try {
      const raw = localStorage.getItem('ec.cutlord')
      if (raw) {
        const j = JSON.parse(raw)
        return {
          ...DEFAULT_CUTLORD_SETTINGS,
          ...j,
          vad: { ...DEFAULT_CUTLORD_SETTINGS.vad, ...(j.vad ?? {}) },
          db: { ...DEFAULT_CUTLORD_SETTINGS.db, ...(j.db ?? {}) }
        }
      }
    } catch {
      /* ignore */
    }
    return { ...DEFAULT_CUTLORD_SETTINGS, vad: { ...DEFAULT_CUTLORD_SETTINGS.vad }, db: { ...DEFAULT_CUTLORD_SETTINGS.db } }
  })(),

  setCutLordSettings: (patch) => {
    const next: CutLordSettings = {
      ...get().cutLordSettings,
      ...patch,
      vad: { ...get().cutLordSettings.vad, ...(patch.vad ?? {}) },
      db: { ...get().cutLordSettings.db, ...(patch.db ?? {}) }
    }
    // Picking a preset mode while manual is OFF also refreshes the sliders to
    // that preset's values (so opening manual later starts from the preset).
    if (patch.mode && !next.manual) {
      next.vad = { ...CUTLORD_PRESETS[patch.mode].vad }
      next.db = { ...CUTLORD_PRESETS[patch.mode].db }
      next.useDb = CUTLORD_PRESETS[patch.mode].useDb
    }
    try {
      localStorage.setItem('ec.cutlord', JSON.stringify(next))
    } catch {
      /* ignore */
    }
    set({ cutLordSettings: next })
  },

  seamFade: ((): SeamFadeSettings => {
    try {
      const raw = localStorage.getItem('ec.seamFade')
      if (raw) return normalizeSeamFade(JSON.parse(raw))
    } catch {
      /* ignore */
    }
    return { ...DEFAULT_SEAM_FADE }
  })(),
  setSeamFade: (patch) => {
    const next = normalizeSeamFade({ ...get().seamFade, ...patch })
    try {
      localStorage.setItem('ec.seamFade', JSON.stringify(next))
    } catch {
      /* ignore */
    }
    set({ seamFade: next })
  },
  mediaCollapsed: ((): boolean => {
    try {
      return localStorage.getItem('ec.mediaCollapsed') === '1'
    } catch {
      return false
    }
  })(),
  setMediaCollapsed: (v) => {
    try {
      localStorage.setItem('ec.mediaCollapsed', v ? '1' : '0')
    } catch {
      /* ignore */
    }
    set({ mediaCollapsed: v })
  },
  silenceMasterySettings: ((): SilenceMasterySettings => {
    try {
      const raw = localStorage.getItem('ec.silenceMastery')
      if (raw) return normalizeSilenceMastery(JSON.parse(raw))
    } catch {
      /* ignore */
    }
    return { ...DEFAULT_SILENCE_MASTERY_SETTINGS }
  })(),
  setSilenceMasterySettings: (patch) => {
    const next = normalizeSilenceMastery({ ...get().silenceMasterySettings, ...patch })
    try {
      localStorage.setItem('ec.silenceMastery', JSON.stringify(next))
    } catch {
      /* ignore */
    }
    set({ silenceMasterySettings: next })
  },
  showSilenceMasterySettings: false,
  setShowSilenceMasterySettings: (v) => set({ showSilenceMasterySettings: v }),

  runSilenceMastery: async () => {
    // 1. A transcript is the engine's only input. Reuse the project's (no
    //    re-transcribe); otherwise run the same transcribe-only step the
    //    Transcript tab uses (AssemblyAI via /edge — needs the backend).
    if (!get().project.transcript?.words?.length) {
      if (!get().requireServer('Clean Silence (needs a transcript)')) return
      await get().transcribeOnly()
      if (!get().project.transcript?.words?.length) return // transcribeOnly surfaced the error
    }
    // 2. Fold a doc-native base (clip dragged straight onto the timeline) so
    //    media/baseSequence — and the duration below — see it. Same rationale
    //    as runRetakeCutBeta.
    const stored = get().project
    const p0 = stored.timeline ? documentToProject(stored.timeline, stored) : stored
    const t = get().project.transcript!
    const words = t.words.filter((w) => !w.deleted).map((w) => ({ start: w.start, end: w.end, text: w.text }))
    // Media length bounds the trailing cut: the real duration when known, else
    // the base timeline's length, else the last word (no trailing cut at all).
    const durationS = p0.media?.duration || baseTimelineDuration(p0) || (words.length ? words[words.length - 1].end : 0)
    const settings = get().silenceMasterySettings
    const { regions, stretched } = planSilenceMasteryDetailed(words, durationS, settings)
    // 3. Stage review-first: chips in the transcript + cards in the panel;
    //    retakeSilenceStaged=true → Execute applies these exact spans verbatim.
    set({
      stagedSilences: regions,
      stagedSilenceSel: new Set(regions.map((r) => r.id)),
      retakeSilenceStaged: true,
      job: {
        active: false,
        percent: 100,
        message: regions.length
          ? `Silence Mastery: ${regions.length} silent region${regions.length === 1 ? '' : 's'} found — review, then Apply`
          : 'Silence Mastery: no silence over the threshold — nothing to cut'
      }
    })
    // 4. Debug telemetry (best-effort, fire-and-forget): the exact inputs the
    //    engine saw and each gap's verdict, for offline review of misses.
    const r2 = (n: number): number => Math.round(n * 100) / 100
    const gaps: unknown[] = []
    if (words.length) {
      if (words[0].start > 0.01) gaps.push({ kind: 'leading', from: 0, to: r2(words[0].start), len: r2(words[0].start), cut: words[0].start >= settings.minSilenceS })
      for (let i = 0; i < words.length - 1; i++) {
        const len = words[i + 1].start - words[i].end
        if (len > 0.05) gaps.push({ kind: 'gap', from: r2(words[i].end), to: r2(words[i + 1].start), len: r2(len), cut: len >= settings.minSilenceS })
      }
      const tail = durationS - words[words.length - 1].end
      if (tail > 0.05) gaps.push({ kind: 'trailing', from: r2(words[words.length - 1].end), to: r2(durationS), len: r2(tail), cut: tail >= settings.minSilenceS })
    }
    void saveSilenceDebug('stage', {
      settings,
      duration_s: r2(durationS),
      media_path: p0.media?.path ?? null,
      doc_mode: !!stored.timeline,
      word_count: t.words.length,
      deleted_word_count: t.words.length - words.length,
      words: t.words.map((w) => [r2(w.start), r2(w.end), w.text, w.deleted ? 1 : 0]),
      gaps,
      staged_regions: regions.map((r) => [r.id, r2(r.start), r2(r.end)]),
      staged_total_s: r2(regions.reduce((n, r) => n + (r.end - r.start), 0)),
      stretched_word_repairs: stretched
    })
  },

  stagedSilences: [],
  stagedSilenceSel: new Set<string>(),
  retakeSilenceStaged: false,

  toggleStagedSilence: (id) =>
    set((s) => {
      const sel = new Set(s.stagedSilenceSel)
      if (sel.has(id)) sel.delete(id)
      else sel.add(id)
      return { stagedSilenceSel: sel }
    }),

  runFastCutLord: async () => {
    if (!get().requireServer('FastCut')) return
    set({ retakeSilenceStaged: false })
    // FastCut auto-transcribes with our inbuilt Parakeet — no manual transcribe step.
    if (!get().project.transcript && !(await get()._parakeetTranscribe())) return
    await get().selectFastCuts() // word engine: flags repeats/retakes (review-only)
    // ⚙ filler switch: also flag filler words (user-editable list) for review.
    if (get().cutLordSettings.fillers) {
      const fillerIds = detectFillerIds(get().project.transcript!, get().fillerWords)
      if (fillerIds.length) {
        set((st) => ({ selectedWordIds: new Set([...st.selectedWordIds, ...fillerIds]) }))
      }
    }
    // No silence staging — every silence engine was removed from this branch.
  },

  runProCut: async () => {
    if (!get().requireServer('ProCut')) return
    set({ retakeSilenceStaged: false }) // ProCut uses its own shared VAD, not Retake β's
    const s0 = get()
    const p0 = s0.project
    const hasBase = !!p0.media || ((p0.baseSequence?.length ?? 0) > 0)
    if (!hasBase) {
      set({ job: { active: false, percent: 0, message: 'Import a video first' } })
      return
    }
    set({ job: { active: true, kind: 'transcribe', percent: 1, message: 'Cut Lord is working (1/4)…' } })
    try {
      let path: string
      if (isMultiBase(p0)) {
        const combined = await window.api.combineClips(p0.baseSequence!, true)
        path = combined.path
      } else {
        path = p0.media!.path
      }
      // ProCut transcribes with its own OpenAI whisper-1 (inside cutCutPro) and pulls
      // it into the word selector below. Word cuts only — no silence pass exists.
      const res = await window.api.cutCutPro(path, p0.transcript ?? null, get().whisperModel || undefined, get().project.script || undefined)
      // REVIEW-ONLY: adopt the transcript if the pipeline made one (ids must
      // match), HIGHLIGHT the words + stage the pause cuts — nothing is applied
      // until the user presses Execute cuts. ⚙ filler switch adds filler words.
      const tRes = res.transcript ?? p0.transcript
      const fillerIds =
        get().cutLordSettings.fillers && tRes ? detectFillerIds(tRes, get().fillerWords) : []
      // SNAP the AI's flags to whole clauses and PROTECT the surviving last
      // take — the same deterministic guard FastCut uses. Kills the "first
      // half of take 1 spliced onto the tail of the final take" class of AI
      // boundary mistakes regardless of what the model returned.
      const snapped = tRes ? snapRetakeFlags(res.deleteWordIds, tRes) : res.deleteWordIds
      set((s) => ({
        project: res.transcript ? { ...s.project, transcript: res.transcript } : s.project,
        selectedWordIds: new Set([...snapped, ...fillerIds]),
        job: {
          active: false,
          percent: 100,
          message:
            `ProCut flagged ${snapped.length} word(s) — review, then Execute cuts` +
            (res.debugPath ? ` · debug: ${res.debugPath.split(/[\\/]/).slice(-1)[0]}` : '')
        }
      }))
    } catch (e) {
      set({ job: { active: false, percent: 0, message: `ProCut failed: ${safeErrMessage(e)}` } })
    }
  },

  runRetakeCutBeta: async () => {
    if (!get().requireServer('Retake β')) return
    // Retake-Aware Cut Beta — fully separate path (cut_mode: retake_aware_beta).
    // Same review-first contract as FastCut/ProCut: highlight + stage, apply on
    // Execute cuts. Deliberately does NOT call snapRetakeFlags or any standard-
    // engine helper: the beta engine guarantees whole-attempt spans itself.
    // Doc-native projects (new UI) hold the base on the timeline DOCUMENT, not the
    // legacy media/baseSequence fields — a clip dragged straight onto the timeline
    // lives only in the doc (setTimelineDoc doesn't touch media/baseSequence). Fold
    // the doc back (same as exportVideo) so hasBase + the audio path below see it.
    const stored = get().project
    const p0 = stored.timeline ? documentToProject(stored.timeline, stored) : stored
    const hasBase = !!p0.media || ((p0.baseSequence?.length ?? 0) > 0)
    if (!hasBase) {
      set({ job: { active: false, percent: 0, message: 'Import a video first' } })
      return
    }
    set({ job: { active: true, kind: 'transcribe', percent: 1, message: 'Warming up Cut Lord…' }, cutJobActive: true })
    try {
      let path: string
      if (isMultiBase(p0)) {
        const combined = await window.api.combineClips(p0.baseSequence!, true)
        path = combined.path
      } else {
        path = p0.media!.path
      }
      const res = await window.api.retakeAwareCut(path)
      const cur = get().project
      // REVIEW-STATE CONTRACT (the whole point of this fix):
      //  - ALWAYS show the beta's FULL raw/verbatim transcript. Its decisions
      //    were made on these exact words, so the displayed words and the
      //    flagged ids are guaranteed to reference the same list (rw*). We do
      //    NOT keep a prior transcript and time-map onto it — a mismatched
      //    (whisper) transcript could highlight the wrong words or none.
      //  - Proposed cuts are staged ONLY as `selectedWordIds` (the same blue-
      //    highlight review set FastCut/ProCut use). We NEVER set word.deleted
      //    and NEVER trim words here — nothing leaves the transcript until the
      //    user presses Execute cuts (which is the only place deleted is set).
      // DOC-NATIVE BASE (new UI): a clip dragged straight onto the timeline lives
      // ONLY on the timeline document — the legacy media/baseSequence fields stay
      // empty. But every cut helper (computeKeepRanges, and the timeline's
      // document-mode cut routing) measures cuts against that legacy base, so with
      // it empty Execute cuts updates the transcript yet never reaches the Main
      // lane: the cuts "show in the transcript" while the timeline stays uncut.
      // Persist the base we just folded + transcribed. p0.baseSequence is the EXACT
      // source `retakeAwareCut` combined above, so the transcript's word times are
      // guaranteed to live in its domain — persisting it keeps base and transcript
      // aligned and lets the standard pipeline cut the timeline like a normal import.
      // Applies whenever the base is doc-derived (not a single flattened `media`
      // video): the first Retake on a dragged clip (legacy base empty) AND every
      // "Run again" after edits, where re-folding the now-cut doc keeps baseSequence
      // matched to the freshly-combined transcript. A real single-`media` project
      // (which already routes cuts fine) is left untouched; a legacy montage with no
      // doc yet folds to its own baseSequence, so this is a harmless self-assignment.
      const docBase = !cur.media && !!p0.baseSequence?.length
      const nextProject: typeof cur = docBase
        ? { ...cur, media: undefined, baseSequence: p0.baseSequence, transcript: res.transcript }
        : { ...cur, transcript: res.transcript }
      const flagIds = res.deleteWordIds
      const wordsBefore = cur.transcript?.words.length ?? 0
      // Silence engines are gone from this branch — res.silenceRegions is
      // always empty; staging stays for the review/execute contract.
      const silenceRegions = res.silenceRegions ?? []
      set({
        project: nextProject,
        selectedWordIds: new Set(flagIds),
        stagedSilences: silenceRegions,
        stagedSilenceSel: new Set(silenceRegions.map((r) => r.id)),
        retakeSilenceStaged: true
      })
      // ---- REVIEW-STATE AUDIT (runs on the REAL post-update state) ----
      // Proves in the console, after every run, that the full raw provider
      // transcript is what the tab renders and that nothing was pre-applied.
      const t = get().project.transcript
      const shownIds = new Set(t?.words.map((w) => w.id) ?? [])
      const missingFlags = flagIds.filter((id) => !shownIds.has(id))
      const preDeleted = t?.words.filter((w) => w.deleted).length ?? 0
      const audit = {
        mode: 'retake_aware_beta' as const,
        provider: res.provider,
        raw_provider_words_count: res.verbatim.words.length,
        project_transcript_words_count_before: wordsBefore,
        project_transcript_words_count_after: t?.words.length ?? 0,
        final_cut_spans_count: res.cutSpans.length,
        mapped_word_ids_count: flagIds.length,
        hidden_words_before_execute_count: missingFlags.length + preDeleted,
        auto_applied_before_review: preDeleted > 0,
        review_state_applied: true,
        mapped_selected_word_text_preview: flagIds
          .slice(0, 16)
          .map((id) => t?.words.find((w) => w.id === id)?.text ?? '?')
      }
      console.log('[retake-aware-beta][review-audit]', audit)
      const reviewBroken =
        audit.hidden_words_before_execute_count > 0 ||
        audit.auto_applied_before_review ||
        audit.project_transcript_words_count_after !== audit.raw_provider_words_count
      if (reviewBroken) {
        console.error('[retake-aware-beta] REVIEW-STATE ERROR: words hidden/pre-applied before Execute cuts', audit)
      }
      set({
        cutJobActive: false,
        job: {
          active: false,
          percent: 100,
          message:
            `${res.summary} — ${flagIds.length} word(s) highlighted` +
            (silenceRegions.length ? ` + ${silenceRegions.length} pause(s)` : '') +
            `, review then Execute cuts` +
            (!IS_CLOUD && res.debugPath ? ` · debug: ${res.debugPath.split(/[\\/]/).slice(-1)[0]}` : '') +
            (!IS_CLOUD && res.warnings.length ? ` · ${res.warnings.length} warning(s), see debug` : '') +
            (!IS_CLOUD && reviewBroken ? ' · ⚠ REVIEW-STATE ERROR — see console/debug' : '')
        }
      })
    } catch (e) {
      // Show the REAL error on-screen (the vanishing job message hid it on mobile).
      ;(window as unknown as { __ecError?: (l: string, e: unknown) => void }).__ecError?.('Cut Lord (Retake β) failed', e)
      set({
        cutJobActive: false,
        job: {
          active: false,
          percent: 0,
          message: IS_CLOUD ? 'Retake β couldn’t finish — please try again.' : `Retake β failed: ${(e as Error).message}`
        }
      })
    }
  },

  transcribeOnly: async () => {
    if (!get().requireServer('Transcribe')) return
    // Base resolution mirrors runRetakeCutBeta EXACTLY: fold a doc-native timeline
    // back so a clip dragged straight onto the timeline (legacy media/baseSequence
    // empty) is still found, and combine a multi-clip base to audio for STT.
    const stored = get().project
    const p0 = stored.timeline ? documentToProject(stored.timeline, stored) : stored
    const hasBase = !!p0.media || ((p0.baseSequence?.length ?? 0) > 0)
    if (!hasBase) {
      set({ job: { active: false, percent: 0, message: 'Import a video first' } })
      return
    }
    set({ job: { active: true, kind: 'transcribe', percent: 1, message: 'Cut Lord is listening…' } })
    try {
      let path: string
      if (isMultiBase(p0)) {
        const combined = await window.api.combineClips(p0.baseSequence!, true)
        path = combined.path
      } else {
        path = p0.media!.path
      }
      // The SAME AssemblyAI verbatim transcribe step Retake β runs (cloud:
      // window.api.transcribe -> transcribeCloud, cached by mediaId and sharing
      // Retake β's transcript cache) — NO judge, NO silence, NO word cuts.
      const transcript = await window.api.transcribe(path)
      const cur = get().project
      // Persist the folded doc base (identical rationale to runRetakeCutBeta) so the
      // transcript's word times live in the base's domain and later cuts align.
      const docBase = !cur.media && !!p0.baseSequence?.length
      const nextProject: typeof cur = docBase
        ? { ...cur, media: undefined, baseSequence: p0.baseSequence, transcript }
        : { ...cur, transcript }
      set({
        project: nextProject,
        job: { active: false, percent: 100, message: `Transcribed ${transcript.words.length} words` }
      })
    } catch (e) {
      ;(window as unknown as { __ecError?: (l: string, e: unknown) => void }).__ecError?.('Transcribe failed', e)
      set({
        job: {
          active: false,
          percent: 0,
          message: IS_CLOUD ? 'Transcription couldn’t finish — please try again.' : `Transcription failed: ${safeErrMessage(e)}`
        }
      })
    }
  },

  aiVariations: [],
  aiVariationWarnings: [],
  aiVariationsBusy: false,

  // AI VARIATIONS — cast the transcript into short-form arrangements.
  //
  // Review-first, like every other engine here: the results are held in the store
  // and nothing touches the timeline until the creator applies one.
  generateVariations: async (count: number) => {
    if (get().aiVariationsBusy) return []
    // Needs words, not audio — reuse the transcript when the project already has
    // one (Find cuts, or a previous run) instead of paying for STT again.
    if (!get().project.transcript?.words?.length) {
      await get().transcribeOnly()
      if (!get().project.transcript?.words?.length) return [] // transcribeOnly reported why
    }
    const stored = get().project
    const p0 = stored.timeline ? documentToProject(stored.timeline, stored) : stored
    const durationS =
      stored.media?.duration ??
      (p0.baseSequence ?? []).reduce((n, c) => n + Math.max(0, c.sourceOut - c.sourceIn), 0)

    set({ aiVariationsBusy: true, job: { active: true, kind: 'variations', percent: 20, message: 'Casting variations…' } })
    try {
      const res = await generateVariationsCloud(
        get().project.transcript!,
        durationS,
        count,
        (percent, message) => set({ job: { active: true, kind: 'variations', percent, message } })
      )
      set({
        aiVariations: res.variations,
        aiVariationWarnings: res.warnings,
        aiVariationsBusy: false,
        job: {
          active: false,
          percent: 100,
          message: res.variations.length
            ? `${res.variations.length} variation${res.variations.length === 1 ? '' : 's'} ready — pick one to apply`
            : 'No variations could be built from this transcript'
        }
      })
      return res.variations
    } catch (e) {
      set({
        aiVariationsBusy: false,
        job: { active: false, percent: 0, message: `Variations couldn’t finish: ${safeErrMessage(e)}` }
      })
      return []
    }
  },

  // VARIATIONS — rebuild the main lane from a creator-supplied clip list.
  //
  // Every entry is a range of the SOURCE video, and the ARRAY ORDER is the edit
  // order: ranges may run out of order, repeat, or overlap. So this does not
  // "cut" anything in the retake sense — it REPLACES the main lane with exactly
  // the requested arrangement, laid out gapless in the given order.
  //
  // Source identity (path, dimensions, fps, audio) is copied off the lane's
  // existing first clip, so a variation always references the video already in
  // the project rather than trusting the file to name one.
  applyVariation: (variation: Variation) => {
    const engine = getSharedEngine()
    const doc = engine?.document
    if (!engine || !doc) {
      set({ job: { active: false, percent: 0, message: 'Timeline is still loading — try again in a moment' } })
      return
    }
    const mainId = mainTrackId(doc)
    const main = mainId ? findTrack(doc, mainId) : undefined
    const source = (main?.clips ?? []).slice().sort((a, b) => a.start - b.start).find((c) => !!c.sourcePath)
    if (!mainId || !source?.sourcePath) {
      set({ job: { active: false, percent: 0, message: 'Import a video first' } })
      return
    }

    const tb = doc.timebase
    const cmds: Command[] = []
    // Clear the lane first so a variation is a REPLACEMENT, not an append — two
    // runs in a row give the same result rather than stacking.
    for (const c of main!.clips) cmds.push(TimelineCommands.removeClip(c.id))

    let playhead = 0
    for (const [i, v] of variation.clips.entries()) {
      // MIND THE UNITS: placement (start/duration) is in FRAMES, but the source
      // slice (sourceIn/sourceOut/sourceDuration) is in SECONDS. Converting the
      // slice to frames too makes every clip seek far past the end of the media,
      // which renders as a black preview and a single frozen frame on export.
      const duration = Math.max(1, secondsToFrames(v.end - v.start, tb))
      cmds.push(
        TimelineCommands.addClip(
          createClip({
            kind: 'video',
            trackId: mainId,
            start: playhead,
            duration,
            name: v.name || `${i + 1}`,
            sourcePath: source.sourcePath,
            sourceIn: v.start,
            sourceOut: v.end,
            // Full source length, NOT this clip's out-point: headroomAfterFrames
            // needs it to leave the right trim handle any room to drag.
            sourceDuration: source.sourceDuration ?? get().project.media?.duration ?? undefined,
            srcW: source.srcW,
            srcH: source.srcH,
            srcFps: source.srcFps,
            hasAudio: source.hasAudio,
            // Tagged so a later pass can tell a variation clip from a hand edit.
            metadata: { variationIndex: i, variationName: variation.name ?? '' }
          })
        )
      )
      playhead += duration
    }

    engine.batch(variation.name ? `Variation: ${variation.name}` : 'Apply variation', cmds)

    // A variation IS the edit, so the legacy cut state has to go with it.
    //
    // TimelinePanel keeps the main lane in sync with the legacy cut fields: in
    // doc mode it ripple-deletes computeKeepRanges' removals out of the lane
    // whenever the cut signature changes, and in legacy mode it rebuilds the doc
    // from those fields outright. Either way, leaving stale silences or deleted
    // transcript words behind means the next cut-state change re-subtracts them
    // FROM the variation — the creator asked for 79.8–86.8s and silently got a
    // shorter clip with its pauses removed.
    //
    // Clearing them makes computeKeepRanges return the whole source, so that sync
    // becomes a no-op and the arrangement is exactly what the JSON asked for. The
    // doc is also written straight to project.timeline so it is authoritative even
    // if the timeline panel is unmounted and its persist subscriber never runs.
    const transcript = get().project.transcript
    set((s) => ({
      project: {
        ...s.project,
        timeline: engine.document,
        silences: [],
        manualCuts: [],
        keepOverrides: [],
        baseSplits: [],
        transcript:
          transcript && transcript.words.some((w) => w.deleted)
            ? { ...transcript, words: transcript.words.map((w) => (w.deleted ? { ...w, deleted: false } : w)) }
            : transcript
      },
      // Pending review state belongs to the edit we just replaced.
      stagedSilences: [],
      stagedSilenceSel: new Set<string>(),
      retakeSilenceStaged: false,
      selectedWordIds: new Set<string>(),
      job: {
        active: false,
        percent: 100,
        message: `${variation.clips.length} clip${variation.clips.length === 1 ? '' : 's'} arranged — ${variationDuration(variation).toFixed(1)}s`
      }
    }))
  },

  runUltracut: async () => {
    if (!get().requireServer('Ultracut')) return
    // Ultracut (Beta) — a SEPARATE experimental engine (window.api.ultracutCut →
    // ultracut-judge edge fn, OpenRouter GLM 5.2). Shares NOTHING with Retake Beta's
    // Opus judge, so its cuts can be compared against Retake Beta's in the app. Same
    // review-first contract (highlight + stage, apply on Execute cuts).
    const runUltra = (window.api as { ultracutCut?: typeof window.api.retakeAwareCut }).ultracutCut
    if (!runUltra) {
      // Ultracut's judge only exists in the cloud build. Off-cloud (desktop /
      // self-host) fall back to Retake β rather than dead-ending with an error.
      await get().runRetakeCutBeta()
      return
    }
    const stored = get().project
    const p0 = stored.timeline ? documentToProject(stored.timeline, stored) : stored
    const hasBase = !!p0.media || ((p0.baseSequence?.length ?? 0) > 0)
    if (!hasBase) {
      set({ job: { active: false, percent: 0, message: 'Import a video first' } })
      return
    }
    set({ job: { active: true, kind: 'transcribe', percent: 1, message: 'Warming up Ultracut…' } })
    try {
      let path: string
      if (isMultiBase(p0)) {
        const combined = await window.api.combineClips(p0.baseSequence!, true)
        path = combined.path
      } else {
        path = p0.media!.path
      }
      const res = await runUltra(path)
      const cur = get().project
      // DOC-NATIVE BASE (new UI): persist the folded base so Execute cuts reach the
      // Main lane — identical rationale to runRetakeCutBeta (see the note there).
      const docBase = !cur.media && !!p0.baseSequence?.length
      const nextProject: typeof cur = docBase
        ? { ...cur, media: undefined, baseSequence: p0.baseSequence, transcript: res.transcript }
        : { ...cur, transcript: res.transcript }
      const flagIds = res.deleteWordIds
      // Silence engines are gone from this branch — always empty.
      const silenceRegions = res.silenceRegions ?? []
      set({
        project: nextProject,
        selectedWordIds: new Set(flagIds),
        stagedSilences: silenceRegions,
        stagedSilenceSel: new Set(silenceRegions.map((r) => r.id)),
        retakeSilenceStaged: true
      })
      set({
        cutJobActive: false,
        job: {
          active: false,
          percent: 100,
          message:
            `${res.summary} — ${flagIds.length} word(s) highlighted` +
            (silenceRegions.length ? ` + ${silenceRegions.length} pause(s)` : '') +
            `, review then Execute cuts` +
            (!IS_CLOUD && res.warnings.length ? ` · ${res.warnings.length} warning(s)` : '')
        }
      })
    } catch (e) {
      ;(window as unknown as { __ecError?: (l: string, e: unknown) => void }).__ecError?.('Cut Lord (Ultracut) failed', e)
      set({
        job: {
          active: false,
          percent: 0,
          message: IS_CLOUD ? 'Ultracut couldn’t finish — please try again.' : `Ultracut failed: ${(e as Error).message}`
        }
      })
    }
  },

  runPremiumCut: async () => {
    if (!get().requireServer('Premium Cut')) return
    // Premium Cut (Beta) — a SEPARATE experimental engine (window.api.premiumCut →
    // premium-cut edge fn, Gemini 3.5 Flash multimodal). Gemini LISTENS to the raw
    // audio and returns the transcript + the word cuts itself — no STT. Same
    // review-first contract (highlight + stage, Execute cuts).
    const runPremium = (window.api as { premiumCut?: typeof window.api.retakeAwareCut }).premiumCut
    if (!runPremium) {
      // Premium's judge only exists in the cloud build. Off-cloud (desktop /
      // self-host) fall back to Retake β rather than dead-ending with an error.
      await get().runRetakeCutBeta()
      return
    }
    const stored = get().project
    const p0 = stored.timeline ? documentToProject(stored.timeline, stored) : stored
    const hasBase = !!p0.media || ((p0.baseSequence?.length ?? 0) > 0)
    if (!hasBase) {
      set({ job: { active: false, percent: 0, message: 'Import a video first' } })
      return
    }
    set({ job: { active: true, kind: 'transcribe', percent: 1, message: 'Warming up Premium Cut…' } })
    try {
      let path: string
      if (isMultiBase(p0)) {
        const combined = await window.api.combineClips(p0.baseSequence!, true)
        path = combined.path
      } else {
        path = p0.media!.path
      }
      const res = await runPremium(path)
      const cur = get().project
      // DOC-NATIVE BASE (new UI): persist the folded base so Execute cuts reach the
      // Main lane — identical rationale to runRetakeCutBeta (see the note there).
      const docBase = !cur.media && !!p0.baseSequence?.length
      const nextProject: typeof cur = docBase
        ? { ...cur, media: undefined, baseSequence: p0.baseSequence, transcript: res.transcript }
        : { ...cur, transcript: res.transcript }
      const flagIds = res.deleteWordIds
      // Silence engines are gone from this branch — always empty.
      const silenceRegions = res.silenceRegions ?? []
      set({
        project: nextProject,
        selectedWordIds: new Set(flagIds),
        stagedSilences: silenceRegions,
        stagedSilenceSel: new Set(silenceRegions.map((r) => r.id)),
        retakeSilenceStaged: true
      })
      set({
        cutJobActive: false,
        job: {
          active: false,
          percent: 100,
          message:
            `${res.summary} — ${flagIds.length} word(s) highlighted` +
            (silenceRegions.length ? ` + ${silenceRegions.length} pause(s)` : '') +
            `, review then Execute cuts` +
            (!IS_CLOUD && res.warnings.length ? ` · ${res.warnings.length} warning(s)` : '')
        }
      })
    } catch (e) {
      ;(window as unknown as { __ecError?: (l: string, e: unknown) => void }).__ecError?.('Cut Lord (Premium) failed', e)
      set({
        job: {
          active: false,
          percent: 0,
          message: IS_CLOUD ? 'Premium Cut couldn’t finish — please try again.' : `Premium Cut failed: ${(e as Error).message}`
        }
      })
    }
  },

  _parakeetTranscribe: async () => {
    const p = get().project
    const hasBase = !!p.media || ((p.baseSequence?.length ?? 0) > 0)
    if (!hasBase) {
      set({ job: { active: false, percent: 0, message: 'Import a video first' } })
      return false
    }
    set({ job: { active: true, kind: 'transcribe', percent: 5, message: 'FastCut is transcribing (Parakeet)…' } })
    try {
      let path: string
      if ((p.baseSequence?.length ?? 0) > 0 && !p.media) {
        const combined = await window.api.combineClips(p.baseSequence!, true)
        path = combined.path
      } else {
        path = p.media!.path
      }
      let transcript: Transcript
      try {
        transcript = await window.api.transcribe(path, 'local', 'parakeet')
      } catch {
        set((s) => ({ job: { ...s.job, message: 'Parakeet model missing — using local whisper…' } }))
        transcript = await window.api.transcribe(path, 'local', undefined)
      }
      set((s) => ({ project: { ...s.project, transcript } }))
      return true
    } catch (e) {
      set({ job: { active: false, percent: 0, message: `Transcription failed: ${safeErrMessage(e)}` } })
      return false
    }
  },

  executeCuts: async () => {
    // No silence pass at Execute — every silence engine was removed from this
    // branch. Only word cuts + any (always-empty) staged silences apply.
    const s = get()
    const enabled = s.stagedSilences.filter((r) => s.stagedSilenceSel.has(r.id))
    const hadWords = s.selectedWordIds.size
    if (!hadWords && !enabled.length) {
      set({ job: { active: false, percent: 0, message: 'Nothing staged — run FastCut / ProCut or select words first' } })
      return
    }
    if (hadWords) s.deleteSelected()
    set((st) => ({
      project: {
        ...st.project,
        // Silence Mastery re-runs REPLACE their previous applied regions (sm*
        // ids) instead of stacking on them — each Apply reflects exactly the
        // current settings. Regions from other sources are untouched.
        silences: [
          ...st.project.silences.filter(
            (r) => !(enabled.some((e2) => String(e2.id).startsWith('sm')) && String(r.id).startsWith('sm'))
          ),
          ...enabled
        ].sort((a, b) => a.start - b.start),
        // "trim cuts" from the ⚙ profile becomes the word-splice trim.
        wordCutPad: wordCutPad(st.cutLordSettings),
        // FastCut / ProCut exports get 25ms anti-click fades at every cut seam.
        smoothAudioFadeMs: 25
      },
      stagedSilences: [],
      stagedSilenceSel: new Set<string>(),
      retakeSilenceStaged: false,
      job: {
        active: false,
        percent: 100,
        message: `Executed: ${hadWords} word(s) cut, ${enabled.length} silence(s) cleaned`
      },
      // Cuts are now on the timeline. Kick off the PROACTIVE seam-cache build
      // ("Polishing cuts…"): the preview decodes every new cut's landing frame
      // once while the editor is locked, so the first playback is glitch-free.
      // DocPreview watches polishReq, does the decode, drives the %, and clears
      // it. Desktop WebCodecs only — no-ops (self-clears) elsewhere.
      polishing: { active: true, percent: 0 },
      polishReq: st.polishReq + 1
    }))
    // Debug telemetry (best-effort): what was actually COMMITTED — the applied
    // regions, the project's silence set afterwards, and the resulting keep
    // ranges — so a "cut didn't land" report can be diagnosed from data.
    if (enabled.some((r) => String(r.id).startsWith('sm'))) {
      const r2 = (n: number): number => Math.round(n * 100) / 100
      const after = get().project
      const keeps = computeKeepRanges(after)
      void saveSilenceDebug('apply', {
        applied_regions: enabled.map((r) => [r.id, r2(r.start), r2(r.end)]),
        words_cut: hadWords,
        doc_mode: !!after.timeline,
        project_silences: after.silences.map((r) => [r.id, r2(r.start), r2(r.end), r.action, r.protect ? 1 : 0]),
        keep_ranges: keeps.map((k) => [r2(k.start), r2(k.end)]),
        edited_length_s: r2(keeps.reduce((n, k) => n + (k.end - k.start), 0)),
        source_length_s: r2(after.media?.duration ?? baseTimelineDuration(after))
      })
    }
  },

  selectFastCuts: async () => {
    const t = get().project.transcript
    if (!t) {
      set({ job: { active: false, percent: 0, message: 'Transcribe first to run Fast Cut' } })
      return
    }
    set({ job: { active: true, kind: 'transcribe', percent: 0, message: 'Cut Lord is thinking…' } })
    try {
      // ML tiers are OFF (heuristic-only mode) — don't resolve or upload audio;
      // the acoustic tier is the only consumer and skipping it makes web runs
      // start instantly. Restore this block when re-enabling the tiers.
      const res = await window.api.fastCut(t, undefined, get().project.script || undefined)
      // Union the Python engine with the deterministic repeat finder, then SNAP the
      // whole set to clause boundaries: retakes become whole-take cuts (no broken
      // half-sentences) and the surviving last take is protected from stray flags.
      const ids = new Set(snapRetakeFlags([...res.ids, ...detectRepeatIds(t)], t))
      set({
        selectedWordIds: ids,
        job: {
          active: false,
          percent: 100,
          message: ids.size
            ? `Fast Cut flagged ${ids.size} word(s) — review, then press Delete`
            : 'Fast Cut found nothing to cut'
        }
      })
    } catch (e) {
      set({ job: { active: false, percent: 0, message: (e as Error).message } })
    }
  },

  addOverlayAsset: (libraryItemId) =>
    set((s) => {
      const item = s.library.find((i) => i.id === libraryItemId && i.kind === 'image')
      if (!item) return {}
      const assets = s.project.overlayAssets ?? []
      if (assets.some((a) => a.libraryItemId === libraryItemId)) return {} // already added
      if (assets.length >= 10) return {} // cap: 10 overlays per video
      const id = `overlay_${assets.length + 1}_${uid().slice(0, 4)}`
      const pretty = item.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim()
      const asset: OverlayAsset = { id, libraryItemId, file: item.path, name: pretty || 'Overlay' }
      const rule: OverlayRule = {
        overlayId: id, name: asset.name, instruction: '',
        position: 'top_center', durationSeconds: 3, animation: 'pop', occurrence: 'every'
      }
      return {
        project: {
          ...s.project,
          overlayAssets: [...assets, asset],
          overlayRules: [...(s.project.overlayRules ?? []), rule]
        }
      }
    }),

  updateOverlayRule: (overlayId, patch) =>
    set((s) => ({
      project: {
        ...s.project,
        overlayRules: (s.project.overlayRules ?? []).map((r) =>
          r.overlayId === overlayId ? { ...r, ...patch } : r
        )
      }
    })),

  removeOverlayAsset: (overlayId) => {
    removeGeneratedDocOverlays('Remove overlay', (rid) => rid === overlayId)
    set((s) => ({
      project: {
        ...s.project,
        overlayAssets: (s.project.overlayAssets ?? []).filter((a) => a.id !== overlayId),
        overlayRules: (s.project.overlayRules ?? []).filter((r) => r.overlayId !== overlayId),
        tracks: s.project.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.overlayRuleId !== overlayId) }))
      }
    }))
  },

  clearGeneratedOverlays: () => {
    removeGeneratedDocOverlays('Clear generated overlays', () => true)
    set((s) => ({
      project: {
        ...s.project,
        tracks: s.project.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => !c.overlayRuleId) }))
      }
    }))
  },

  generateOverlays: async () => {
    if (!get().requireServer('Auto overlays')) return
    const { project } = get()
    // The new (doc-native) editor keeps the video as timeline clips — project.media is
    // unset but there IS a unified project.transcript, so overlays work. Only a LEGACY
    // montage WITHOUT a unified transcript needs per-clip editing; block just that.
    if ((project.baseSequence?.length ?? 0) > 0 && !project.media && !project.transcript?.segments?.length) {
      set({ job: { active: false, percent: 0, message: 'Overlays run per clip — double-click a clip on the timeline to edit it (or combine the montage first).' } })
      return
    }
    const t = project.transcript
    if (!t?.segments?.length) {
      set({ job: { active: false, percent: 0, message: 'Transcribe first to place overlays' } })
      return
    }
    const assets = project.overlayAssets ?? []
    const rules = project.overlayRules ?? []
    if (assets.length === 0) {
      set({ job: { active: false, percent: 0, message: 'Add overlay images first' } })
      return
    }
    // Doc-native projects have no project.media — fall back to the base clip's source length.
    const dur = project.media?.duration ?? project.baseSequence?.[0]?.sourceDuration ?? 0
    const cuts = subtractRanges([{ start: 0, end: dur }], computeKeepRanges(project, get().waveform))
    set({ job: { active: true, kind: 'transcribe', percent: 0, message: 'Generating overlays…' } })
    try {
      await get().ensureOverlayDescriptions() // v1.5: cache vision descriptions first
      const freshAssets = get().project.overlayAssets ?? assets
      const res = await window.api.generateOverlays(t, freshAssets, rules, { duration: dur, cuts })
      const events = res.events as OverlayEvent[]
      const log = [...res.log]
      let placed = 0

      const docMode = !!get().project.timeline
      const engine = docMode ? getSharedEngine() : null
      if (docMode && !engine) {
        // Doc-native project but no live engine (timeline unmounted) — writing the
        // legacy tracks would silently place clips nothing renders. Be honest.
        set({ overlayLog: log, job: { active: false, percent: 0, message: 'Timeline is still loading — try Generate again' } })
        return
      }
      if (engine) {
        // DOCUMENT mode (every new project): place events as image clips on the
        // doc's overlay lane, replacing prior generated clips in ONE undoable
        // edit. Events map source→edited frames through the main lane, so they
        // land on the sentence that triggered them even after cuts. The engine
        // write persists to project.timeline via TimelinePanel; preview + export
        // read the same doc lanes, so what's placed is what renders.
        const doc = engine.document
        const { clips: rawClips, skipped } = overlayEventsToDocClips(doc, get().project, events, assets)
        const clips = withOverlaySizes(rawClips, rules)
        const cmds: Command[] = []
        for (const tr of doc.tracks) {
          for (const c of tr.clips) {
            if (typeof c.metadata?.overlayRuleId === 'string') cmds.push(TimelineCommands.removeClip(c.id))
          }
        }
        for (const c of clips) cmds.push(TimelineCommands.addClip(c))
        if (cmds.length) engine.batch('Generate overlays', cmds)
        placed = clips.length
        skipped.forEach((s) => log.push(`skipped: ${s}`))
      } else {
        // LEGACY mode: overlay clips live on project.tracks in SOURCE seconds —
        // the preview gate (OverlayLayer) and the ffmpeg export both composite
        // pre-cut, so ev.start passes through unchanged (collapsing it to edited
        // time here made every overlay land early by the cut footage before it).
        const assetById = new Map(assets.map((a) => [a.id, a]))
        const newClips: Clip[] = []
        for (const ev of events) {
          const asset = assetById.get(ev.overlayId)
          if (!asset) continue
          const len = Math.max(0.5, ev.end - ev.start)
          const box = positionToBox(ev.position)
          newClips.push({
            id: uid(),
            name: asset.name,
            sourcePath: asset.file,
            sourceIn: 0,
            sourceOut: len,
            sourceDuration: len,
            isImage: true,
            start: Math.max(0, ev.start),
            x: box.x,
            y: box.y,
            scale: box.scale,
            crop: { l: 0, t: 0, r: 0, b: 0 },
            zoomStart: 1,
            zoomEnd: 1,
            overlayRuleId: asset.id,
            overlayAnimation: ev.animation,
            overlayReason: ev.reason
          })
        }
        get().clearGeneratedOverlays()
        if (newClips.length) {
          set((s) => ({
            project: {
              ...s.project,
              tracks: s.project.tracks.map((tr) => (tr.index === 1 ? { ...tr, clips: [...tr.clips, ...newClips] } : tr))
            }
          }))
        }
        placed = newClips.length
      }

      log.forEach((l) => console.log('[overlays]', l))
      set({
        overlayLog: log,
        job: {
          active: false,
          percent: 100,
          message: placed ? `Placed ${placed} overlay(s) via ${res.via}` : 'No overlay matches found'
        }
      })
    } catch (e) {
      set({ job: { active: false, percent: 0, message: safeErrMessage(e) } })
    }
  },

  updateOverlayAsset: (overlayId, patch) =>
    set((s) => ({
      project: {
        ...s.project,
        overlayAssets: (s.project.overlayAssets ?? []).map((a) => (a.id === overlayId ? { ...a, ...patch } : a))
      }
    })),

  // Vision pass (v1.5): describe what each overlay image DEPICTS so matching/
  // suggestion keys on the card's content, not just its name. Cached on the asset;
  // only newly-added overlays are analyzed. Best-effort — a failure just leaves the
  // description empty and matching falls back to the name.
  ensureOverlayDescriptions: async () => {
    const assets = get().project.overlayAssets ?? []
    const missing = assets.filter((a) => a.description === undefined)
    if (missing.length === 0) return
    set({ job: { active: true, kind: 'transcribe', percent: 0, message: `Looking at your overlay${missing.length > 1 ? 's' : ''}…` } })
    for (const a of missing) {
      const img = await imageToBase64(a.file)
      if (!img) continue // image bytes not loadable right now (e.g. not yet hydrated) — retry next run, don't cache
      try {
        const r = await window.api.describeOverlayImage(img.base64, img.mediaType)
        // Cache the API's answer — even '' — so a genuinely undescribable image (or a
        // no-key backend) isn't re-analyzed every run. Matching falls back to the name.
        get().updateOverlayAsset(a.id, { description: r.description || '' })
      } catch {
        /* transient API failure — leave undefined so it retries next run */
      }
    }
  },

  // "Suggest": the AI reads the whole transcript + the overlay library and proposes
  // placements into a REVIEW list. Nothing is placed until the creator accepts.
  suggestOverlays: async () => {
    if (!get().requireServer('Suggest overlays')) return
    const { project } = get()
    // Doc-native (new editor): no project.media, but a UNIFIED project.transcript, so
    // Suggest works. Only a legacy montage WITHOUT a unified transcript runs per-clip.
    if ((project.baseSequence?.length ?? 0) > 0 && !project.media && !project.transcript?.segments?.length) {
      set({ job: { active: false, percent: 0, message: 'Suggest runs per clip — double-click a clip on the timeline to edit it.' } })
      return
    }
    const t = project.transcript
    if (!t?.segments?.length) {
      set({ job: { active: false, percent: 0, message: 'Transcribe first so Suggest can read the video' } })
      return
    }
    const assets = project.overlayAssets ?? []
    // Doc-native projects have no project.media — fall back to the base clip's source length.
    const dur = project.media?.duration ?? project.baseSequence?.[0]?.sourceDuration ?? 0
    const cuts = subtractRanges([{ start: 0, end: dur }], computeKeepRanges(project, get().waveform))
    if (assets.length === 0 && !project.media) {
      set({ job: { active: false, percent: 0, message: 'Add overlay images or load a video first' } })
      return
    }
    set({ job: { active: true, kind: 'broll', percent: 0, message: 'Suggesting overlays…' }, overlaySuggestions: [] })
    try {
      const log: string[] = []
      let suggestions: OverlaySuggestion[] = []
      let matchedFromShow = 0

      // 1) CARD suggestions from the overlay library (needs overlay images).
      if (assets.length > 0) {
        await get().ensureOverlayDescriptions() // v1.5: cache vision descriptions first
        const freshAssets = get().project.overlayAssets ?? assets
        const res = await window.api.suggestOverlays(t, freshAssets, { duration: dur, cuts })
        suggestions = [...res.suggestions]
        log.push(...res.log)
      }

      // 2) MOMENT VISION (image-to-image): when the creator SHOWS something on camera
      //    ("this is not acne" over an armpit, then legs, then chest) the WORDS are
      //    identical — only the FRAME differs. We grab the frame and ask the model which
      //    of the creator's OWN overlays depicts what's shown, then place THAT overlay
      //    (never an invented label). Resolve the base video URL robustly — doc-native
      //    projects have NO project.media (mediaUrl is null), so fall back to the
      //    main-lane video source. A frame we can't read (e.g. desktop taint) is skipped.
      let baseUrl = get().mediaUrl
      if (!baseUrl) {
        const p = get().project
        const doc = getSharedEngine()?.document ?? p.timeline
        const mainClip = doc?.tracks.find((tr) => tr.isMain)?.clips.find((c) => c.sourcePath && c.kind === 'video')
        const src = p.media?.path || mainClip?.sourcePath || p.baseSequence?.[0]?.sourcePath
        if (src) baseUrl = mediaSrc(src)
      }
      const libAssets = get().project.overlayAssets ?? assets
      const moments = baseUrl ? findShowMoments(chunkTranscript(t)) : []
      log.push(`moment vision: ${moments.length} show-moment(s)${baseUrl ? '' : ' — no base video, skipped'}`)
      if (baseUrl && moments.length) {
        // Downscaled overlay thumbnails to match against (built once; bounded for cost).
        const thumbs: OverlayThumb[] = []
        for (const a of libAssets) {
          const th = await imageToThumb(a.file, 256)
          if (th) thumbs.push({ id: a.id, name: a.name, image: th.base64, mediaType: th.mediaType })
        }
        if (!thumbs.length) {
          log.push('moment vision: no overlay images to match against — skipped')
        } else {
          set({ job: { active: true, kind: 'transcribe', percent: 45, message: 'Matching what you show to your overlays…' } })
          let si = 0
          for (const m of moments) {
            const span = Math.max(0, m.end - m.start)
            // Sample a FEW frames across the line — the reveal can land early or late, and
            // one snapshot misses it (that's why legs-at-2.4s came back no-match). Matching
            // against several frames catches it wherever in the line it happens.
            const times = span > 0.6
              ? [m.start + span * 0.3, m.start + span * 0.6, m.start + span * 0.85]
              : [m.start + span * 0.5]
            const grabbed = await grabFrames(baseUrl, times)
            if (!grabbed.length) { log.push(`  ${m.start.toFixed(1)}s "${m.text.slice(0, 28)}": couldn't read the frame`); continue }
            const frames = grabbed.map((g) => ({ image: g.base64, mediaType: g.mediaType }))
            let overlayId = ''
            let note = ''
            try {
              const r = await window.api.matchMoment(frames, m.text, thumbs)
              overlayId = r.overlayId || ''
              note = r.note || ''
            } catch (e) {
              log.push(`  matchMoment error: ${(e as Error).message}`)
            }
            const hit = libAssets.find((a) => a.id === overlayId)
            log.push(`  ${m.start.toFixed(1)}s "${m.text.slice(0, 28)}" (${grabbed.length}f)${note ? ` saw: ${note}` : ''} -> ${hit ? `overlay "${hit.name}"` : '(no match)'}`)
            if (!hit) continue
            matchedFromShow++
            suggestions.push({
              id: `mv_${si++}`, kind: 'overlay', overlayId,
              start: m.start, end: Math.min(dur || m.start + 3, m.start + 3),
              position: 'bottom_center', animation: 'pop',
              reason: `You show this on camera while saying “${m.text.slice(0, 48)}”`,
              sentence: m.text.slice(0, 200), confidence: 0.8
            })
          }
          log.push(`moment vision: matched ${matchedFromShow} overlay(s) to what you show`)
        }
      }

      suggestions.sort((a, b) => a.start - b.start)
      log.forEach((l) => console.log('[suggest]', l))
      set({
        overlaySuggestions: suggestions,
        overlayLog: log,
        job: {
          active: false,
          percent: 100,
          message: suggestions.length
            ? `${suggestions.length} suggestion(s)${matchedFromShow ? ` (incl. ${matchedFromShow} matched to what you show)` : ''} — review below`
            : 'No suggestions found'
        }
      })
    } catch (e) {
      set({ job: { active: false, percent: 0, message: safeErrMessage(e) } })
    }
  },

  acceptSuggestions: (ids) => {
    const pending = get().overlaySuggestions
    const accept = ids ? pending.filter((s) => ids.includes(s.id)) : pending
    if (accept.length === 0) return
    const assets = get().project.overlayAssets ?? []
    const cards = accept.filter((s) => s.kind !== 'label')
    const labels = accept.filter((s) => s.kind === 'label')
    // Card suggestions are proposed OverlayEvents — placed exactly like Generate.
    const events: OverlayEvent[] = cards.map((s) => ({
      overlayId: s.overlayId, start: s.start, end: s.end,
      position: s.position, animation: s.animation, reason: s.reason, source: 'llm'
    }))
    const labelInputs = labels.map((s) => ({ start: s.start, end: s.end, label: s.label ?? '', position: s.position }))
    const docMode = !!get().project.timeline
    const engine = docMode ? getSharedEngine() : null
    if (docMode && !engine) {
      set({ job: { active: false, percent: 0, message: 'Timeline is still loading — try again' } })
      return
    }
    let placed = 0
    if (engine) {
      // ADDITIVE: accepted suggestions add to whatever is already placed (unlike
      // Generate, which replaces its own batch), so the creator can accept in steps.
      // Card overlays become image clips; auto-labels become text clips on the text lane.
      const doc = engine.document
      const img = overlayEventsToDocClips(doc, get().project, events, assets)
      const imgClips = withOverlaySizes(img.clips, get().project.overlayRules ?? [])
      const txt = labelSuggestionsToDocTextClips(doc, get().project, labelInputs)
      const allClips = [...imgClips, ...txt.clips]
      if (allClips.length) engine.batch('Accept suggestions', allClips.map((c) => TimelineCommands.addClip(c)))
      placed = allClips.length
      const skipped = [...img.skipped, ...txt.skipped]
      if (skipped.length) console.log('[suggest] skipped:', skipped.join('; '))
    } else {
      const assetById = new Map(assets.map((a) => [a.id, a]))
      const newClips: Clip[] = []
      for (const ev of events) {
        const asset = assetById.get(ev.overlayId)
        if (!asset) continue
        const len = Math.max(0.5, ev.end - ev.start)
        const box = positionToBox(ev.position)
        newClips.push({
          id: uid(), name: asset.name, sourcePath: asset.file, sourceIn: 0, sourceOut: len, sourceDuration: len,
          isImage: true, start: Math.max(0, ev.start), x: box.x, y: box.y, scale: box.scale,
          crop: { l: 0, t: 0, r: 0, b: 0 }, zoomStart: 1, zoomEnd: 1,
          overlayRuleId: asset.id, overlayAnimation: ev.animation, overlayReason: ev.reason
        })
      }
      // Legacy mode: auto-labels become project.texts (the legacy preview reads these).
      const newTexts: TextClip[] = labels.map((s) => ({
        id: uid(), text: s.label ?? '', start: Math.max(0, s.start), end: Math.max(0, s.end),
        x: 0.5, y: s.position.startsWith('top') ? 0.14 : 0.86,
        fontFamily: 'Arial Black', fontSize: 0.07, color: '#ffffff', align: 'center',
        bold: true, italic: false, strokeWidth: 0.08, strokeColor: '#000000',
        bgEnabled: false, bgColor: '#000000', bgRadius: 0.3, bgPadding: 0.3, bgOpacity: 0.6
      }))
      set((s) => ({
        project: {
          ...s.project,
          tracks: newClips.length ? s.project.tracks.map((tr) => (tr.index === 1 ? { ...tr, clips: [...tr.clips, ...newClips] } : tr)) : s.project.tracks,
          texts: newTexts.length ? [...(s.project.texts ?? []), ...newTexts] : s.project.texts
        }
      }))
      placed = newClips.length + newTexts.length
    }
    const acceptedIds = new Set(accept.map((s) => s.id))
    set((s) => ({
      overlaySuggestions: s.overlaySuggestions.filter((x) => !acceptedIds.has(x.id)),
      job: { active: false, percent: 100, message: `Placed ${placed} item(s)` }
    }))
  },

  dismissSuggestion: (id) =>
    set((s) => ({ overlaySuggestions: s.overlaySuggestions.filter((x) => x.id !== id) })),

  clearSuggestions: () => set({ overlaySuggestions: [] }),

  deleteSelected: () => {
    const { selectedWordIds } = get()
    if (selectedWordIds.size === 0) return
    set((s) => ({
      project: {
        ...s.project,
        transcript: s.project.transcript
          ? {
              ...s.project.transcript,
              words: s.project.transcript.words.map((w) =>
                selectedWordIds.has(w.id) ? { ...w, deleted: true } : w
              ),
              segments: s.project.transcript.segments.map((seg) => ({
                ...seg,
                words: seg.words.map((w) =>
                  selectedWordIds.has(w.id) ? { ...w, deleted: true } : w
                )
              }))
            }
          : undefined
      },
      selectedWordIds: new Set()
    }))
  },

  restoreSelected: () => {
    const { selectedWordIds } = get()
    if (selectedWordIds.size === 0) return
    set((s) => ({
      project: {
        ...s.project,
        transcript: s.project.transcript
          ? {
              ...s.project.transcript,
              words: s.project.transcript.words.map((w) =>
                selectedWordIds.has(w.id) ? { ...w, deleted: false } : w
              ),
              segments: s.project.transcript.segments.map((seg) => ({
                ...seg,
                words: seg.words.map((w) =>
                  selectedWordIds.has(w.id) ? { ...w, deleted: false } : w
                )
              }))
            }
          : undefined
      }
    }))
  },

  toggleWordDeleted: (id) =>
    set((s) => ({
      project: {
        ...s.project,
        transcript: s.project.transcript
          ? {
              ...s.project.transcript,
              words: s.project.transcript.words.map((w) =>
                w.id === id ? { ...w, deleted: !w.deleted } : w
              ),
              segments: s.project.transcript.segments.map((seg) => ({
                ...seg,
                words: seg.words.map((w) => (w.id === id ? { ...w, deleted: !w.deleted } : w))
              }))
            }
          : undefined
      }
    })),

  setPlayhead: (t) => set((s) => ({ project: { ...s.project, playhead: Math.max(0, t) } })),
  setPlaying: (p) => set({ playing: p }),
  setScrubbing: (b) => set({ scrubbing: b }),
  setZoom: (px) => set((s) => ({ project: { ...s.project, pxPerSec: Math.min(400, Math.max(10, px)) } })),
  setTrackHeight: (h) =>
    set((s) => ({ project: { ...s.project, trackHeight: Math.min(220, Math.max(48, Math.round(h))) } })),
  toggleMagnet: () => set((s) => ({ project: { ...s.project, magnet: !s.project.magnet } })),
  toggleThumbnails: () =>
    set((s) => ({ project: { ...s.project, showThumbnails: !s.project.showThumbnails } })),
  setAspect: (w, h) => set((s) => ({ project: { ...s.project, aspectW: w, aspectH: h } })),
  setScript: (script) => set((s) => ({ project: { ...s.project, script } })),

  addClipFromSource: (trackIndex, sourceIn, sourceOut, start, name) =>
    set((s) => ({
      project: {
        ...s.project,
        tracks: s.project.tracks.map((t) =>
          t.index === trackIndex
            ? {
                ...t,
                clips: [
                  ...t.clips,
                  {
                    id: uid(),
                    name,
                    sourcePath: s.project.media?.path ?? '',
                    sourceIn,
                    sourceOut,
                    sourceDuration: s.project.media?.duration,
                    srcW: s.project.media?.width,
                    srcH: s.project.media?.height,
                    start: Math.max(0, start),
                    x: 0.28,
                    y: 0.28,
                    scale: 0.45,
                    crop: { l: 0, t: 0, r: 0, b: 0 },
                    zoomStart: 1,
                    zoomEnd: 1
                  }
                ]
              }
            : t
        )
      }
    })),

  addBrollToTrack: async (trackIndex) => {
    const path = await window.api.openMediaDialog()
    if (!path) return
    const isImage = /\.(png|jpe?g|webp|gif|bmp)$/i.test(path)
    const info = await window.api.probe(path).catch(() => null)
    const { project } = get()
    const dur = isImage ? 5 : info?.duration || 5
    const clip: Clip = {
      id: uid(),
      name: mediaDisplayName(path),
      sourcePath: path,
      sourceIn: 0,
      sourceOut: dur,
      sourceDuration: isImage ? 3600 : info?.duration || dur,
      isImage,
      srcW: info?.width || 1920,
      srcH: info?.height || 1080,
      start: project.playhead,
      x: 0.28,
      y: 0.28,
      scale: 0.45,
      crop: { l: 0, t: 0, r: 0, b: 0 },
      zoomStart: 1,
      zoomEnd: 1
    }
    set((s) => ({
      project: {
        ...s.project,
        tracks: s.project.tracks.map((t) =>
          t.index === trackIndex ? { ...t, clips: [...t.clips, clip] } : t
        )
      }
    }))
  },

  moveClip: (clipId, newStart) =>
    set((s) => ({
      project: {
        ...s.project,
        tracks: s.project.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) => (c.id === clipId ? { ...c, start: Math.max(0, newStart) } : c))
        }))
      }
    })),

  updateClip: (clipId, patch) =>
    set((s) => ({
      project: {
        ...s.project,
        tracks: s.project.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c))
        }))
      }
    })),

  setTimelineDoc: (doc) => set((s) => ({ project: { ...s.project, timeline: doc } })),

  splitAtPlayhead: (trackIndex) => {
    const s = get()
    const p = s.project.playhead
    let didSplit = false
    const tracks = s.project.tracks.map((t) => {
      if (trackIndex != null && t.index !== trackIndex) return t
      const clips: Clip[] = []
      for (const c of t.clips) {
        const len = c.sourceOut - c.sourceIn
        const end = c.start + len
        if (p > c.start + 0.02 && p < end - 0.02) {
          const offset = p - c.start
          clips.push({ ...c, sourceOut: c.sourceIn + offset })
          clips.push({ ...c, id: uid(), sourceIn: c.sourceIn + offset, start: p })
          didSplit = true
        } else {
          clips.push(c)
        }
      }
      return { ...t, clips }
    })
    if (didSplit) set({ project: { ...s.project, tracks } })
    return didSplit
  },

  removeClip: (clipId) =>
    set((s) => ({
      project: {
        ...s.project,
        tracks: s.project.tracks.map((t) => ({
          ...t,
          clips: t.clips.filter((c) => c.id !== clipId)
        }))
      }
    })),

  splitBaseAtPlayhead: () => {
    const s = get()
    const p = s.project.playhead
    const dur = s.project.media?.duration ?? 0
    if (p <= 0.05 || p >= dur - 0.05) return false
    if (s.project.baseSplits.some((x) => Math.abs(x - p) < 0.03)) return false
    set({
      project: {
        ...s.project,
        baseSplits: [...s.project.baseSplits, p].sort((a, b) => a - b)
      }
    })
    return true
  },

  splitSequenceAtPlayhead: () => {
    const s = get()
    if (!isMultiBase(s.project)) return false
    const hit = virtualToClip(s.project, s.project.playhead)
    if (!hit) return false
    const { clip, sourceTime } = hit
    // Must land INSIDE the clip (not on either edge) to make two real pieces.
    if (sourceTime <= clip.sourceIn + 0.15 || sourceTime >= clip.sourceOut - 0.15) return false
    const seq = [...(s.project.baseSequence ?? [])]
    const idx = seq.findIndex((c) => c.id === clip.id)
    if (idx < 0) return false
    const left = { ...clip, sourceOut: sourceTime }
    const right = { ...clip, id: uid(), sourceIn: sourceTime, laneStart: undefined }
    seq.splice(idx, 1, left, right)
    set({ project: { ...s.project, baseSequence: seq }, selectedSeqClipId: null })
    return true
  },

  selectSeqClip: (id) =>
    set(id
      ? { selectedSeqClipId: id, selectedClipId: null, selectedSeg: null, selectedTextId: null }
      : { selectedSeqClipId: null }),

  deleteBaseRange: (start, end, final) =>
    set((s) => ({
      project: {
        ...s.project,
        manualCuts: [...s.project.manualCuts, { start, end, final: final || undefined }],
        // Re-deleting a RESTORED region: drop the force-keep override there, or it
        // would win over the cut and the delete would be silently ignored.
        keepOverrides: subtractRanges(s.project.keepOverrides ?? [], [{ start, end }])
      }
    })),

  // Ripple-remove EVERY currently-greyed cut at once (the "delete all cuts"
  // button): add a `final` manualCut over each cut gap so they all collapse.
  deleteAllCuts: () =>
    set((s) => {
      const dur = s.project.media?.duration ?? 0
      if (dur <= 0) return {}
      const keeps = computeKeepRanges(s.project, s.waveform)
      const cuts: { start: number; end: number; final?: boolean }[] = []
      let cursor = 0
      for (const k of keeps) {
        if (k.start > cursor + 0.02) cuts.push({ start: cursor, end: k.start, final: true })
        cursor = Math.max(cursor, k.end)
      }
      if (cursor < dur - 0.02) cuts.push({ start: cursor, end: dur, final: true })
      if (!cuts.length) return {}
      return { project: { ...s.project, manualCuts: [...s.project.manualCuts, ...cuts] }, selectedSeg: null }
    }),

  setBaseManualCut: (regionStart, regionEnd, cut) =>
    set((s) => {
      const eps = 0.05
      // Drop any manual cut that lies within this region, then add the new one.
      const kept = s.project.manualCuts.filter(
        (c) => c.end <= regionStart + eps || c.start >= regionEnd - eps
      )
      const next = cut && cut.end - cut.start > 0.03 ? [...kept, cut] : kept
      return { project: { ...s.project, manualCuts: next } }
    }),

  setBaseKeepOverride: (regionStart, regionEnd, ov) =>
    set((s) => {
      const eps = 0.05
      const kept = (s.project.keepOverrides ?? []).filter(
        (c) => c.end <= regionStart + eps || c.start >= regionEnd - eps
      )
      const next = ov && ov.end - ov.start > 0.03 ? [...kept, ov] : kept
      return { project: { ...s.project, keepOverrides: next } }
    }),

  clearBaseEdits: () =>
    set((s) => ({
      project: { ...s.project, baseSplits: [], manualCuts: [], keepOverrides: [] }
    })),

  selectClip: (id) =>
    set(id
      ? { selectedClipId: id, selectedSeg: null, selectedTextId: null, toolsTab: 'basic' }
      : { selectedClipId: id, selectedSeg: null }),
  selectSeg: (seg) =>
    set(seg
      ? { selectedSeg: seg, selectedClipId: null, selectedTextId: null, toolsTab: 'basic' }
      : { selectedSeg: seg, selectedClipId: null }),
  setToolsTab: (t) => set({ toolsTab: t }),

  addText: () => {
    const s = get()
    const dur = s.project.media?.duration ?? 0
    const start = s.project.playhead
    const text: TextClip = {
      id: uid(),
      text: 'Your text',
      start,
      end: Math.min(dur || start + 3, start + 3),
      x: 0.5,
      y: 0.8,
      fontFamily: 'Arial Black',
      fontSize: 0.08,
      color: '#ffffff',
      align: 'center',
      bold: true,
      italic: false,
      strokeWidth: 0.06,
      strokeColor: '#000000',
      bgEnabled: false,
      bgColor: '#000000',
      bgRadius: 0.3,
      bgPadding: 0.3,
      bgOpacity: 0.6
    }
    set({
      project: { ...s.project, texts: [...(s.project.texts ?? []), text] },
      selectedTextId: text.id,
      selectedClipId: null,
      selectedSeg: null,
      toolsTab: 'text'
    })
  },

  generateCaptions: async (styleId?: string) => {
    // Prefer the transcript we already have (Cut Lord / Transcribe leaves it on
    // project.transcript). If there is none, transcribe first — this sends the
    // audio to AssemblyAI ONCE (the result is cached, so a later Cut Lord reuses
    // it, and vice-versa). Doc-native bases (a clip dragged onto the timeline) are
    // folded + persisted exactly like runRetakeCutBeta so captions work there too.
    let words = (get().project.transcript?.words ?? []).filter((w) => !w.deleted && w.text.trim())
    if (!words.length) {
      if (!get().requireServer('Captions')) return
      const stored = get().project
      const p0 = stored.timeline ? documentToProject(stored.timeline, stored) : stored
      const hasBase = !!p0.media || ((p0.baseSequence?.length ?? 0) > 0)
      if (!hasBase) {
        set({ job: { active: false, percent: 0, message: 'Import a video first, then generate captions.' } })
        return
      }
      set({ job: { active: true, kind: 'transcribe', percent: 3, message: 'Getting your transcript…' } })
      try {
        const { transcribeBackend, openaiAvailable, whisperModel } = get()
        const backend: TranscribeBackend = transcribeBackend === 'openai' && openaiAvailable ? 'openai' : 'local'
        let path: string
        if (isMultiBase(p0)) {
          const combined = await window.api.combineClips(p0.baseSequence!, true)
          path = combined.path
        } else {
          path = p0.media!.path
        }
        const transcript: Transcript = await window.api.transcribe(path, backend, backend === 'local' ? whisperModel || undefined : undefined)
        // Captions only need the transcript — they place text clips, they do NOT
        // cut, so (unlike runRetakeCutBeta) we must NOT rewrite media/baseSequence
        // here; doing so desynced the project from the doc and could disturb the
        // doc-native preview. Just store the transcript.
        set((s) => ({ project: { ...s.project, transcript } }))
        words = transcript.words.filter((w) => !w.deleted && w.text.trim())
      } catch (e) {
        ;(window as unknown as { __ecError?: (l: string, e: unknown) => void }).__ecError?.('Captions transcription failed', e)
        set({ job: { active: false, percent: 0, message: IS_CLOUD ? 'Couldn’t get a transcript — please try again.' : `Transcription failed: ${(e as Error).message}` } })
        return
      }
    }
    if (!words.length) {
      set({ job: { active: false, percent: 0, message: 'Nothing to caption.' } })
      return
    }
    // Group words into short caption lines: break on sentence-ending punctuation,
    // or when a line reaches ~6 words / ~2.8s.
    const MAX_WORDS = 6
    const MAX_DUR = 2.8
    const lines: { text: string; start: number; end: number }[] = []
    let cur: typeof words = []
    const flush = (): void => {
      if (!cur.length) return
      const text = cur.map((w) => w.text.trim()).join(' ').replace(/\s+([,.!?;:])/g, '$1').trim()
      if (text) lines.push({ text, start: cur[0].start, end: cur[cur.length - 1].end })
      cur = []
    }
    for (const w of words) {
      cur.push(w)
      if (cur.length >= MAX_WORDS || w.end - cur[0].start >= MAX_DUR || /[.!?]$/.test(w.text.trim())) flush()
    }
    flush()
    if (!lines.length) {
      set({ job: { active: false, percent: 0, message: 'Nothing to caption.' } })
      return
    }
    // Text lives as clips on the timeline DOCUMENT in the new UI (project.texts
    // only render in the legacy preview), so emit doc text clips. Words carry
    // SOURCE time; the playhead + doc run in EDITED time, so map through the main
    // lane (a no-op with no cuts).
    const doc = getSharedEngine()?.document
    if (!doc) {
      set({ job: { active: false, percent: 0, message: 'Open a project timeline first, then generate captions.' } })
      return
    }
    removeCaptionTexts() // replace any prior batch
    const specs = lines.map((ln) => {
      const startS = docSourceToEdited(doc, ln.start)
      return {
        text: ln.text,
        startS,
        endS: Math.max(startS + 0.3, docSourceToEdited(doc, ln.end)),
        x: 0.5,
        y: 0.85,
        caption: true,
        content: captionStyleContent(styleId) /* Clean (outline) or Boxed (bar); size ~7 on the editor scale */
      }
    })
    addDocTexts(specs)
    set({ job: { active: false, percent: 100, message: `Added ${specs.length} caption line(s) — tweak them in the Edit tab.` } })
  },

  clearCaptions: () => {
    removeCaptionTexts()
  },

  updateText: (id, patch) =>
    set((s) => ({
      project: { ...s.project, texts: (s.project.texts ?? []).map((t) => (t.id === id ? { ...t, ...patch } : t)) }
    })),

  removeText: (id) =>
    set((s) => ({
      project: { ...s.project, texts: (s.project.texts ?? []).filter((t) => t.id !== id) },
      selectedTextId: null
    })),

  selectText: (id) =>
    set(id
      ? { selectedTextId: id, selectedClipId: null, selectedSeg: null, toolsTab: 'text' }
      : { selectedTextId: id }),

  moveText: (id, start) =>
    set((s) => ({
      project: {
        ...s.project,
        texts: (s.project.texts ?? []).map((t) =>
          t.id === id ? { ...t, end: t.end - t.start + Math.max(0, start), start: Math.max(0, start) } : t
        )
      }
    })),

  splitTextAtPlayhead: () => {
    const s = get()
    const id = s.selectedTextId
    if (!id) return false
    const p = s.project.playhead
    const t = (s.project.texts ?? []).find((x) => x.id === id)
    if (!t || !(p > t.start + 0.05 && p < t.end - 0.05)) return false
    const right: TextClip = { ...t, id: uid(), start: p }
    set({
      project: {
        ...s.project,
        texts: (s.project.texts ?? []).flatMap((x) => (x.id === id ? [{ ...x, end: p }, right] : [x]))
      },
      selectedTextId: right.id
    })
    return true
  },

  hotkeySplit: () => {
    const s = get()
    // Prefer the selected element: text first, then overlay clips, then base.
    const ok = s.splitTextAtPlayhead() || s.splitAtPlayhead() || s.splitBaseAtPlayhead() || s.splitSequenceAtPlayhead()
    if (!ok)
      set({ job: { active: false, percent: 0, message: 'Move the playhead inside a clip/text/base segment to split' } })
  },

  hotkeyDelete: () => {
    const s = get()
    if (s.selectedWordIds.size > 0) {
      s.deleteSelected()
      return
    }
    if (s.selectedTextId) {
      s.removeText(s.selectedTextId)
      return
    }
    if (s.selectedClipId) {
      s.removeClip(s.selectedClipId)
      set({ selectedClipId: null })
      return
    }
    if (s.selectedSeqClipId) {
      s.removeSequenceClip(s.selectedSeqClipId)
      set({ selectedSeqClipId: null })
      return
    }
    if (s.selectedSeg) {
      // One delete: ripple-remove the selected base segment (kept or already-cut).
      s.deleteBaseRange(s.selectedSeg.start, s.selectedSeg.end, true)
      set({ selectedSeg: null })
    }
  },

  hotkeyUndelete: () => {
    const s = get()
    // Restore deleted transcript words…
    if (s.selectedWordIds.size > 0) {
      s.restoreSelected()
      return
    }
    // …or bring back a selected CUT base segment (force-keep over the cut).
    if (s.selectedSeg && s.selectedSeg.kind === 'cut') {
      s.setBaseKeepOverride(s.selectedSeg.start, s.selectedSeg.end, {
        start: s.selectedSeg.start,
        end: s.selectedSeg.end
      })
      set({ selectedSeg: null })
    }
  },

  hotkeyPlayPause: () => {
    if (get().mediaUrl || (get().project.baseSequence?.length ?? 0) > 0) set((s) => ({ playing: !s.playing }))
  },

  setKeybind: (action, key) =>
    set((s) => {
      const keybinds = { ...s.keybinds, [action]: key }
      try {
        localStorage.setItem('ec.keybinds', JSON.stringify(keybinds))
      } catch {
        /* ignore */
      }
      return { keybinds }
    }),

  setFillerWords: (list) => {
    const clean = list.map((s) => s.trim().toLowerCase()).filter(Boolean)
    const deduped = [...new Set(clean)]
    try {
      localStorage.setItem('ec.fillers', JSON.stringify(deduped))
    } catch {
      /* ignore */
    }
    set({ fillerWords: deduped })
  },

  setShowSettings: (b) => set({ showSettings: b }),
  setShowCropModal: (b) => set({ showCropModal: b }),

  undo: () => {
    flushHistory()
    const st = get()
    if (st.past.length === 0) return
    const target = st.past[st.past.length - 1]
    history.applying = true
    set({
      project: withView(target, st.project),
      past: st.past.slice(0, -1),
      future: [st.project, ...st.future].slice(0, 60),
      canUndo: st.past.length - 1 > 0,
      canRedo: true,
      selectedClipId: null,
      selectedSeg: null,
      selectedWordIds: new Set()
    })
    history.applying = false
  },

  redo: () => {
    const st = get()
    if (st.future.length === 0) return
    const target = st.future[0]
    history.applying = true
    set({
      project: withView(target, st.project),
      future: st.future.slice(1),
      past: [...st.past, st.project].slice(-60),
      canUndo: true,
      canRedo: st.future.length - 1 > 0,
      selectedClipId: null,
      selectedSeg: null,
      selectedWordIds: new Set()
    })
    history.applying = false
  },

  exportVideoOnDevice: async (settings) => {
    // Re-entrancy guard: an export already running must not be started again — a
    // second concurrent run is what made the progress bar appear to restart
    // (0→52%→0→70%…) as two passes fought over the same worker/decoders.
    const jb = get().job
    if (jb.active && jb.kind === 'export') return
    set({ showExportModal: false, job: { active: true, kind: 'export', percent: 1, message: 'Getting ready to export…' } })
    const chosenName = (settings.filename ?? '').replace(/[\\/:*?"<>|]+/g, '_').replace(/\.[^.]+$/, '').trim()
    try {
      // Android: NATIVE-ONLY export. Media3 encodes the whole edit with the phone's
      // hardware codecs — base video (trim+concat, audio kept), captions composited,
      // extra audio tracks mixed — and saves to the gallery. No WebCodecs fallback.
      if (hasNativeExport()) {
        const out = await nativeExportFull(
          get().project,
          { width: settings.width, height: settings.height, bitrateMbps: settings.bitrateMbps },
          chosenName ? `${chosenName}.mp4` : `EaseCutPro_${Date.now()}.mp4`,
          (percent, message) => set({ job: { active: true, kind: 'export', percent, message } })
        )
        set({
          job: { active: false, kind: 'export', percent: 100, message: out.savedTo ? `Saved to ${out.savedTo}` : 'Saved to your device' }
        })
        return
      }
      // Web / desktop: on-device WebCodecs export (unchanged).
      const { blob, name } = await exportOnDevice(
        get().project,
        { width: settings.width, height: settings.height, bitrateMbps: settings.bitrateMbps },
        (percent, message) => set({ job: { active: true, kind: 'export', percent, message } })
      )
      // Creator-chosen file name wins (sanitized, single .mp4); else the derived one.
      const dl = chosenName ? `${chosenName}.mp4` : name
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = dl
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 8000)
      set({ job: { active: false, percent: 100, message: `Saved ${dl} to this device` } })
    } catch (e) {
      set({
        job: { active: false, kind: 'export', percent: 0, message: `Export failed: ${safeErrMessage(e)}` }
      })
    }
  },

  exportVideo: async (settings) => {
    const stored = get().project
    // In document mode the timeline IS the edit — fold it into the legacy montage
    // shape (base sequence + overlays + texts) so the export matches the preview.
    const project = stored.timeline ? documentToProject(stored.timeline, stored) : stored
    if (!project.media && !(project.baseSequence && project.baseSequence.length)) return
    const W = project.media?.width || project.baseSequence?.[0]?.srcW || 1920
    const H = project.media?.height || project.baseSequence?.[0]?.srcH || 1080
    // Bake each text overlay to a full-frame PNG at base resolution.
    const textOverlays = (project.texts ?? [])
      .filter((t) => t.end - t.start > 0.05 && t.text.trim())
      .map((t) => ({ png: renderTextPng(t, W, H), start: t.start, end: t.end }))
    set({ showExportModal: false, job: { active: true, kind: 'export', percent: 0, message: 'Exporting' } })
    try {
      const out = await window.api.exportProject(project, settings, textOverlays)
      set({ job: { active: false, percent: 100, message: out ? `Exported: ${out}` : 'Export canceled' } })
    } catch (e) {
      set({ job: { active: false, percent: 0, message: `Export failed: ${safeErrMessage(e)}` } })
    }
  },

  setShowExportModal: (b) => set({ showExportModal: b }),

  save: async () => {
    const { project, currentProjectId } = get()
    // Web: explicit Save = push EVERYTHING (media included) to the PC — the
    // durable, open-anywhere copy. Autosave only ever sends the small JSON.
    if (IS_WEB && currentProjectId) {
      set({ job: { active: true, kind: 'export', percent: 0, message: 'Saving to PC — uploading media…' } })
      try {
        const serialized = await serializeProject(project)
        await saveProject(currentProjectId, { project: serialized, name: project.name })
        set({ job: { active: false, percent: 100, message: 'Project + media saved to the PC' } })
      } catch (e) {
        set({ job: { active: false, percent: 0, message: `Save failed: ${safeErrMessage(e)}` } })
      }
      return
    }
    const p = await window.api.saveProject(project)
    if (p) set({ job: { active: false, percent: 100, message: `Saved: ${p}` } })
  },

  load: async () => {
    const project = await window.api.loadProject()
    if (!project) return
    const url = project.media ? mediaUrl(project.media.path) : null
    set({ project, mediaUrl: url, waveform: null, musicWaveform: null, thumbnails: [], selectedWordIds: new Set() })
    if (project.media) {
      const p = project.media.path
      window.api.waveform(p).then((wf) => set({ waveform: wf })).catch(() => undefined)
      if (project.media.hasVideo) {
        window.api.thumbnails(p).then((t) => set({ thumbnails: t })).catch(() => undefined)
      }
    }
    if (project.music?.path) {
      window.api.waveform(project.music.path).then((wf) => set({ musicWaveform: wf })).catch(() => undefined)
    }
  },

  // ---- App shell / accounts / projects ----
  setView: (view) => set({ view }),
  setUser: (user) => set({ user }),
  setSaveState: (saveState) => set({ saveState }),
  renameCurrentProject: (name) =>
    set((s) => ({ project: { ...s.project, name }, currentProjectName: name })),
  freshProject: () => newProject(),

  goHome: () => set({ view: 'home', coworkSession: null, selectedClipId: null, selectedSeg: null, selectedTextId: null, selectedWordIds: new Set() }),

  openProjectRecord: (rec, extra) => {
    const project = rec.project ?? newProject()
    const open = (): void => set({
      project,
      currentProjectId: rec.id,
      coworkSession: null,
      currentProjectName: rec.name,
      saveState: 'idle',
      view: 'editor',
      ...extra,
      mediaUrl: project.media ? mediaUrl(project.media.path) : null,
      waveform: null,
      musicWaveform: null,
      thumbnails: [],
      // Media library reflects THIS project's own sources (a fresh project shows
      // none) — no leftovers from the previously-open project.
      library: libraryFromProject(project),
      selectedWordIds: new Set(),
      selectedClipId: null,
      selectedSeg: null,
      selectedTextId: null,
      past: [],
      future: [],
      canUndo: false,
      canRedo: false
    })
    const kickBackground = (): void => {
      if (project.media?.path) {
        const p = project.media.path
        window.api.waveform(p).then((wf) => set({ waveform: wf })).catch(() => undefined)
        if (project.media.hasVideo) window.api.thumbnails(p).then((t) => set({ thumbnails: t })).catch(() => undefined)
      }
      if (project.music?.path) {
        window.api.waveform(project.music.path).then((wf) => set({ musicWaveform: wf })).catch(() => undefined)
      }
    }
    if (IS_WEB) {
      // Restore this device's local media (IndexedDB) for the project's
      // webmedia ids BEFORE the editor renders — autosave no longer uploads
      // videos to the PC, so this is what makes a reopened project play.
      set({ view: 'loading' })
      void hydrateProjectMedia(project)
        .catch(() => undefined)
        .then(() => {
          open()
          kickBackground()
        })
    } else {
      open()
      kickBackground()
    }
  },

  openCoworkProject: async (cp, editUserId, onStep) => {
    // Per-file download progress lands in the dashboard transfer dock.
    const project = await openSpaceProject(cp, editUserId ?? null, onStep, makeXferReporter())
    // Enter the editor as a cowork session: currentProjectId stays null (so the
    // local-projects autosave never fires for it) and coworkSession routes edits
    // to R2 instead. openProjectRecord hydrates media + mounts the editor.
    get().openProjectRecord(
      { id: cp.id, name: cp.name, project },
      { currentProjectId: null, coworkSession: { spaceId: cp.space_id, project: cp, editUserId: editUserId ?? null } }
    )
  },

  saveCoworkEdit: async () => {
    const { coworkSession, project } = get()
    if (!coworkSession) return
    await saveMyEdit(coworkSession.project, project)
  },

  coworkXferStart: (name, kind) => {
    const id = `xf_${Date.now()}_${Math.round(Math.random() * 1e6)}`
    set((s) => ({
      coworkTransfers: [
        { id, name, kind, step: kind === 'upload' ? 'Preparing…' : 'Starting…', pct: 0, status: 'active' as const },
        ...s.coworkTransfers
      ].slice(0, 24)
    }))
    return id
  },
  coworkXferPatch: (id, patch) =>
    set((s) => ({ coworkTransfers: s.coworkTransfers.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
  coworkXferEnd: (id, error) =>
    set((s) => ({
      coworkTransfers: s.coworkTransfers.map((t) =>
        t.id === id
          ? { ...t, status: error ? ('error' as const) : ('done' as const), step: error || 'Complete', pct: error ? t.pct : 100 }
          : t
      )
    })),
  dismissCoworkXfers: () => set((s) => ({ coworkTransfers: s.coworkTransfers.filter((t) => t.status === 'active') })),

  runBatchClean: async (items) => {
    if (!items.length) return
    // 1) Create a project record per file up front so cards appear immediately.
    const created: { id: string; item: { path: string; name: string } }[] = []
    for (const it of items) {
      const base = newProject()
      base.name = it.name.replace(/\.[^.]+$/, '')
      const rec = await createProject(base.name, base)
      created.push({ id: rec.id, item: it })
    }
    const jobs: BatchJob[] = created.map((c) => ({
      projectId: c.id,
      name: c.item.name,
      status: 'queued',
      step: 'Queued'
    }))
    set((s) => ({ batchJobs: [...jobs, ...s.batchJobs] }))

    const update = (id: string, patch: Partial<BatchJob>): void =>
      set((s) => ({ batchJobs: s.batchJobs.map((j) => (j.projectId === id ? { ...j, ...patch } : j)) }))

    // 2) Process sequentially — transcription is heavy GPU/CPU work.
    for (const c of created) {
      update(c.id, { status: 'processing', step: 'Starting…' })
      try {
        // Cloud batch: the same browser-side Cut Lord the editor's Retake uses
        // (transcribe → LLM retake via /edge), NOT window.api's /api/*
        // endpoints — those 405 in the Vercel deploy (static-only host).
        const { project, thumb } = await cleanVideoCloud(
          c.item.path,
          c.item.name,
          (step) => update(c.id, { step })
        )
        // Persist like the editor's autosave: serializeProjectLite keeps the
        // browser-local webmedia ids (blobs live in IndexedDB, reopenable on this
        // device) and NEVER calls the PC-server upload (/api/upload-init), which
        // 405s on the static cloud host. The full serializeProject uploads media
        // to that server — it's what made the batch fail even after Cut Lord ran.
        const finalProject = serializeProjectLite(project)
        await saveProject(c.id, { project: finalProject, thumb })
        update(c.id, { status: 'done', step: 'Cleaned' })
      } catch (e) {
        update(c.id, { status: 'error', step: 'Failed', error: (e as Error).message })
      }
    }
  },

  dismissBatchJobs: () => set({ batchJobs: [] }),

  clearPendingCaptions: () => set({ pendingCaptions: false }),

  clearPendingAutoZoom: () => set({ pendingAutoZoom: false }),

  runAutoZoom: async () => {
    if (get().autoZoomBusy) return
    if (!getSharedEngine()?.document) {
      set({ job: { active: false, percent: 0, message: 'Open a project timeline first, then Auto Zoom.' } })
      return
    }
    // Kept words in SOURCE time (deleted / empty filtered out) — same set captions use.
    const words = (get().project.transcript?.words ?? [])
      .filter((w) => !w.deleted && w.text.trim())
      .map((w) => ({ start: w.start, end: w.end, text: w.text }))
    // Keep job.active FALSE so the AI Cut panel stays in its executed review while
    // this runs (the button's own spinner shows progress via autoZoomBusy).
    set({ autoZoomBusy: true })
    try {
      const { planAndApplyZooms } = await import('./cloud/autoZoom')
      const r = await planAndApplyZooms(words)
      set({ autoZoomBusy: false, job: { active: false, percent: 100, message: r.message } })
    } catch (e) {
      set({ autoZoomBusy: false, job: { active: false, percent: 0, message: `Auto Zoom failed: ${(e as Error).message}` } })
    }
  },

  startImportWizard: async (files, opts) => {
    if (!files.length) return
    set({ wizardJob: { active: true, label: 'Preparing…', base: 0, span: 0 } })
    // 1) Probe every picked file into a library item; keep videos/images for the base.
    const items: LibraryItem[] = []
    for (const f of files) {
      try {
        items.push(await buildLibraryItem(f.path, f.name))
      } catch {
        /* skip an unreadable file rather than aborting the whole import */
      }
    }
    const bases = items.filter((it) => it.kind === 'video' || it.kind === 'image')
    if (!bases.length) {
      set({ wizardJob: null, job: { active: false, percent: 0, message: 'No importable video was selected.' } })
      return
    }
    const first = bases[0]
    const name = first.name.replace(/\.[^.]+$/, '') || 'Untitled project'

    // 2) One project, clips in sequence: `baseSequence` is the legacy multi-clip
    //    base — projectToDocument derives the main lane (and any cuts) from it on
    //    open, so the editor shows every file back-to-back.
    const project = newProject()
    project.name = name
    project.baseSequence = bases.map(seqClipFromLibrary)
    // CRITICAL: only a SINGLE-clip import may set project.media. With multiple
    // files media MUST stay undefined so every engine treats this as a multi-clip
    // montage: transcribe() combines + transcribes ALL clips, computeKeepRanges
    // uses the full montage duration, and the derived main lane lays out every
    // clip. Setting media pins all of them to the FIRST file only — which dropped
    // clips 2..n from the timeline, transcribed/cut only clip 1, and mis-tagged
    // file 1 as "Base clip" (the tag is item.path === project.media?.path).
    if (bases.length === 1) {
      project.media = {
        path: first.path,
        duration: first.duration,
        width: first.width,
        height: first.height,
        fps: first.fps,
        hasAudio: first.hasAudio,
        hasVideo: first.hasVideo
      }
    }
    // Make it the live project so the enhancement engines operate on it.
    set({
      project,
      library: items,
      currentProjectId: null,
      currentProjectName: name,
      mediaUrl: mediaUrl(first.path),
      selectedWordIds: new Set(),
      stagedSilences: [],
      stagedSilenceSel: new Set()
    })

    const openInEditor = async (proj: Project): Promise<void> => {
      const rec = await createProject(name, proj)
      // Captions + Auto Zoom need the mounted timeline engine → the editor runs
      // them on open (see the pending* consumers in Editor.tsx).
      set({ pendingCaptions: opts.captions, pendingAutoZoom: opts.autoZoom, wizardJob: null })
      get().openProjectRecord({ id: rec.id, name, project: proj })
      try {
        const fp = await serializeProject(get().project)
        await saveProject(rec.id, { project: fp })
      } catch {
        /* autosave in the editor will persist it shortly */
      }
    }

    // 3) Nothing to run before opening → straight to the editor.
    if (!opts.cutSilenceBadTakes && !opts.captions && !opts.autoZoom) {
      await openInEditor(project)
      return
    }

    // 4) Pre-open engines on the legacy model, each mapped into its slice of the
    //    single 0-100 wizard bar. Partial results beat a dead end, so on failure
    //    we still open with whatever succeeded.
    try {
      if (opts.cutSilenceBadTakes) {
        set({ wizardJob: { active: true, label: 'Transcribing…', base: 0, span: 45 } })
        await get().transcribe()
        set({ wizardJob: { active: true, label: 'Finding bad takes & silences…', base: 45, span: 30 } })
        await get().runRetakeCutBeta()
        set({ wizardJob: { active: true, label: 'Applying cuts…', base: 75, span: 10 } })
        await get().executeCuts()
      } else if (opts.captions || opts.autoZoom) {
        // Captions / Auto Zoom still need a transcript even when no cuts were
        // requested (Auto Zoom uses it to find + split the key moments).
        set({ wizardJob: { active: true, label: 'Transcribing…', base: 0, span: 85 } })
        await get().transcribe()
      }
    } catch (e) {
      set({ job: { active: false, percent: 0, message: `Import enhancement failed: ${(e as Error).message}` } })
    }

    // Finish: drive the bar to 100 and let it glide there BEFORE opening, so the
    // hand-off into the editor completes smoothly instead of jump-cutting at ~85%.
    set({ wizardJob: { active: true, label: 'Ready!', base: 100, span: 0 } })
    await new Promise((r) => setTimeout(r, 550))
    await openInEditor(get().project)
  }
}))

// ---- Undo/redo history controller ----
// Coalesces rapid edits (e.g. a drag) into one history entry and ignores
// view/playhead-only changes.
const history: {
  timer: ReturnType<typeof setTimeout> | null
  baseline: Project | null
  applying: boolean
} = { timer: null, baseline: null, applying: false }

function flushHistory(): void {
  if (history.timer) {
    clearTimeout(history.timer)
    history.timer = null
  }
  const b = history.baseline
  history.baseline = null
  if (b) {
    useStore.setState((st) => ({
      past: [...st.past.slice(-59), b],
      future: [],
      canUndo: true,
      canRedo: false
    }))
  }
}

useStore.subscribe((state, prev) => {
  if (history.applying) return
  if (state.project === prev.project) return
  if (!editChanged(state.project, prev.project)) return
  if (history.baseline === null) history.baseline = prev.project
  if (history.timer) clearTimeout(history.timer)
  history.timer = setTimeout(flushHistory, 400)
})

// Debug/support bridge: expose the store on window so overlay/suggest state can be
// inspected or driven from the console (client-only state; no secrets). Harmless.
if (typeof window !== 'undefined') (window as unknown as { ecStore?: typeof useStore }).ecStore = useStore
