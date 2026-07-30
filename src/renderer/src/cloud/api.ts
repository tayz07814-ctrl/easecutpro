// Cloud build implementation of the window.api surface (Vercel + Supabase —
// no PC server). Everything heavy is device-local: media stays in the browser
// (webmedia/IndexedDB), probe/waveform/thumbnails run locally, export is the
// on-device WebCodecs path. Retake β + transcription run in-browser against
// the Supabase edge functions; the other engines are desktop/self-host-only
// and their UI is hidden by IS_CLOUD gates.
import type { Project, ProgressEvent, SilenceRegion } from '@shared/types'
import { generateOverlaysCloud, suggestOverlaysCloud } from './overlayMatch'
import { invokeEdge } from './supabase'
import {
  registerLocalFile,
  registerNativeBackedFile,
  isWebMediaId,
  localProbe,
  localWaveform,
  localThumbnails,
  combineSequenceAudioWav,
  requestPersistentStorage
} from '../webmedia'
import { hasNativeMedia, pickNativeMedia, nativeFileUrl, type NativePickKind } from './nativeMedia'
import { retakeAwareCutCloud, ultracutCutCloud, transcribeCloud } from './retakeEngine'
import { fsmnSilenceOnly } from './retakeFinalBossVad'
import { extractSttAudio } from './audio'
import { premiumCutCloud } from './premiumEngine'
import { cutCutProCloud } from './procutEngine'
import { detectSilenceCloud } from './vad'
import { cloudListProjects, cloudCreateProject, cloudGetProject, cloudSaveProject, cloudDeleteProject } from './projects'
import { useStore } from '../store'
import { initSettingsSync } from './settings'

const progressListeners = new Set<(e: ProgressEvent) => void>()

function emit(kind: ProgressEvent['kind'], percent: number, message?: string, jobId = 'cloud'): void {
  for (const cb of progressListeners) cb({ jobId, kind, percent, message })
}

/** Open a native file picker and resolve with the chosen files (empty on cancel).
 *  The <input> is APPENDED to the DOM before `.click()` — a DETACHED input's click
 *  is ignored by the Android System WebView (and by iOS Safari), so the picker
 *  silently never opened in the bundled app. We insert it off-screen, click, then
 *  remove it once the pick settles (`cancel` cleans up on dismissal). */
function openPicker(configure: (input: HTMLInputElement) => void): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    configure(input)
    input.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0'
    let settled = false
    const finish = (files: File[]): void => {
      if (settled) return
      settled = true
      input.remove()
      resolve(files)
    }
    input.onchange = () => finish(input.files ? Array.from(input.files) : [])
    input.oncancel = () => finish([])
    document.body.appendChild(input)
    input.click()
  })
}

function pickFile(accept: string): Promise<File | null> {
  return openPicker((i) => {
    i.accept = accept
  }).then((files) => files[0] ?? null)
}

function pickFiles(accept: string): Promise<File[]> {
  return openPicker((i) => {
    i.accept = accept
    i.multiple = true
  })
}

