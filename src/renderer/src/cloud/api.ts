// Cloud build implementation of the window.api surface (Vercel + Supabase —
// no PC server). Everything heavy is device-local: media stays in the browser
// (webmedia/IndexedDB), probe/waveform/thumbnails run locally, export is the
// on-device WebCodecs path. Retake β + transcription run in-browser against
// the Supabase edge functions; the other engines are desktop/self-host-only
// and their UI is hidden by IS_CLOUD gates.
import type { Project, ProgressEvent } from '@shared/types'
import { keywordOverlayTimeline } from '@shared/overlay'
import {
  registerLocalFile,
  isWebMediaId,
  localProbe,
  localWaveform,
  localThumbnails,
  combineSequenceAudioWav,
  requestPersistentStorage
} from '../webmedia'
import { retakeAwareCutCloud, transcribeCloud } from './retakeEngine'
import { cutCutProCloud } from './procutEngine'
import { detectSilenceCloud } from './vad'
import { cloudListProjects, cloudCreateProject, cloudGetProject, cloudSaveProject, cloudDeleteProject } from './projects'
import { initSettingsSync } from './settings'

const progressListeners = new Set<(e: ProgressEvent) => void>()

function emit(kind: ProgressEvent['kind'], percent: number, message?: string, jobId = 'cloud'): void {
  for (const cb of progressListeners) cb({ jobId, kind, percent, message })
}

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.click()
  })
}

function pickFiles(accept: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = true
    input.onchange = () => resolve(input.files ? Array.from(input.files) : [])
    input.click()
  })
}

function pickFolder(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    ;(input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true
    input.onchange = () => resolve(input.files ? Array.from(input.files) : [])
    input.click()
  })
}

