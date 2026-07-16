import { app, BrowserWindow, ipcMain, dialog, protocol } from 'electron'
import { join, extname } from 'path'
import { createReadStream } from 'fs'
import { stat, readdir, mkdir, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { Readable } from 'stream'
import { randomUUID } from 'crypto'
import { IPC } from '../shared/ipc'
import { checkTools, listWhisperModels } from './binaries'
import { probe, detectSilence, exportProject, extractWaveform, extractThumbnails, combineClips } from './ffmpeg'
import { transcribe } from './whisper'
import { transcribeOpenAI } from './openai-transcribe'
import { transcribeParakeet } from './parakeet'
import { suggestCutsAI } from './ai-cut'
import { judgeCuts } from './ai-cut-judge'
import { cutCutPro } from './cutcutpro'
import { retakeAwareCut } from './retakeaware/engine'
import type { RetakeBetaSilenceSettings } from '../shared/retakeaware/silence'
import { fastCutSuggest, startFastcutSidecar, stopFastcutSidecar } from './fast-cut'
import { generateOverlayTimeline, suggestOverlayTimeline } from './overlay-rules'
import { openaiAvailable } from './openai'
import {
  saveProject,
  loadProject,
  setProjectsDir,
  defaultProjectsRoot,
  listProjectRecords,
  createProjectRecord,
  getProjectRecord,
  saveProjectRecord,
  deleteProjectRecord
} from './projectStore'
import type {
  Project,
  SilenceDetectOptions,
  ExportSettings,
  TextOverlayImage,
  Transcript,
  TranscribeBackend,
  OverlayAsset,
  OverlayRule
} from '../shared/types'

let mainWindow: BrowserWindow | null = null

// Custom streaming scheme so the renderer can play user-selected local files
// (file:// is blocked cross-origin). Must be registered before app is ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'ecmedia',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
  }
])

/** Build an ecmedia:// URL for a local file path (used by the renderer). */
export function mediaUrlFor(filePath: string): string {
  return `ecmedia://media/?p=${encodeURIComponent(filePath)}`
}

function mimeForPath(p: string): string {
  switch (extname(p).toLowerCase()) {
    case '.mp4':
    case '.m4v':
      return 'video/mp4'
    case '.webm':
      return 'video/webm'
    case '.mkv':
      return 'video/x-matroska'
    case '.mov':
      return 'video/quicktime'
    case '.avi':
      return 'video/x-msvideo'
    case '.mp3':
      return 'audio/mpeg'
    case '.wav':
      return 'audio/wav'
    case '.m4a':
    case '.aac':
      return 'audio/mp4'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.bmp':
      return 'image/bmp'
    default:
      return 'application/octet-stream'
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#0e0f13',
    title: 'EaseCutPro',
    icon: join(__dirname, '../../icons/icon.ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    },
    show: false
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('Renderer process gone:', details)
  })

  const url = process.env['ELECTRON_RENDERER_URL']
  console.log(`ELECTRON_RENDERER_URL: ${url || 'not set'}`)
  console.log(`__dirname: ${__dirname}`)

  if (url) {
    mainWindow.loadURL(url)
  } else {
    const filePath = join(__dirname, '../renderer/index.html')
    console.log(`Loading file: ${filePath}`)
    mainWindow.loadFile(filePath)
  }

  if (process.env['NODE_ENV'] === 'development') {
    mainWindow.webContents.openDevTools()
  }
}

function emitProgress(
  kind: 'probe' | 'transcribe' | 'silence' | 'export',
  jobId: string,
  percent: number,
  message?: string
): void {
  mainWindow?.webContents.send(IPC.progress, { jobId, kind, percent, message })
}

