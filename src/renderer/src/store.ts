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
  SilenceDetectOptions,
  TranscribeBackend,
  WhisperModelInfo,
  OverlayAsset,
  OverlayRule,
  OverlayEvent
} from '@shared/types'
import type { TimelineDocument } from '@shared/timeline/types'
import { documentToProject } from '@shared/timeline/bridge'
import { getSharedEngine } from './timelineEngine'
import { insertLibraryItemAtPlayhead } from './timelineInsert'
import { exportOnDevice } from './export/localExport'
import { renderTextPng } from './textRender'
import { TIMELINE_TRACK_COUNT } from '@shared/types'
import { detectFillerIds, detectRepeatIds, snapRetakeFlags, DEFAULT_FILLERS } from '@shared/fillers'
import { computeKeepRanges, subtractRanges, collapseTime, isMultiBase, stitchMontageWaveform, virtualToClip, baseTimelineDuration } from '@shared/edit'
import { runSmartSmoothCut, DEFAULT_SMART_CUT_PRESET, SMART_CUT_PRESETS, type SmartCutPresetName } from '@shared/smartsmooth'
import {
  DEFAULT_CUTLORD_SETTINGS,
  CUTLORD_PRESETS,
  effectiveSettings,
  vadDetectOpts,
  dbDetectOpts,
  padDbRegions,
  wordCutPad,
  mergeStagedSilences,
  type CutLordSettings
} from '@shared/cutlord'
import { positionToBox } from '@shared/overlay'
import { mediaSrc, IS_WEB } from './platform'
import { createProject, saveProject, serializeProject } from './projectsApi'
import { cleanVideo } from './batchClean'

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
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