function triggerDownload(url: string, name: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** These engines stay on desktop/self-host; their buttons are IS_CLOUD-hidden,
 *  so this is a backstop, not a user-facing path. */
function desktopOnly(feature: string): never {
  throw new Error(`${feature} isn't available in the cloud version — use the desktop app or a self-hosted server.`)
}

/** Media that isn't on THIS device can't be processed by the cloud build. */
function needLocal(path: string): string {
  if (!isWebMediaId(path)) {
    throw new Error('This source file is not on this device — re-import it here to use it.')
  }
  return path
}

const cloudApi: Window['api'] = {
  // No PC binaries in the cloud — feature gating happens via IS_CLOUD in the
  // UI; report everything unavailable for any legacy checks.
  toolStatus: async () => ({ ffmpeg: false, ffprobe: false, whisper: false, whisperModel: false }),

  // Local-first import — identical to the self-host web flow.
  openMediaDialog: async () => {
    const f = await pickFile('video/*,audio/*,image/*')
    return f ? registerLocalFile(f) : null
  },
  openMediaDialogMulti: async () => {
    const files = await pickFiles('video/*,audio/*,image/*')
    return files.map((f) => ({ path: registerLocalFile(f), name: f.name }))
  },
  importFolder: async () => {
    const MEDIA_RE = /\.(mp4|mov|mkv|webm|avi|m4v|mp3|wav|m4a|aac|png|jpe?g|webp|gif|bmp)$/i
    const files = (await pickFolder()).filter((f) => MEDIA_RE.test(f.name))
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    return files.map((f) => ({ path: registerLocalFile(f), name: f.name }))
  },

  // Montage: the Cut Lord flows all pass audioOnly=true and only need the base
  // sequence's AUDIO, which we concatenate in-browser (no server ffmpeg) so the
  // normal single-file transcribe / silence / Retake β pipeline runs unchanged.
  // The video "Flatten to one file" (audioOnly=false) is IS_CLOUD-hidden; export
  // and preview are already montage-native, so it isn't needed here.
  combineClips: async (clips, audioOnly) => {
    if (!audioOnly) desktopOnly('Flatten to one video')
    clips.forEach((c) => needLocal(c.sourcePath))
    const wav = await combineSequenceAudioWav(clips, (pct) =>
      emit('transcribe', Math.round(pct * 0.4), 'Cut Lord is combining clips…')
    )
    const file = new File([wav], 'montage.ecaudio.wav', { type: 'audio/wav' })
    const path = registerLocalFile(file, false) // transient analysis artifact
    const duration = clips.reduce((s, c) => s + Math.max(0, c.sourceOut - c.sourceIn), 0)
    return { path, duration, width: 0, height: 0, fps: 0, hasAudio: true, hasVideo: false }
  },

  probe: (path) => localProbe(needLocal(path)),
  waveform: (path) => localWaveform(needLocal(path)),
  thumbnails: (path, intervalSec) => localThumbnails(needLocal(path), intervalSec),

  // Verbatim STT via the edge functions (AssemblyAI -> Deepgram).
  transcribe: async (path) =>
    transcribeCloud(needLocal(path), (pct, msg) => emit('transcribe', pct, msg)),

  suggestCuts: async () => desktopOnly('Smart Cut'),
  fastCut: async () => desktopOnly('Fast Cut'),
  // ProCut in the cloud: AssemblyAI transcribes + Claude finalizes the cuts
  // (procut-judge edge fn). No GPT "listening" pass — that stays desktop-only.
  cutCutPro: (path, transcript, _modelName, runVad, script, vadSilenceSettings) =>
    cutCutProCloud(needLocal(path), transcript ?? null, runVad ?? true, script, vadSilenceSettings, (pct, msg) => emit('transcribe', pct, msg)),
  cutJudge: async () => desktopOnly('Smart Smooth Cut'),
  saveSmartCutDebug: async () => desktopOnly('Smart Smooth Cut'),
  // Cloud overlay placement runs entirely in the browser: deterministic keyword
  // matching over the (edge-function) transcript, no server or API key. Semantic
  // Claude matching stays desktop/self-host-only; the panel notes this.
  generateOverlays: async (transcript, assets, rules, opts) =>
    keywordOverlayTimeline(transcript, assets, rules, opts),

  retakeAwareCut: (path, _silenceSettings, vadSilenceSettings) =>
    retakeAwareCutCloud(needLocal(path), (pct, msg) => emit('transcribe', pct, msg), vadSilenceSettings),

  openaiStatus: async () => ({ available: false }),
  whisperModels: async () => [],

  // Silero VAD (ONNX) in the browser.
  detectSilence: (path, opts) => detectSilenceCloud(needLocal(path), opts),

  // Only the on-device WebCodecs export exists in the cloud; the UI hides the
  // server export button.
  exportProject: async () =>
    desktopOnly('Server export (use "Export on this device")'),

  saveProject: async (project: Project) => {
    const name = `${(project.name || 'project').replace(/\.[^.]+$/, '')}.ecp.json`
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    triggerDownload(url, name)
    setTimeout(() => URL.revokeObjectURL(url), 4000)
    return name
  },
  loadProject: async () => {
    const f = await pickFile('.json,application/json')
    if (!f) return null
    try {
      return JSON.parse(await f.text()) as Project
    } catch {
      return null
    }
  },

  onProgress: (cb) => {
    progressListeners.add(cb as (e: ProgressEvent) => void)
    return () => progressListeners.delete(cb as (e: ProgressEvent) => void)
  },

  // Project library — Postgres rows behind RLS.
  listProjects: () => cloudListProjects(),
  createProject: (name, project) => cloudCreateProject(name, project),
  getProject: (id) => cloudGetProject(id),
  saveProjectRecord: (id, patch) => cloudSaveProject(id, patch),
  deleteProjectRecord: (id) => cloudDeleteProject(id)
}

export function installCloudApi(): void {
  window.api = cloudApi
  initSettingsSync()
  // Media autosaves to THIS device (IndexedDB) — ask the browser to keep it.
  requestPersistentStorage()
}