function pickFolder(): Promise<File[]> {
  return openPicker((i) => {
    i.multiple = true
    ;(i as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true
  })
}

/** In the bundled native app, the Android picker hands back a File backed by a
 *  transient `content://` URI whose read permission is revoked shortly after the
 *  pick — so a LATER read (waveform/video decode) fails with "the requested file
 *  could not be read". Copy the bytes into a stable in-memory File NOW, while the
 *  grant is still valid, and use that. Desktop/web Files stay readable, so we skip
 *  the (memory-heavy) copy there. */
async function stableFile(f: File): Promise<File> {
  if (import.meta.env.VITE_CAPACITOR !== '1') return f
  try {
    const buf = await f.arrayBuffer()
    return new File([buf], f.name, { type: f.type, lastModified: f.lastModified })
  } catch {
    return f // fall back to the original reference
  }
}

async function registerPicked(files: File[]): Promise<{ path: string; name: string }[]> {
  const out: { path: string; name: string }[] = []
  for (const f of files) out.push({ path: registerLocalFile(await stableFile(f)), name: f.name })
  return out
}

/** Native (Android) import: the system picker COPIED each file to an app path, so
 *  we read the bytes from that stable path (no revoked content:// URI) into a File
 *  for the existing webmedia pipeline, AND remember the path for the native
 *  hardware-codec export. Returns null when the native picker isn't present so the
 *  caller can fall back to the DOM <input> picker. */
async function registerNativePicked(
  kind: NativePickKind
): Promise<{ path: string; name: string }[] | null> {
  if (!hasNativeMedia()) return null
  const picked = await pickNativeMedia(kind)
  const out: { path: string; name: string }[] = []
  for (const p of picked) {
    try {
      const blob = await (await fetch(nativeFileUrl(p.path))).blob()
      const file = new File([blob], p.name, { type: p.mimeType || blob.type })
      out.push({ path: registerNativeBackedFile(file, p.path), name: p.name })
    } catch {
      /* one file failed to read back — skip it, keep the rest */
    }
  }
  return out
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

const cloudApi: Window['api'] & {
  ultracutCut: Window['api']['retakeAwareCut']
  premiumCut: Window['api']['retakeAwareCut']
  /** "Find Silences" — the FSMN silence pass on its own (no STT, no judge). */
  fsmnSilence: (path: string, onProgress?: (pct: number, msg?: string) => void) => Promise<SilenceRegion[]>
  openAudioDialogMulti: () => Promise<{ path: string; name: string }[]>
} = {
  // No PC binaries in the cloud — feature gating happens via IS_CLOUD in the
  // UI; report everything unavailable for any legacy checks.
  toolStatus: async () => ({ ffmpeg: false, ffprobe: false, whisper: false, whisperModel: false }),

  // Local-first import. Video/image use a VISUAL accept so Android's WebView
  // opens the gallery/photos picker (with a Files option) instead of jumping
  // straight to storage; audio has its own picker (openAudioDialogMulti below).
  openMediaDialog: async () => {
    const nat = await registerNativePicked('visual')
    if (nat) return nat[0]?.path ?? null
    const f = await pickFile('video/*,image/*')
    return f ? registerLocalFile(await stableFile(f)) : null
  },
  openMediaDialogMulti: async () => {
    const nat = await registerNativePicked('visual')
    if (nat) return nat
    const files = await pickFiles('video/*,image/*')
    return registerPicked(files)
  },
  // Audio import (music / voiceover) — opens files/storage, not the gallery.
  openAudioDialogMulti: async () => {
    const nat = await registerNativePicked('audio')
    if (nat) return nat
    const files = await pickFiles('audio/*')
    return registerPicked(files)
  },
  importFolder: async () => {
    const MEDIA_RE = /\.(mp4|mov|mkv|webm|avi|m4v|mp3|wav|m4a|aac|png|jpe?g|webp|gif|bmp)$/i
    const files = (await pickFolder()).filter((f) => MEDIA_RE.test(f.name))
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    return registerPicked(files)
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
  // Cloud overlay placement: SEMANTIC matching via the overlay-match edge function
  // (Claude Opus), with deterministic keyword matching as the offline fallback.
  generateOverlays: async (transcript, assets, rules, opts) =>
    generateOverlaysCloud(transcript, assets, rules, opts),
  // "Suggest" (paid/discovery): AI proposes placements from the library, for review.
  suggestOverlays: async (transcript, assets, opts) =>
    suggestOverlaysCloud(transcript, assets, opts),
  // Vision (v1.5): describe what an overlay image depicts, via the overlay-vision edge fn.
  describeOverlayImage: async (imageBase64, mediaType) => {
    try {
      return await invokeEdge<{ description: string }>('overlay-vision', { image: imageBase64, mediaType })
    } catch {
      return { description: '' } // graceful: matching falls back to the overlay name
    }
  },
  // Moment vision (image-to-image): pick which of the creator's overlays depicts what
  // they show across a few video frames, via the moment-vision edge fn.
  matchMoment: async (frames, line, overlays) => {
    try {
      return await invokeEdge<{ overlayId: string; note?: string }>('moment-vision', { frames, line, overlays })
    } catch {
      return { overlayId: '' } // graceful: moment matching just adds nothing
    }
  },

  // Silence comes from the FSMN (FunASR) engine — the 0.07 engine ported to 0.01
  // and the only live silence cutter. Its settings live in the store
  // (retakeFinalBossSettings, the "Silence settings" modal). The transcript-gap
  // Smart Silence engine is dormant and is not consulted here. The old Silero VAD
  // args are ignored (ProCut / Ultracut / Premium below still pass and use them).
  retakeAwareCut: (path) =>
    retakeAwareCutCloud(
      needLocal(path),
      (pct, msg) => emit('transcribe', pct, msg),
      useStore.getState().retakeFinalBossSettings
    ),

  // "Find Silences" — the same FSMN engine and the same "Silence settings"
  // (retakeFinalBossSettings) Find cuts uses, minus transcription and the retake
  // judge. Decodes the audio locally and runs the ONNX VAD in-browser, so there
  // is no edge-function round trip and no STT cost.
  fsmnSilence: async (path, onProgress) => {
    const id = needLocal(path)
    const op = (pct: number, msg?: string): void => {
      onProgress?.(pct, msg)
      emit('silence', pct, msg)
    }
    op(4, 'Getting your audio ready…')
    const audio = await extractSttAudio(id, (p) => op(4 + Math.round(p * 0.36)))
    op(45, 'Listening for pauses…')
    const regions = await fsmnSilenceOnly(
      audio.float32,
      audio.sampleRate,
      audio.durationS,
      useStore.getState().retakeFinalBossSettings
    )
    op(100, `Found ${regions.length} silence${regions.length === 1 ? '' : 's'}`)
    return regions
  },

  // Ultracut (Beta) — a SEPARATE experimental engine (ultracut-judge, OpenRouter
  // GLM 5.2). Shares nothing with Retake Beta's Opus judge; exposed as its own
  // method so the Ultracut button routes independently. Cloud-only (easecut0.01).
  ultracutCut: (path, _silenceSettings, vadSilenceSettings) =>
    ultracutCutCloud(needLocal(path), (pct, msg) => emit('transcribe', pct, msg), vadSilenceSettings),

  // Premium Cut — a SEPARATE experimental engine (premium-cut, Gemini 3.5 Flash
  // multimodal). Gemini LISTENS to the raw audio and returns the transcript + all
  // cuts itself (no STT, no VAD). Its own method so the Premium button routes
  // independently. Cloud-only (easecut0.01).
  premiumCut: (path, _silenceSettings, vadSilenceSettings) =>
    premiumCutCloud(needLocal(path), (pct, msg) => emit('transcribe', pct, msg), vadSilenceSettings),

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