/** Probe a file and build a library item (with a small preview thumbnail). */
async function buildLibraryItem(path: string): Promise<LibraryItem> {
  const info = await window.api.probe(path).catch(() => null)
  // Web media ids (webmedia:xxxx) carry no file extension, so extension sniffing
  // alone classified every browser-imported image as "video". The probe knows:
  // an image has visuals but no duration and no audio.
  const isImage = IMAGE_RE.test(path) || (!!info && info.hasVideo && !info.hasAudio && (info.duration || 0) === 0)
  const name = path.split(/[\\/]/).pop() ?? 'media'
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
      name: name || path.split(/[\\/]/).pop() || 'clip',
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

export interface Job {
  active: boolean
  kind?: ProgressEvent['kind']
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

/** Turn the current single base video into a sequence clip (so a dropped clip can
 *  be appended after it and the two combined into one base). */
function seqClipFromMedia(m: MediaInfo): SequenceClip {
  return {
    id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    sourcePath: m.path,
    name: m.path.split(/[\\/]/).pop() ?? 'base',
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

interface AppState {
  project: Project
  /** reusable media library (import once, reuse many; persisted). */
  library: LibraryItem[]
  /** last overlay-generation log (transient; shown in the overlay panel). */
  overlayLog: string[]
  /** object URL for the imported base media, for <video> playback. */
  mediaUrl: string | null
  waveform: Waveform | null
  /** amplitude peaks for the background-music clip (timeline display). */
  musicWaveform: Waveform | null
  thumbnails: Thumb[]
  selectedWordIds: Set<string>
  job: Job
  tools: { ffmpeg: boolean; ffprobe: boolean; whisper: boolean; whisperModel: boolean } | null
  playing: boolean
  scrubbing: boolean
  selectedClipId: string | null
  selectedSeg: BaseSegment | null
  selectedTextId: string | null
  toolsTab: 'transcript' | 'basic' | 'silence' | 'ost' | 'text' | 'overlays'
  silenceOpts: SilenceDetectOptions
  keybinds: { split: string; del: string; undelete: string; playPause: string }
  fillerWords: string[]
  /** which engine transcribes: 'local' offline whisper (default) or 'openai' premium-merge. */
  transcribeBackend: TranscribeBackend
  /** whether an OpenAI key is configured on the backend (enables cloud options). */
  openaiAvailable: boolean
  /** local whisper models available to pick from (empty until loaded). */
  whisperModels: WhisperModelInfo[]
  /** selected local whisper model name ('' = Auto / best available). */
  whisperModel: string
  showSettings: boolean
  showExportModal: boolean
  /** Batch Video Cleaner jobs shown on the home screen (newest first). */
  batchJobs: BatchJob[]
  // ---- App shell / accounts / projects (web) ----
  view: 'loading' | 'auth' | 'home' | 'editor'
  user: { id: string; email: string } | null
  /** id of the montage clip currently open in the single-clip editor (null = not editing a clip). */
  editingClipId: string | null
  currentProjectId: string | null
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
  /** import every media file in a chosen folder into the library at once. */
  importFolderToLibrary: () => Promise<void>
  /** append one library video to the base sequence (montage). */
  addToSequence: (libraryId: string) => void
  /** append ALL library videos to the base sequence, in order (numbered). */
  addAllToSequence: () => void
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
  detectSilence: () => Promise<void>
  setSilenceOpts: (patch: Partial<SilenceDetectOptions>) => void
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
  // ---- Smart Smooth Cut (beta) — separate experimental engine ----
  /** selected smoothing preset (persisted). */
  smartCutPreset: SmartCutPresetName
  setSmartCutPreset: (p: SmartCutPresetName) => void
  /** run the Smart Smooth Cut decision system (additive; standard engines untouched). */
  smartSmoothCut: () => Promise<void>
  // ---- Cut Lord / ClutterCleaner ----
  /** ⚙ profile for FastCut/ProCut silence cleaning (persisted). */
  cutLordSettings: CutLordSettings
  setCutLordSettings: (patch: Partial<CutLordSettings>) => void
  /** silence cuts staged for review (highlighted chips — NOT applied yet). */
  stagedSilences: SilenceRegion[]
  /** staged silences currently enabled (chip highlighted). */
  stagedSilenceSel: Set<string>
  toggleStagedSilence: (id: string) => void
  /** FastCut: word engine (flags repeats/fillers) + VAD silence staging. Review-only. */
  runFastCutLord: () => Promise<void>
  /** ProCut: the CutCutPro 4-phase pipeline + VAD silence staging. Review-only. */
  runProCut: () => Promise<void>
  /** apply everything the user reviewed: delete selected words + cut enabled staged
   *  silences. Async because the VAD-off switch defers the silence pass to here. */
  executeCuts: () => Promise<void>
  /** internal: transcribe with our inbuilt Parakeet (local-whisper fallback) and
   *  store the transcript — FastCut's auto-transcribe step. */
  _parakeetTranscribe: () => Promise<boolean>
  /** internal: run the ⚙-profile VAD (+dB) passes and stage the regions. */
  _stageVadSilences: (label: string, extra?: SilenceRegion[]) => Promise<void>
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
  setToolsTab: (t: 'transcript' | 'basic' | 'silence' | 'ost' | 'text' | 'overlays') => void

  // text overlays
  addText: () => void
  updateText: (id: string, patch: Partial<TextClip>) => void
  removeText: (id: string) => void
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
  /** load a saved project record into the editor. */
  openProjectRecord: (rec: { id: string; name: string; project: Project | null }) => void
  /** build a fresh empty project object (without entering the editor). */
  freshProject: () => Project
  /** leave the editor back to the home dashboard. */
  goHome: () => void
  /** Batch-clean multiple videos into auto-created projects (fillers + silences removed). */
  runBatchClean: (items: { path: string; name: string }[]) => Promise<void>
  /** Clear finished batch-clean jobs from the home screen. */
  dismissBatchJobs: () => void
}

export const useStore = create<AppState>((set, get) => ({
  project: newProject(),
  library: loadLibrary(),
  overlayLog: [],
  mediaUrl: null,
  waveform: null,
  musicWaveform: null,
  thumbnails: [],
  selectedWordIds: new Set(),
  job: { active: false, percent: 0 },
  tools: null,
  playing: false,
  scrubbing: false,
  selectedClipId: null,
  selectedSeg: null,
  selectedSeqClipId: null,
  selectedTextId: null,
  toolsTab: 'transcript',
  silenceOpts: { noiseDb: -30, minDuration: 0.4, mode: 'vad', vadThreshold: 0.5, speechPadMs: 40, edgeTrimMs: 200 },
  transcribeBackend: loadBackend(),
  openaiAvailable: false,
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
  showExportModal: false,
  batchJobs: [],
  view: IS_WEB ? 'loading' : 'home',
  user: null,
  editingClipId: null,
  currentProjectId: null,
  currentProjectName: 'Untitled',
  saveState: 'idle',
  past: [],
  future: [],
  canUndo: false,
  canRedo: false,

  init: async () => {
    const tools = await window.api.toolStatus()
    set({ tools })
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
    const path = await window.api.openMediaDialog()
    if (!path) return
    if (get().library.some((it) => it.path === path)) {
      set({ job: { active: false, percent: 100, message: 'Already in the library' } })
      return
    }
    set({ job: { active: true, kind: 'probe', percent: 0, message: 'Adding to library…' } })
    const item = await buildLibraryItem(path)
    const library = [...get().library, item]
    saveLibrary(library)
    set({ library, job: { active: false, percent: 100, message: `Added ${item.name} to the library` } })
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
        lib.push(await buildLibraryItem(it.path))
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
      const vids = s.library.filter((it) => it.kind === 'video' || it.kind === 'image')
      if (!vids.length) return { job: { active: false, percent: 0, message: 'No videos/images in the library to add' } }
      const seq = [...(s.project.baseSequence ?? []), ...vids.map(seqClipFromLibrary)]
      return {
        project: { ...s.project, baseSequence: seq },
        job: { active: false, percent: 100, message: `Sequence: ${seq.length} clip(s) — numbered in order` }
      }
    }),

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
      set({ job: { active: false, percent: 0, message: `Combine failed: ${(e as Error).message}` } })
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
    set({
      project: { ...newProject(), name: item.name, media },
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
      name: path.split(/[\\/]/).pop() ?? 'music',
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
    const path = await window.api.openMediaDialog()
    if (!path) return
    set({ job: { active: true, kind: 'probe', percent: 0, message: 'Probing media' } })
    let item = get().library.find((it) => it.path === path)
    if (!item) {
      item = await buildLibraryItem(path)
      const library = [...get().library, item]
      saveLibrary(library)
      set({ library })
    }
    get().setBaseFromLibrary(item.id)
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
        item = await buildLibraryItem(p.path)
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

  detectSilence: async () => {
    const p0 = get().project
    // Multi-clip base: detect across all clips WITHOUT flattening — combine audio,
    // detect once, re-split silences back per clip.
    if ((p0.baseSequence?.length ?? 0) > 0 && !p0.media) {
      const clips = p0.baseSequence!
      const { silenceOpts } = get()
      set({ job: { active: true, kind: 'silence', percent: 0, message: 'Cut Lord is working…' } })
      try {
        const combined = await window.api.combineClips(clips, true) // audio-only = fast
        set({ job: { active: true, kind: 'silence', percent: 45, message: 'Cut Lord is listening for gaps…' } })
        const regions = await window.api.detectSilence(combined.path, silenceOpts)
        // Store montage-time silences at project level (virtual continuous timeline).
        set((s) => ({
          project: { ...s.project, silences: regions },
          job: { active: false, percent: 100, message: `Found ${regions.length} silence(s) across ${clips.length} clip(s)` }
        }))
      } catch (e) {
        set({ job: { active: false, percent: 0, message: (e as Error).message } })
      }
      return
    }
    const { project, silenceOpts } = get()
    if (!project.media) return
    set({ job: { active: true, kind: 'silence', percent: 0, message: 'Cut Lord is listening for gaps…' } })
    const regions = await window.api.detectSilence(project.media.path, silenceOpts)
    set((s) => ({
      project: { ...s.project, silences: regions },
      job: { active: false, percent: 100, message: `Found ${regions.length} silence(s)` }
    }))
  },

  setSilenceOpts: (patch) => set((s) => ({ silenceOpts: { ...s.silenceOpts, ...patch } })),
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

  stagedSilences: [],
  stagedSilenceSel: new Set<string>(),

  toggleStagedSilence: (id) =>
    set((s) => {
      const sel = new Set(s.stagedSilenceSel)
      if (sel.has(id)) sel.delete(id)
      else sel.add(id)
      return { stagedSilenceSel: sel }
    }),

  runFastCutLord: async () => {
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
    // VAD switch ON: stage silence chips for review. OFF: silence runs at Execute.
    if (get().cutLordSettings.vadDuringAnalysis) await get()._stageVadSilences('FastCut')
  },

  runProCut: async () => {
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
      // it into the word selector below. VAD switch OFF => runVad=false (word cuts only).
      const vadOn = get().cutLordSettings.vadDuringAnalysis
      const res = await window.api.cutCutPro(path, p0.transcript ?? null, get().whisperModel || undefined, vadOn, get().project.script || undefined)
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
            `ProCut flagged ${snapped.length} word(s) + ${res.silenceAdds.length} pause(s) — review, then Execute cuts` +
            (res.debugPath ? ` · debug: ${res.debugPath.split(/[\\/]/).slice(-1)[0]}` : '')
        }
      }))
      // VAD switch ON: stage the AI's pause cuts + the ⚙ VAD silences for review.
      // OFF: word cuts only here — silence is applied at Execute cuts instead.
      if (vadOn) await get()._stageVadSilences('ProCut', res.silenceAdds)
    } catch (e) {
      set({ job: { active: false, percent: 0, message: `ProCut failed: ${(e as Error).message}` } })
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
      set({ job: { active: false, percent: 0, message: `Transcription failed: ${(e as Error).message}` } })
      return false
    }
  },

  _stageVadSilences: async (label, extra) => {
    const s = get()
    const p = s.project
    try {
      set({ job: { active: true, kind: 'silence', percent: 5, message: 'Cut Lord is listening for gaps…' } })
      let path: string
      if (isMultiBase(p)) {
        const combined = await window.api.combineClips(p.baseSequence!, true)
        path = combined.path
      } else if (p.media) {
        path = p.media.path
      } else {
        set({ job: { active: false, percent: 0, message: 'No media for the silence scan' } })
        return
      }
      const cfg = s.cutLordSettings
      const batches: SilenceRegion[][] = []
      const vadRegions = await window.api.detectSilence(path, vadDetectOpts(cfg))
      batches.push(vadRegions.map((r) => ({ ...r, action: 'remove' as const })))
      if (effectiveSettings(cfg).useDb) {
        set({ job: { active: true, kind: 'silence', percent: 60, message: 'Cut Lord is double-checking gaps…' } })
        const dbRegions = await window.api.detectSilence(path, dbDetectOpts(cfg))
        batches.push(padDbRegions(dbRegions.map((r) => ({ ...r, action: 'remove' as const })), cfg))
      }
      if (extra?.length) batches.push(extra)
      const staged = mergeStagedSilences(batches, get().project.silences)
      set({
        stagedSilences: staged,
        stagedSilenceSel: new Set(staged.map((r) => r.id)),
        job: {
          active: false,
          percent: 100,
          message: `${label}: ${get().selectedWordIds.size} word(s) + ${staged.length} silence(s) highlighted — review, then Execute cuts`
        }
      })
    } catch (e) {
      // Silence staging must never kill the word results.
      set({ job: { active: false, percent: 0, message: `${label}: silence scan failed (${(e as Error).message}) — word flags kept` } })
    }
  },

  executeCuts: async () => {
    // VAD switch OFF: the Silero VAD silence pass was decoupled from FastCut/ProCut —
    // run + stage it now, at Execute, so silence is applied here (auto-selected).
    if (!get().cutLordSettings.vadDuringAnalysis && (!!get().project.media || (get().project.baseSequence?.length ?? 0) > 0)) {
      await get()._stageVadSilences('Execute')
    }
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
        silences: [...st.project.silences, ...enabled].sort((a, b) => a.start - b.start),
        // "trim cuts" from the ⚙ profile becomes the word-splice trim.
        wordCutPad: wordCutPad(st.cutLordSettings),
        // FastCut / ProCut exports get 25ms anti-click fades at every cut seam.
        smoothAudioFadeMs: 25
      },
      stagedSilences: [],
      stagedSilenceSel: new Set<string>(),
      job: {
        active: false,
        percent: 100,
        message: `Executed: ${hadWords} word(s) cut, ${enabled.length} silence(s) cleaned`
      }
    }))
  },

  smartCutPreset: ((): SmartCutPresetName => {
    try {
      const v = localStorage.getItem('ec.smartCutPreset') as SmartCutPresetName | null
      return v === 'natural' || v === 'tiktok_smooth' || v === 'aggressive' ? v : DEFAULT_SMART_CUT_PRESET
    } catch {
      return DEFAULT_SMART_CUT_PRESET
    }
  })(),

  setSmartCutPreset: (p) => {
    try {
      localStorage.setItem('ec.smartCutPreset', p)
    } catch {
      /* ignore */
    }
    set({ smartCutPreset: p })
  },

  // Smart Smooth Cut (beta): NEW experimental engine, fully additive. Builds
  // pause candidates from transcript word gaps (+ existing VAD silences as
  // candidates only), scores them with rules, asks the AI judge about the
  // ambiguous ones, then applies the result THROUGH the existing model
  // (silence regions + flagged retake words) — so Standard cut paths, preview,
  // export and undo are completely unchanged.
  smartSmoothCut: async () => {
    const s0 = get()
    const t = s0.project.transcript
    if (!t) {
      set({ job: { active: false, percent: 0, message: 'Transcribe first — Smart Smooth Cut uses word timestamps' } })
      return
    }
    const preset = s0.smartCutPreset
    set({ job: { active: true, kind: 'transcribe', percent: 10, message: 'Cut Lord is thinking…' } })
    try {
      const p = s0.project
      // Whisper.cpp word timestamps are CONTIGUOUS (a word's end runs to the
      // next word's start), so real pauses hide INSIDE word spans and the
      // word-gap detector alone finds nothing. If the project has no detected
      // silences yet, run a quick VAD pass so the engine has pause candidates.
      let vad = p.silences.map((r) => ({ start: r.start, end: r.end }))
      if (!vad.length) {
        set({ job: { active: true, kind: 'transcribe', percent: 20, message: 'Cut Lord is listening for gaps…' } })
        try {
          let path: string | null = null
          if (isMultiBase(p)) path = (await window.api.combineClips(p.baseSequence!, true)).path
          else if (p.media) path = p.media.path
          if (path) {
            const regions = await window.api.detectSilence(path, {
              mode: 'vad',
              noiseDb: -30,
              minDuration: 0.25,
              vadThreshold: 0.5,
              speechPadMs: 60
            })
            vad = regions.map((r) => ({ start: r.start, end: r.end }))
          }
        } catch {
          /* VAD unavailable -> word gaps only (engine records the warning) */
        }
      }
      const res = await runSmartSmoothCut({
        words: t.words,
        vad,
        waveform: s0.waveform,
        preset,
        existingSilences: p.silences,
        videoDuration: p.media?.duration ?? baseTimelineDuration(p),
        aiJudge: async (input) => {
          set({ job: { active: true, kind: 'transcribe', percent: 55, message: 'Cut Lord is judging the pauses…' } })
          return window.api.cutJudge(input)
        }
      })
      // Persist the debug JSON (never fatal).
      let debugNote = ''
      try {
        const path = await window.api.saveSmartCutDebug(JSON.stringify(res.debug, null, 2))
        debugNote = ` · debug: ${path.split(/[\\/]/).slice(-1)[0]}`
      } catch {
        debugNote = ''
      }
      set((s) => ({
        project: {
          ...s.project,
          silences: [...s.project.silences, ...res.silenceAdds].sort((a, b) => a.start - b.start),
          // Enable the gated seam fades for this project's exports (smooth mode only).
          smoothAudioFadeMs: SMART_CUT_PRESETS[preset].audio_fade_ms
        },
        selectedWordIds: res.retakeWordIds.length ? new Set(res.retakeWordIds) : s.selectedWordIds,
        job: {
          active: false,
          percent: 100,
          message:
            `Smart Smooth Cut: ${res.silenceAdds.length} pause edit(s)` +
            (res.retakeWordIds.length ? `, ${res.retakeWordIds.length} retake word(s) flagged — review, then Delete` : '') +
            debugNote
        }
      }))
    } catch (e) {
      set({ job: { active: false, percent: 0, message: `Smart Smooth Cut failed: ${(e as Error).message}` } })
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
        position: 'top_center', durationSeconds: 3, animation: 'pop'
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

  removeOverlayAsset: (overlayId) =>
    set((s) => ({
      project: {
        ...s.project,
        overlayAssets: (s.project.overlayAssets ?? []).filter((a) => a.id !== overlayId),
        overlayRules: (s.project.overlayRules ?? []).filter((r) => r.overlayId !== overlayId),
        tracks: s.project.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.overlayRuleId !== overlayId) }))
      }
    })),

  clearGeneratedOverlays: () =>
    set((s) => ({
      project: {
        ...s.project,
        tracks: s.project.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => !c.overlayRuleId) }))
      }
    })),

  generateOverlays: async () => {
    const { project } = get()
    // Multi-clip base: the transcript is per-clip, not a single project.transcript.
    // Overlay matching over the whole montage is out of scope for now — guide the
    // user to per-clip editing rather than showing a misleading "transcribe first".
    if ((project.baseSequence?.length ?? 0) > 0 && !project.media) {
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
    const dur = project.media?.duration ?? 0
    const cuts = subtractRanges([{ start: 0, end: dur }], computeKeepRanges(project, get().waveform))
    set({ job: { active: true, kind: 'transcribe', percent: 0, message: 'Generating overlays…' } })
    try {
      const res = await window.api.generateOverlays(t, assets, rules, { duration: dur, cuts })
      // turn events into image clips on overlay track 1 (source -> edited time).
      const assetById = new Map(assets.map((a) => [a.id, a]))
      const newClips: Clip[] = []
      for (const ev of res.events as OverlayEvent[]) {
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
          start: Math.max(0, collapseTime(ev.start, cuts)),
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
      res.log.forEach((l) => console.log('[overlays]', l))
      set({
        overlayLog: res.log,
        job: {
          active: false,
          percent: 100,
          message: newClips.length ? `Placed ${newClips.length} overlay(s) via ${res.via}` : 'No overlay matches found'
        }
      })
    } catch (e) {
      set({ job: { active: false, percent: 0, message: (e as Error).message } })
    }
  },

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
      name: path.split(/[\\/]/).pop() ?? 'b-roll',
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
    set({ showExportModal: false, job: { active: true, kind: 'export', percent: 1, message: 'Exporting on this device…' } })
    try {
      const { blob, name } = await exportOnDevice(
        get().project,
        { width: settings.width, height: settings.height, bitrateMbps: settings.bitrateMbps },
        (percent, message) => set({ job: { active: true, kind: 'export', percent, message } })
      )
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 8000)
      set({ job: { active: false, percent: 100, message: `Saved ${name} to this device` } })
    } catch (e) {
      set({
        job: { active: false, percent: 0, message: `On-device export: ${(e as Error).message} — use the normal Export instead` }
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
      set({ job: { active: false, percent: 0, message: `Export failed: ${(e as Error).message}` } })
    }
  },

  setShowExportModal: (b) => set({ showExportModal: b }),

  save: async () => {
    const { project } = get()
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

  goHome: () => set({ view: 'home', selectedClipId: null, selectedSeg: null, selectedTextId: null, selectedWordIds: new Set() }),

  openProjectRecord: (rec) => {
    const project = rec.project ?? newProject()
    set({
      project,
      currentProjectId: rec.id,
      currentProjectName: rec.name,
      saveState: 'idle',
      view: 'editor',
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
    if (project.media?.path) {
      const p = project.media.path
      window.api.waveform(p).then((wf) => set({ waveform: wf })).catch(() => undefined)
      if (project.media.hasVideo) window.api.thumbnails(p).then((t) => set({ thumbnails: t })).catch(() => undefined)
    }
    if (project.music?.path) {
      window.api.waveform(project.music.path).then((wf) => set({ musicWaveform: wf })).catch(() => undefined)
    }
  },

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

    // 2) Process sequentially — transcription/silence are heavy GPU/CPU work.
    for (const c of created) {
      update(c.id, { status: 'processing', step: 'Starting…' })
      try {
        const { project, thumb } = await cleanVideo(
          c.item.path,
          c.item.name,
          get().fillerWords,
          get().silenceOpts,
          (step) => update(c.id, { step })
        )
        const finalProject = await serializeProject(project)
        await saveProject(c.id, { project: finalProject, thumb })
        update(c.id, { status: 'done', step: 'Cleaned' })
      } catch (e) {
        update(c.id, { status: 'error', step: 'Failed', error: (e as Error).message })
      }
    }
  },

  dismissBatchJobs: () => set({ batchJobs: [] })
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
