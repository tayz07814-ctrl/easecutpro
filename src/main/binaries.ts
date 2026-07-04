import { existsSync, readdirSync } from 'fs'
import { join, dirname, basename } from 'path'
import type { WhisperModelInfo } from '../shared/types'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileP = promisify(execFile)

/**
 * Resolves external tool binaries. Order of preference:
 *  1. bundled resources/bin (shipped with the packaged app)
 *  2. system PATH
 * Whisper binary + model are optional; if absent the app falls back to a stub.
 *
 * Deliberately free of any Electron import so this module (and the ffmpeg /
 * whisper modules that depend on it) can be reused by the standalone web
 * server. `process.resourcesPath` is set by Electron when packaged; in the
 * dev Electron run and in the server, the cwd/__dirname candidates apply.
 */

/** __dirname when available (Electron main bundle / CJS); null in pure ESM. */
function thisDir(): string | null {
  try {
    return typeof __dirname !== 'undefined' ? __dirname : null
  } catch {
    return null
  }
}

function resourcesBinDir(): string {
  const candidates: string[] = []
  if (process.resourcesPath) {
    // electron-builder + electron-packager packaged layouts
    candidates.push(
      join(process.resourcesPath, 'bin'),
      join(process.resourcesPath, 'app', 'resources', 'bin')
    )
  }
  const dir = thisDir()
  if (dir) candidates.push(join(dir, '..', '..', 'resources', 'bin'))
  // dev Electron + standalone server (run from the project root)
  candidates.push(join(process.cwd(), 'resources', 'bin'))
  for (const c of candidates) if (existsSync(c)) return c
  return candidates[candidates.length - 1]
}

const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name)

function resolve(name: string): string {
  const bundled = join(resourcesBinDir(), exe(name))
  if (existsSync(bundled)) return bundled
  return exe(name) // fall back to PATH
}

export const FFMPEG = resolve('ffmpeg')
export const FFPROBE = resolve('ffprobe')

/** whisper.cpp CLI is distributed under a few names depending on version. */
function resolveWhisper(): string | null {
  const candidates = ['whisper-cli', 'whisper', 'main']
  for (const c of candidates) {
    const bundled = join(resourcesBinDir(), exe(c))
    if (existsSync(bundled)) return bundled
  }
  return null
}

export const WHISPER_BIN = resolveWhisper()

/** whisper.cpp's Silero-VAD speech-segments tool (for speech-aware silence removal). */
function resolveVadBin(): string | null {
  const bundled = join(resourcesBinDir(), exe('whisper-vad-speech-segments'))
  return existsSync(bundled) ? bundled : null
}
export const WHISPER_VAD_BIN = resolveVadBin()

/** Find the Silero VAD ggml model (ggml-silero-*.bin) in resources/models or resources/bin. */
export function resolveVadModel(): string | null {
  const dirs = [join(dirname(resourcesBinDir()), 'models'), resourcesBinDir()]
  for (const d of dirs) {
    if (!existsSync(d)) continue
    let files: string[] = []
    try {
      files = readdirSync(d)
    } catch {
      continue
    }
    for (const f of files) if (/\.bin$/i.test(f) && /silero|vad/i.test(f)) return join(d, f)
  }
  return null
}

/** Rank a ggml model filename by accuracy (higher = better) to pick the best. */
function modelRank(name: string): number {
  const n = name.toLowerCase()
  if (n.includes('large')) return n.includes('turbo') ? 5 : 6
  if (n.includes('medium')) return 4
  if (n.includes('small')) return 3
  if (n.includes('base')) return 2
  if (n.includes('tiny')) return 1
  return 0
}

/**
 * Find the best available ggml-*.bin model in resources/models or resources/bin.
 * Scans the directories so newly-added models (large, turbo, etc.) are picked up
 * automatically, preferring the most accurate one present.
 */
export function resolveWhisperModel(): string | null {
  const dirs = [join(dirname(resourcesBinDir()), 'models'), resourcesBinDir()]
  let best: { path: string; rank: number } | null = null
  for (const d of dirs) {
    if (!existsSync(d)) continue
    let files: string[] = []
    try {
      files = readdirSync(d)
    } catch {
      continue
    }
    for (const f of files) {
      // Exclude the Silero VAD model — it's not a transcription model.
      if (/^ggml-.*\.bin$/i.test(f) && !/silero|vad/i.test(f)) {
        const rank = modelRank(f)
        if (!best || rank > best.rank) best = { path: join(d, f), rank }
      }
    }
  }
  return best?.path ?? null
}

/** "ggml-large-v3.bin" -> "large-v3" (stable model id). */
function modelNameFromFile(f: string): string {
  return f.replace(/^ggml-/i, '').replace(/\.bin$/i, '')
}

const isWhisperModelFile = (f: string): boolean =>
  /^ggml-.*\.bin$/i.test(f) && !/silero|vad/i.test(f)

const whisperModelDirs = (): string[] => [join(dirname(resourcesBinDir()), 'models'), resourcesBinDir()]

/** List the local whisper.cpp models present (for the model selector). */
export function listWhisperModels(): WhisperModelInfo[] {
  const found = new Map<string, number>() // name -> rank
  for (const d of whisperModelDirs()) {
    if (!existsSync(d)) continue
    let files: string[] = []
    try {
      files = readdirSync(d)
    } catch {
      continue
    }
    for (const f of files) {
      if (isWhisperModelFile(f)) {
        const name = modelNameFromFile(f)
        if (!found.has(name)) found.set(name, modelRank(f))
      }
    }
  }
  const best = resolveWhisperModel()
  const bestName = best ? modelNameFromFile(basename(best)) : null
  const models: WhisperModelInfo[] = [...found.entries()]
    .sort((a, b) => b[1] - a[1]) // most accurate first
    .map(([name]) => ({ name, label: name, best: name === bestName }))
  // Parakeet is a separate (non-whisper) engine — list it too when downloaded.
  if (resolveParakeetModel()) models.push({ name: 'parakeet', label: 'Parakeet (English · faster, lower error)', best: false })
  return models
}

/** Resolve the Parakeet (sherpa-onnx) model directory if all files are present. */
export function resolveParakeetModel(): string | null {
  const need = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']
  for (const base of whisperModelDirs()) {
    const dir = join(base, 'parakeet')
    if (existsSync(dir) && need.every((f) => existsSync(join(dir, f)))) return dir
  }
  return null
}

/** Resolve a whisper model by its name ("large-v3"); null if not found. */
export function resolveWhisperModelByName(name: string): string | null {
  if (!name) return null
  for (const d of whisperModelDirs()) {
    if (!existsSync(d)) continue
    let files: string[] = []
    try {
      files = readdirSync(d)
    } catch {
      continue
    }
    for (const f of files) {
      if (isWhisperModelFile(f) && modelNameFromFile(f) === name) return join(d, f)
    }
  }
  return null
}

export interface ToolStatus {
  ffmpeg: boolean
  ffprobe: boolean
  whisper: boolean
  whisperModel: boolean
}

export async function checkTools(): Promise<ToolStatus> {
  const ok = async (bin: string): Promise<boolean> => {
    try {
      await execFileP(bin, ['-version'], { timeout: 5000 })
      return true
    } catch {
      return false
    }
  }
  return {
    ffmpeg: await ok(FFMPEG),
    ffprobe: await ok(FFPROBE),
    whisper: WHISPER_BIN != null,
    whisperModel: resolveWhisperModel() != null
  }
}
