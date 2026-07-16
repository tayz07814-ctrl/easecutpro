import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  MediaInfo,
  Transcript,
  SilenceRegion,
  SilenceDetectOptions,
  Project,
  ProgressEvent,
  Waveform,
  Thumb,
  ExportSettings,
  TextOverlayImage,
  ProjectMeta,
  ProjectRec,
  SequenceClip,
  TranscribeBackend,
  AICutResult,
  WhisperModelInfo,
  OverlayAsset,
  OverlayRule,
  OverlayGenResult,
  OverlaySuggestResult
} from '../shared/types'
import type { ToolStatus } from '../main/binaries'
import type { CutCutProResult } from '../shared/cutcutpro'
import type { RetakeAwareResult } from '../shared/retakeaware/types'
import type { RetakeBetaSilenceSettings } from '../shared/retakeaware/silence'
import type { VadSilenceSettings } from '../shared/vadsilence'

const api = {
  toolStatus: (): Promise<ToolStatus> => ipcRenderer.invoke(IPC.toolStatus),
  openMediaDialog: (): Promise<string | null> => ipcRenderer.invoke(IPC.openMediaDialog),
  openMediaDialogMulti: (): Promise<{ path: string; name: string }[]> =>
    ipcRenderer.invoke(IPC.openMediaDialogMulti),
  importFolder: (): Promise<{ path: string; name: string }[]> =>
    ipcRenderer.invoke(IPC.importFolder),
  combineClips: (clips: SequenceClip[], audioOnly?: boolean): Promise<MediaInfo> =>
    ipcRenderer.invoke(IPC.combineClips, clips, audioOnly),
  probe: (path: string): Promise<MediaInfo> => ipcRenderer.invoke(IPC.probe, path),
  transcribe: (path: string, backend?: TranscribeBackend, modelName?: string): Promise<Transcript> =>
    ipcRenderer.invoke(IPC.transcribe, path, backend, modelName),
  suggestCuts: (transcript: Transcript): Promise<AICutResult> =>
    ipcRenderer.invoke(IPC.suggestCuts, transcript),
  fastCut: (transcript: Transcript, audioPath?: string, script?: string): Promise<AICutResult> =>
    ipcRenderer.invoke(IPC.fastCut, transcript, audioPath, script),
  /** CutCutPro: 4-phase pipeline (whisper+Parakeet+VAD -> Claude -> OpenAI listen -> EDL). */
  cutCutPro: (
    path: string,
    transcript: Transcript | null,
    modelName?: string,
    runVad?: boolean,
    script?: string,
    vadSilenceSettings?: VadSilenceSettings
  ): Promise<CutCutProResult> =>
    ipcRenderer.invoke(IPC.cutCutPro, path, transcript, modelName, runVad, script, vadSilenceSettings),
  /** Retake-Aware Cut Beta: separate experimental engine (cut_mode: retake_aware_beta). */
  retakeAwareCut: (
    path: string,
    silenceSettings?: RetakeBetaSilenceSettings,
    vadSilenceSettings?: VadSilenceSettings
  ): Promise<RetakeAwareResult> =>
    ipcRenderer.invoke(IPC.retakeAwareCut, path, silenceSettings, vadSilenceSettings),
  /** Smart Smooth Cut (beta): AI pause judge — JSON in, raw JSON text out. */
  cutJudge: (payload: unknown): Promise<string> => ipcRenderer.invoke(IPC.cutJudge, payload),
  /** Smart Smooth Cut (beta): persist the per-run debug JSON; returns the path. */
  saveSmartCutDebug: (json: string): Promise<string> =>
    ipcRenderer.invoke(IPC.saveSmartCutDebug, json),
  generateOverlays: (
    transcript: Transcript,
    assets: OverlayAsset[],
    rules: OverlayRule[],
    opts: { duration: number; cuts: { start: number; end: number }[] }
  ): Promise<OverlayGenResult> => ipcRenderer.invoke(IPC.generateOverlays, transcript, assets, rules, opts),
  /** "Suggest": AI proposes overlay↔moment placements from the library, for review. */
  suggestOverlays: (
    transcript: Transcript,
    assets: OverlayAsset[],
    opts: { duration: number; cuts: { start: number; end: number }[] }
  ): Promise<OverlaySuggestResult> => ipcRenderer.invoke(IPC.suggestOverlays, transcript, assets, opts),
  /** Vision: describe what an overlay image DEPICTS (cached, fed into matching). */
  describeOverlayImage: (
    imageBase64: string,
    mediaType: string
  ): Promise<{ description: string }> => ipcRenderer.invoke(IPC.describeOverlayImage, imageBase64, mediaType),
  openaiStatus: (): Promise<{ available: boolean }> => ipcRenderer.invoke(IPC.openaiStatus),
  whisperModels: (): Promise<WhisperModelInfo[]> => ipcRenderer.invoke(IPC.whisperModels),
  detectSilence: (path: string, opts: SilenceDetectOptions): Promise<SilenceRegion[]> =>
    ipcRenderer.invoke(IPC.detectSilence, path, opts),
  waveform: (path: string): Promise<Waveform> => ipcRenderer.invoke(IPC.waveform, path),
  // `onPartial` streams thumbnails as they generate on the web build; Electron
  // returns the whole strip over IPC at once (callbacks can't cross IPC), so it
  // is accepted for a shared signature but ignored here.
  thumbnails: (path: string, intervalSec?: number, _onPartial?: (frames: Thumb[]) => void): Promise<Thumb[]> =>
    ipcRenderer.invoke(IPC.thumbnails, path, intervalSec),
  exportProject: (
    project: Project,
    settings: ExportSettings,
    textOverlays?: TextOverlayImage[]
  ): Promise<string | null> => ipcRenderer.invoke(IPC.export, project, settings, textOverlays),
  saveProject: (project: Project): Promise<string | null> =>
    ipcRenderer.invoke(IPC.saveProject, project),
  loadProject: (): Promise<Project | null> => ipcRenderer.invoke(IPC.loadProject),
  // Project library
  listProjects: (): Promise<ProjectMeta[]> => ipcRenderer.invoke(IPC.listProjects),
  createProject: (name: string, project: Project | null): Promise<{ id: string; name: string }> =>
    ipcRenderer.invoke(IPC.createProject, name, project),
  getProject: (id: string): Promise<ProjectRec | null> => ipcRenderer.invoke(IPC.getProject, id),
  saveProjectRecord: (
    id: string,
    patch: { name?: string; project?: Project; thumb?: string }
  ): Promise<void> => ipcRenderer.invoke(IPC.saveProjectRecord, id, patch),
  deleteProjectRecord: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.deleteProjectRecord, id),
  onProgress: (cb: (e: ProgressEvent) => void): (() => void) => {
    const listener = (_: unknown, payload: ProgressEvent): void => cb(payload)
    ipcRenderer.on(IPC.progress, listener)
    return () => ipcRenderer.removeListener(IPC.progress, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type EaseCutApi = typeof api