app.whenReady().then(() => {
  // Shared with the MCP server so Claude's edits show up in the editor.
  setProjectsDir(defaultProjectsRoot())

  // Warm up the Fast Cut model sidecar so its tiers stay loaded (best-effort).
  void startFastcutSidecar()

  // Stream local media files with proper HTTP Range support so the <video>
  // element can SEEK (skip cuts, scrub) without resetting to the start.
  protocol.handle('ecmedia', async (request) => {
    const url = new URL(request.url)
    const p = decodeURIComponent(url.searchParams.get('p') ?? '')
    if (!p) return new Response('Bad Request', { status: 400 })

    let size: number
    try {
      size = (await stat(p)).size
    } catch {
      return new Response('Not Found', { status: 404 })
    }

    const type = mimeForPath(p)
    const rangeHeader = request.headers.get('range') ?? request.headers.get('Range')

    if (rangeHeader) {
      const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
      let start = m && m[1] ? parseInt(m[1], 10) : 0
      let end = m && m[2] ? parseInt(m[2], 10) : size - 1
      if (!Number.isFinite(start) || start < 0) start = 0
      if (!Number.isFinite(end) || end >= size) end = size - 1
      if (start > end) start = 0
      const stream = createReadStream(p, { start, end })
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1)
        }
      })
    }

    const stream = createReadStream(p)
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
      status: 200,
      headers: {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(size)
      }
    })
  })

  // ---- Tool status ----
  ipcMain.handle(IPC.toolStatus, () => checkTools())

  // ---- Open file dialog ----
  ipcMain.handle(IPC.openMediaDialog, async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: 'Import video or audio',
      properties: ['openFile'],
      filters: [
        {
          name: 'Media',
          extensions: [
            'mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mp3', 'wav', 'm4a', 'aac',
            'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'
          ]
        },
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    return res.canceled ? null : res.filePaths[0]
  })

  // ---- Open file dialog (multi-select, for Batch Video Cleaner) ----
  ipcMain.handle(IPC.openMediaDialogMulti, async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: 'Add videos to batch clean',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (res.canceled) return []
    return res.filePaths.map((p) => ({ path: p, name: p.split(/[\\/]/).pop() ?? 'video' }))
  })

  // ---- Import every media file in a folder (natural-sorted) ----
  ipcMain.handle(IPC.importFolder, async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: 'Import all media from a folder',
      properties: ['openDirectory']
    })
    if (res.canceled || !res.filePaths[0]) return []
    const dir = res.filePaths[0]
    const MEDIA_RE = /\.(mp4|mov|mkv|webm|avi|m4v|mp3|wav|m4a|aac|png|jpe?g|webp|gif|bmp)$/i
    try {
      const names = (await readdir(dir))
        .filter((n) => MEDIA_RE.test(n))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
      return names.map((n) => ({ path: join(dir, n), name: n }))
    } catch {
      return []
    }
  })

  // ---- Combine montage clips into one base video ----
  ipcMain.handle(IPC.combineClips, async (_e, clips, audioOnly?: boolean) => {
    const jobId = randomUUID()
    const path = await combineClips(clips, (pct) => emitProgress('export', jobId, pct, 'Cut Lord is working…'), undefined, audioOnly)
    const info = await probe(path)
    return { path, duration: info.duration, width: info.width, height: info.height, fps: info.fps, hasAudio: info.hasAudio, hasVideo: info.hasVideo }
  })

  // ---- Probe ----
  ipcMain.handle(IPC.probe, async (_e, path: string) => probe(path))

  // ---- Transcribe (local whisper.cpp, or the OpenAI cloud backend) ----
  ipcMain.handle(IPC.transcribe, async (_e, path: string, backend?: TranscribeBackend, modelName?: string) => {
    const jobId = randomUUID()
    const onP = (pct: number, msg?: string): void => emitProgress('transcribe', jobId, pct, msg)
    if (backend === 'openai') return transcribeOpenAI(path, onP)
    if (modelName === 'parakeet') return transcribeParakeet(path, onP)
    return transcribe(path, onP, modelName)
  })

  // ---- Available local whisper models (for the model selector) ----
  ipcMain.handle(IPC.whisperModels, async () => listWhisperModels())

  // ---- AI cut suggestions (gpt-4o-mini) ----
  ipcMain.handle(IPC.suggestCuts, async (_e, transcript: Transcript) => {
    const jobId = randomUUID()
    return suggestCutsAI(transcript, (pct, msg) => emitProgress('transcribe', jobId, pct, msg))
  })

  // ---- Fast Cut (local Python heuristic+ML engine, no API) ----
  ipcMain.handle(IPC.fastCut, async (_e, transcript: Transcript, audioPath?: string, script?: string) => {
    const jobId = randomUUID()
    return fastCutSuggest(transcript, audioPath, script, (pct, msg) => emitProgress('transcribe', jobId, pct, msg))
  })

  // ---- CutCutPro: 4-phase premium pipeline (whisper+Parakeet+VAD -> Claude -> OpenAI listen -> EDL) ----
  ipcMain.handle(IPC.cutCutPro, async (_e, path: string, transcript: Transcript | null, modelName?: string, runVad?: boolean, script?: string) => {
    const jobId = randomUUID()
    return cutCutPro(path, transcript, modelName, runVad ?? true, script, (pct, msg) => emitProgress('transcribe', jobId, pct, msg))
  })

  // ---- Retake-Aware Cut Beta: separate experimental engine (cut_mode: retake_aware_beta) ----
  ipcMain.handle(IPC.retakeAwareCut, async (_e, path: string, silenceSettings?: RetakeBetaSilenceSettings) => {
    const jobId = randomUUID()
    return retakeAwareCut(path, (pct, msg) => emitProgress('transcribe', jobId, pct, msg), silenceSettings)
  })

  // ---- Smart Smooth Cut (beta): AI pause judge + debug dump ----
  ipcMain.handle(IPC.cutJudge, async (_e, payload) => judgeCuts(payload))
  ipcMain.handle(IPC.saveSmartCutDebug, async (_e, json: string) => {
    const dir = join(homedir(), '.easecutpro', 'smartsmooth')
    await mkdir(dir, { recursive: true })
    const p = join(dir, `debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    await writeFile(p, json, 'utf8')
    return p
  })

  // ---- AI overlay placement: rules + transcript -> overlay events ----
  ipcMain.handle(
    IPC.generateOverlays,
    async (
      _e,
      transcript: Transcript,
      assets: OverlayAsset[],
      rules: OverlayRule[],
      opts: { duration: number; cuts: { start: number; end: number }[] }
    ) => {
      const jobId = randomUUID()
      return generateOverlayTimeline(transcript, assets, rules, opts, (pct, msg) =>
        emitProgress('transcribe', jobId, pct, msg)
      )
    }
  )

  ipcMain.handle(
    IPC.suggestOverlays,
    async (
      _e,
      transcript: Transcript,
      assets: OverlayAsset[],
      opts: { duration: number; cuts: { start: number; end: number }[] }
    ) => {
      const jobId = randomUUID()
      return suggestOverlayTimeline(transcript, assets, opts, (pct, msg) =>
        emitProgress('transcribe', jobId, pct, msg)
      )
    }
  )

  // ---- OpenAI availability (is a key configured?) ----
  ipcMain.handle(IPC.openaiStatus, async () => ({ available: openaiAvailable() }))

  // ---- Silence detect ----
  ipcMain.handle(IPC.detectSilence, async (_e, path: string, opts: SilenceDetectOptions) => {
    const jobId = randomUUID()
    return detectSilence(path, opts, (pct) => emitProgress('silence', jobId, pct))
  })

  // ---- Waveform peaks ----
  ipcMain.handle(IPC.waveform, async (_e, path: string) => extractWaveform(path))

  // ---- Filmstrip thumbnails ----
  ipcMain.handle(IPC.thumbnails, async (_e, path: string, intervalSec?: number) =>
    extractThumbnails(path, intervalSec ?? 2)
  )

  // ---- Export ----
  ipcMain.handle(
    IPC.export,
    async (_e, project: Project, settings: ExportSettings, textOverlays?: TextOverlayImage[]) => {
      const res = await dialog.showSaveDialog(mainWindow!, {
        title: 'Export video',
        defaultPath: `${project.name || 'easecutpro-export'}.mp4`,
        filters: [{ name: 'MP4 video', extensions: ['mp4'] }]
      })
      if (res.canceled || !res.filePath) return null
      const jobId = randomUUID()
      return exportProject(project, res.filePath, settings, textOverlays, (pct) =>
        emitProgress('export', jobId, pct)
      )
    }
  )

  // ---- Save / Load project ----
  ipcMain.handle(IPC.saveProject, async (_e, project: Project) => {
    const res = await dialog.showSaveDialog(mainWindow!, {
      title: 'Save project',
      defaultPath: `${project.name || 'project'}.ecp.json`,
      filters: [{ name: 'EaseCutPro project', extensions: ['ecp.json', 'json'] }]
    })
    if (res.canceled || !res.filePath) return null
    await saveProject(res.filePath, project)
    return res.filePath
  })

  ipcMain.handle(IPC.loadProject, async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: 'Open project',
      properties: ['openFile'],
      filters: [{ name: 'EaseCutPro project', extensions: ['ecp.json', 'json'] }]
    })
    if (res.canceled) return null
    return loadProject(res.filePaths[0])
  })

  // ---- Project library (local, no login) ----
  ipcMain.handle(IPC.listProjects, () => listProjectRecords())
  ipcMain.handle(IPC.createProject, (_e, name: string, project: Project | null) =>
    createProjectRecord(name, project)
  )
  ipcMain.handle(IPC.getProject, (_e, id: string) => getProjectRecord(id))
  ipcMain.handle(
    IPC.saveProjectRecord,
    (_e, id: string, patch: { name?: string; project?: Project; thumb?: string }) =>
      saveProjectRecord(id, patch)
  )
  ipcMain.handle(IPC.deleteProjectRecord, (_e, id: string) => deleteProjectRecord(id))

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('will-quit', stopFastcutSidecar)
