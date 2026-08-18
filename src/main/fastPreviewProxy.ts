import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'fs/promises'
import { FFMPEG } from './binaries'
import { runGatedLowPriority } from './ffmpeg'
import { computeKeepRanges, virtualKeepsToClipSegments } from '../shared/edit'
import type { Project, SequenceClip } from '../shared/types'

const execFileP = promisify(execFile)
const SOURCE_CACHE_DIR = join(homedir(), '.easecutpro', 'cache', 'preview-sources')
const SOURCE_CACHE_KEEP = 24

export interface FastPreviewSettings {
  shortEdge: number
  bitrateMbps: number
}

interface Encoder {
  name: 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'libx264'
  args: string[]
}

interface FastRunResult {
  speed: number
  wallMs: number
  cpuTimeMs: number
}

interface PreviewSegment {
  sourcePath: string
  in: number
  out: number
  hasAudio: boolean
  isImage?: boolean
  speed?: number
  gain?: number
  size?: number
  zoomStart?: number
  zoomEnd?: number
  panX?: number
  panY?: number
}

let encoderPromise: Promise<Encoder> | null = null

function abortError(): Error {
  const e = new Error('preview proxy cancelled')
  e.name = 'AbortError'
  return e
}

function isAbortError(e: unknown): boolean {
  return (e as { name?: string })?.name === 'AbortError'
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

async function canUseEncoder(name: string): Promise<boolean> {
  try {
    await execFileP(FFMPEG, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=1',
      '-frames:v', '1', '-an', '-c:v', name, '-f', 'null', '-'
    ], { maxBuffer: 1024 * 1024 })
    return true
  } catch {
    return false
  }
}

/** Probe hardware encoders once per process, in the requested Windows order. */
async function selectEncoder(): Promise<Encoder> {
  if (encoderPromise) return encoderPromise
  encoderPromise = (async () => {
    if (process.platform === 'win32') {
      for (const name of ['h264_nvenc', 'h264_qsv', 'h264_amf'] as const) {
        if (await canUseEncoder(name)) {
          console.info('[preview-proxy] encoderUsed:', name)
          return { name, args: encoderArgs(name) }
        }
      }
    }
    console.info('[preview-proxy] encoderUsed: libx264 ultrafast')
    return { name: 'libx264', args: encoderArgs('libx264') }
  })()
  return encoderPromise
}

function encoderArgs(name: Encoder['name']): string[] {
  if (name === 'h264_nvenc') return ['-c:v', name, '-preset', 'p1', '-tune', 'll', '-rc', 'vbr']
  if (name === 'h264_qsv') return ['-c:v', name, '-preset', 'veryfast']
  if (name === 'h264_amf') return ['-c:v', name, '-quality', 'speed']
  return ['-c:v', name, '-preset', 'ultrafast', '-tune', 'zerolatency', '-threads', '2']
}

function bitrateArgs(mbps: number): string[] {
  const b = `${Math.max(0.6, mbps).toFixed(2)}M`
  return ['-b:v', b, '-maxrate', b, '-bufsize', `${Math.max(1.2, mbps * 2).toFixed(2)}M`]
}

async function fileUsable(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 1024
  } catch {
    return false
  }
}

async function sourceKey(path: string, profile: string): Promise<string> {
  try {
    const s = await stat(path)
    return `${path}|${s.size}|${Math.round(s.mtimeMs)}|${profile}`
  } catch {
    return `${path}|?|${profile}`
  }
}

function sourceCachePath(key: string): string {
  return join(SOURCE_CACHE_DIR, `${createHash('sha1').update(key).digest('hex')}.mp4`)
}

async function pruneSourceCache(): Promise<void> {
  try {
    const names = (await readdir(SOURCE_CACHE_DIR)).filter((n) => n.endsWith('.mp4') && !n.endsWith('.part.mp4'))
    if (names.length <= SOURCE_CACHE_KEEP) return
    const ordered = await Promise.all(names.map(async (n) => ({ n, t: (await stat(join(SOURCE_CACHE_DIR, n))).mtimeMs })))
    ordered.sort((a, b) => a.t - b.t)
    for (const { n } of ordered.slice(0, ordered.length - SOURCE_CACHE_KEEP)) {
      await rm(join(SOURCE_CACHE_DIR, n)).catch(() => undefined)
    }
  } catch {
    /* disposable cache pruning is best effort */
  }
}

function scaleFilter(shortEdge: number): string {
  const edge = Math.max(240, Math.round(shortEdge))
  return `scale=w='if(gte(iw,ih),-2,${edge})':h='if(gte(iw,ih),${edge},-2)'`
}

function runFastFfmpeg(
  args: string[],
  totalDur: number,
  onProgress: (pct: number, speed: number) => void,
  signal?: AbortSignal
): Promise<FastRunResult> {
  return runGatedLowPriority(() => new Promise<FastRunResult>((resolve, reject) => {
    assertNotAborted(signal)
    const started = Date.now()
    const cpuStarted = process.cpuUsage()
    const proc = spawn(FFMPEG, ['-hide_banner', '-nostats', '-progress', 'pipe:2', ...args])
    let err = ''
    let speed = 0
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (e?: Error): void => {
      if (settled) return
      settled = true
      if (killTimer) clearTimeout(killTimer)
      signal?.removeEventListener('abort', cancel)
      if (e) reject(e)
      else {
        const cpu = process.cpuUsage(cpuStarted)
        resolve({ speed, wallMs: Date.now() - started, cpuTimeMs: (cpu.user + cpu.system) / 1000 })
      }
    }
    const cancel = (): void => {
      if (settled) return
      proc.kill()
      killTimer = setTimeout(() => proc.kill(), 500)
      finish(abortError())
    }
    if (signal?.aborted) {
      cancel()
      return
    }
    signal?.addEventListener('abort', cancel, { once: true })
    proc.stderr.on('data', (data: Buffer) => {
      const text = data.toString()
      err += text
      const time = /out_time_ms=(\d+)/.exec(text)
      const rate = /speed=([\d.]+)x/.exec(text)
      if (rate) speed = Number(rate[1]) || speed
      if (time && totalDur > 0) {
        const t = Number(time[1]) / 1_000_000
        onProgress(Math.min(100, Math.round((t / totalDur) * 100)), speed)
      }
    })
    proc.on('error', (e) => finish(e))
    proc.on('close', (code) => {
      if (settled) return
      if (signal?.aborted) finish(abortError())
      else if (code === 0) {
        onProgress(100, speed)
        finish()
      } else finish(new Error(`preview ffmpeg exited ${code}: ${err.slice(-1000)}`))
    })
  }), signal)
}

async function buildNormalizedSource(
  sourcePath: string,
  duration: number,
  settings: FastPreviewSettings,
  encoder: Encoder,
  signal: AbortSignal | undefined,
  onProgress: (pct: number, speed: number) => void
): Promise<string> {
  const profile = `h264-${encoder.name}-${settings.shortEdge}-${settings.bitrateMbps.toFixed(2)}-30-v1`
  const key = await sourceKey(sourcePath, profile)
  const out = sourceCachePath(key)
  if (await fileUsable(out)) {
    console.info('[preview-proxy] sourceCacheHit:', sourcePath)
    return out
  }
  console.info('[preview-proxy] sourceCacheMiss:', sourcePath)
  await mkdir(SOURCE_CACHE_DIR, { recursive: true })
  const part = out.replace(/\.mp4$/, '.part.mp4')
  await rm(part).catch(() => undefined)
  try {
    await runFastFfmpeg([
      '-y', '-i', sourcePath,
      '-map', '0:v:0?', '-map', '0:a:0?',
      '-vf', `${scaleFilter(settings.shortEdge)},fps=30,format=yuv420p`,
      ...encoder.args,
      ...bitrateArgs(settings.bitrateMbps),
      '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-ac', '2',
      part
    ], duration, onProgress, signal)
    assertNotAborted(signal)
    await rename(part, out)
    void pruneSourceCache()
    return out
  } catch (e) {
    await rm(part).catch(() => undefined)
    throw e
  }
}

function identityEffects(project: Project): boolean {
  return (project.baseSequence ?? []).every((c) =>
    !c.isImage &&
    Math.abs((c.speed ?? 1) - 1) < 0.001 &&
    Math.abs((c.gain ?? 1) - 1) < 0.001 &&
    Math.abs((c.size ?? 1) - 1) < 0.001 &&
    Math.abs((c.zoomStart ?? 1) - 1) < 0.001 &&
    Math.abs((c.zoomEnd ?? 1) - 1) < 0.001 &&
    Math.abs(c.panX ?? 0) < 0.001 &&
    Math.abs(c.panY ?? 0) < 0.001
  )
}

function atempoChain(speed: number): string {
  if (Math.abs(speed - 1) < 0.001) return ''
  const parts: string[] = []
  let n = speed
  while (n > 2) { parts.push('atempo=2'); n /= 2 }
  while (n < 0.5) { parts.push('atempo=0.5'); n /= 0.5 }
  parts.push(`atempo=${n.toFixed(6)}`)
  return `,${parts.join(',')}`
}

function transformChain(s: PreviewSegment, w: number, h: number): string {
  const size = s.size ?? 1
  const zoom = Math.max(1, s.zoomStart ?? 1)
  const panX = Math.max(-0.5, Math.min(0.5, s.panX ?? 0))
  const panY = Math.max(-0.5, Math.min(0.5, s.panY ?? 0))
  if (Math.abs(size - 1) < 0.001 && Math.abs(zoom - 1) < 0.001 && Math.abs(panX) < 0.001 && Math.abs(panY) < 0.001) return ''
  const scale = size * zoom
  if (scale >= 1) {
    const fx = Math.max(0, Math.min(1, 0.5 + panX))
    const fy = Math.max(0, Math.min(1, 0.5 + panY))
    return `,scale=${Math.round(w * scale)}:${Math.round(h * scale)},crop=${w}:${h}:${Math.round(w * (scale - 1) * fx)}:${Math.round(h * (scale - 1) * fy)}`
  }
  const sw = Math.max(2, Math.round(w * scale))
  const sh = Math.max(2, Math.round(h * scale))
  return `,scale=${sw}:${sh},pad=${w}:${h}:${Math.round((w - sw) * (0.5 + panX))}:${Math.round((h - sh) * (0.5 + panY))}:color=black`
}

function segmentsFor(project: Project): PreviewSegment[] {
  const keeps = computeKeepRanges(project)
  if (project.media) {
    return keeps.map((k) => ({ sourcePath: project.media!.path, in: k.start, out: k.end, hasAudio: project.media!.hasAudio }))
  }
  const byId = new Map<string, SequenceClip>((project.baseSequence ?? []).map((c) => [c.id, c]))
  return virtualKeepsToClipSegments(project, keeps).map((s) => {
    const c = byId.get(s.clipId)
    return {
      sourcePath: s.sourcePath,
      in: s.in,
      out: s.out,
      hasAudio: s.hasAudio,
      isImage: s.isImage,
      speed: c?.speed,
      gain: c?.gain,
      size: c?.size,
      zoomStart: c?.zoomStart,
      zoomEnd: c?.zoomEnd,
      panX: c?.panX,
      panY: c?.panY
    }
  })
}

function dimensions(project: Project, shortEdge: number): { w: number; h: number } {
  const sw = project.media?.width || project.baseSequence?.[0]?.srcW || 1920
  const sh = project.media?.height || project.baseSequence?.[0]?.srcH || 1080
  const aspect = project.aspectW && project.aspectH ? project.aspectW / project.aspectH : sw / sh
  const w = aspect > 1 ? Math.round(shortEdge * aspect) : shortEdge
  const h = aspect > 1 ? shortEdge : Math.round(shortEdge / aspect)
  return { w: Math.max(2, w - (w % 2)), h: Math.max(2, h - (h % 2)) }
}

async function filterScript(fc: string): Promise<{ args: string[]; file: string }> {
  if (fc.length <= 6000) return { args: ['-filter_complex', fc], file: '' }
  await mkdir(SOURCE_CACHE_DIR, { recursive: true })
  const file = join(SOURCE_CACHE_DIR, `preview-filter-${Date.now()}.txt`)
  await writeFile(file, fc, 'utf8')
  return { args: ['-filter_complex_script', file], file }
}

async function renderSegments(
  segments: PreviewSegment[],
  sourcePaths: Map<string, string>,
  project: Project,
  settings: FastPreviewSettings,
  encoder: Encoder,
  output: string,
  signal: AbortSignal | undefined,
  onProgress: (pct: number, speed: number) => void
): Promise<{ duration: number; run: FastRunResult }> {
  const d = dimensions(project, settings.shortEdge)
  const inputs: string[] = []
  const filters: string[] = []
  const order: string[] = []
  let inputIndex = 0
  let duration = 0
  for (let i = 0; i < segments.length; i++) {
    assertNotAborted(signal)
    const s = segments[i]
    const path = sourcePaths.get(s.sourcePath) ?? s.sourcePath
    const speed = s.speed && s.speed > 0 ? s.speed : 1
    const span = Math.max(0.05, (s.out - s.in) / speed)
    duration += span
    const vi = inputIndex++
    if (s.isImage) inputs.push('-loop', '1', '-t', span.toFixed(3), '-i', path)
    else inputs.push('-i', path)
    const start = s.isImage ? 0 : Math.max(0, s.in)
    const end = s.isImage ? span : Math.max(start + 0.05, s.out)
    const vpts = Math.abs(speed - 1) > 0.001 ? `,setpts=PTS/${speed.toFixed(6)}` : ''
    filters.push(
      `[${vi}:v]trim=start=${start.toFixed(3)}:end=${end.toFixed(3)},setpts=PTS-STARTPTS,` +
      `scale=${d.w}:${d.h}:force_original_aspect_ratio=decrease,pad=${d.w}:${d.h}:(ow-iw)/2:(oh-ih)/2,` +
      `fps=30,format=yuv420p${transformChain(s, d.w, d.h)}${vpts},` +
      `tpad=stop=-1:stop_mode=clone,trim=duration=${span.toFixed(6)},setpts=PTS-STARTPTS[v${i}]`
    )
    let ai = vi
    if (!s.hasAudio || s.isImage) {
      ai = inputIndex++
      inputs.push('-f', 'lavfi', '-t', span.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
      filters.push(`[${ai}:a]apad,atrim=duration=${span.toFixed(6)},asetpts=PTS-STARTPTS[a${i}]`)
    } else {
      const gain = Math.abs((s.gain ?? 1) - 1) > 0.001 ? `,volume=${Math.max(0, s.gain ?? 1).toFixed(6)}` : ''
      filters.push(
        `[${vi}:a]atrim=start=${start.toFixed(3)}:end=${end.toFixed(3)},asetpts=PTS-STARTPTS${gain},` +
        `aresample=async=1${atempoChain(speed)},apad,atrim=duration=${span.toFixed(6)},asetpts=PTS-STARTPTS[a${i}]`
      )
    }
    order.push(`[v${i}][a${i}]`)
  }
  const fc = `${filters.join(';')};${order.join('')}concat=n=${segments.length}:v=1:a=1[outv][outa]`
  const script = await filterScript(fc)
  try {
    const run = await runFastFfmpeg([
      '-y', ...inputs, ...script.args,
      '-map', '[outv]', '-map', '[outa]',
      ...encoder.args, ...bitrateArgs(settings.bitrateMbps),
      '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '96k',
      '-movflags', '+faststart', output
    ], duration, onProgress, signal)
    return { duration, run }
  } finally {
    if (script.file) await rm(script.file).catch(() => undefined)
  }
}

/** Dedicated disposable renderer for preview proxies. It never calls exportProject. */
export async function buildFastPreviewProxy(
  project: Project,
  output: string,
  settings: FastPreviewSettings,
  onProgress: (pct: number) => void,
  signal?: AbortSignal
): Promise<string> {
  const started = Date.now()
  const cpuStarted = process.cpuUsage()
  let firstProgress = 0
  let lastSpeed = 0
  const progress = (pct: number, speed: number): void => {
    if (!firstProgress && pct > 0) firstProgress = Date.now()
    lastSpeed = speed || lastSpeed
    onProgress(Math.min(100, Math.max(0, pct)))
  }
  console.info('[preview-proxy] proxyBuildStart', { output, settings })
  try {
    const encoder = await selectEncoder()
    const segments = segmentsFor(project)
    if (!segments.length) throw new Error('Nothing to preview after cuts')
    const simple = !project.baseSequence?.length || identityEffects(project)
    const sources = new Map<string, string>()
    if (simple) {
      const unique = [...new Set(segments.filter((s) => !s.isImage).map((s) => s.sourcePath))]
      const total = unique.length || 1
      let done = 0
      for (const source of unique) {
        const duration = project.media?.duration ?? project.baseSequence?.find((c) => c.sourcePath === source)?.sourceDuration ?? 0
        const cached = await buildNormalizedSource(source, duration, settings, encoder, signal, (p, speed) => progress(Math.round((done + p / 100) / total * 35), speed))
        sources.set(source, cached)
        done++
      }
    }
    assertNotAborted(signal)
    const rendered = await renderSegments(segments, sources, project, settings, encoder, output, signal, (p, speed) => progress(35 + Math.round(p * 0.65), speed))
    const cpu = process.cpuUsage(cpuStarted)
    const metrics = {
      proxyBuildStart: new Date(started).toISOString(),
      proxyBuildEnd: new Date().toISOString(),
      encoderUsed: encoder.name,
      encodeSpeed: lastSpeed,
      cpuTime: (cpu.user + cpu.system) / 1000,
      outputDuration: rendered.duration,
      proxyStartupLatency: firstProgress ? firstProgress - started : Date.now() - started
    }
    console.info('[preview-proxy] proxyBuildEnd', metrics)
    return output
  } catch (e) {
    console.warn('[preview-proxy] proxyBuildEnd', {
      status: isAbortError(e) ? 'cancelled' : 'failed',
      wallMs: Date.now() - started,
      cpuTime: (() => {
        const cpu = process.cpuUsage(cpuStarted)
        return (cpu.user + cpu.system) / 1000
      })(),
      error: isAbortError(e) ? undefined : String((e as Error)?.message ?? e)
    })
    throw e
  }
}
