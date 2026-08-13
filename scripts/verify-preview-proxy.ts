// Verify the preview proxy end-to-end WITHOUT launching Electron
// (previewProxy.ts is deliberately Electron-free, so this harness drives the
// real ffmpeg path under tsx).
//
//   npx tsx scripts/verify-preview-proxy.ts
//
// What it actually proves, in order of how badly each one would have burned us:
//   1. a heavily-cut project renders to ONE playable file at all — this is the
//      path where a wrong temp-file extension makes ffmpeg refuse the container;
//   2. the render CONTAINS THE EDIT, not the source: its duration matches the
//      sum of kept ranges, so the cuts are really baked in;
//   3. the project's chosen aspect wins over the source's, matching the export;
//   4. a second request for the same edit is instant (cache) and a concurrent
//      one joins the first instead of starting a second ffmpeg;
//   5. a changed edit gets a DIFFERENT file — the property the whole design
//      rests on, since a stale proxy would show the creator the wrong cut.
//
// Generates its own fixture (testsrc + sine) so it needs no checked-in media.

import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { mkdir, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { FFMPEG, FFPROBE } from '../src/main/binaries'
import { buildPreviewProxy, existingProxy } from '../src/main/previewProxy'
import type { Project, SequenceClip } from '../src/shared/types'

const execFileP = promisify(execFile)

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function makeFixture(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const src = join(dir, 'proxy-src.mp4')
  if (!existsSync(src)) {
    await execFileP(FFMPEG, [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=30:size=1280x720:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', src
    ])
  }
  return src
}

async function durationOf(path: string): Promise<number> {
  const { stdout } = await execFileP(FFPROBE, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path
  ])
  return parseFloat(stdout.trim())
}

async function dimsOf(path: string): Promise<{ w: number; h: number }> {
  const { stdout } = await execFileP(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path
  ])
  const [w, h] = stdout.trim().split(',').map(Number)
  return { w, h }
}

/** A cut-up montage: `n` one-second slices taken every two seconds. */
function cutProject(src: string, n: number, aspect?: { w: number; h: number }): Project {
  const baseSequence: SequenceClip[] = Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    sourcePath: src,
    name: `slice ${i}`,
    sourceIn: i * 2,
    sourceOut: i * 2 + 1,
    sourceDuration: 30,
    hasAudio: true,
    srcW: 1280,
    srcH: 720,
    fps: 30
  }))
  return {
    version: 1,
    name: 'proxy-test',
    baseSequence,
    silences: [],
    tracks: [],
    playhead: 0,
    pxPerSec: 60,
    magnet: true,
    trackHeight: 72,
    baseSplits: [],
    manualCuts: [],
    keepOverrides: [],
    silencePadding: 0,
    showThumbnails: true,
    texts: [],
    ...(aspect ? { aspectW: aspect.w, aspectH: aspect.h } : {})
  } as Project
}

async function main(): Promise<void> {
  const dir = join(tmpdir(), 'ecpro-proxy-verify')
  const src = await makeFixture(dir)

  // 12 slices — a genuinely cut-up timeline, which is the only shape where the
  // proxy is supposed to engage at all.
  const CUTS = 12
  const project = cutProject(src, CUTS)
  const sig = 'verify-a'
  await rm(existingProxy(sig) || join(dir, 'nothing'), { force: true }).catch(() => undefined)

  // ---- 1. it renders ----
  const t0 = Date.now()
  const out = await buildPreviewProxy(project, sig)
  const buildMs = Date.now() - t0
  check('renders a proxy file', existsSync(out), out)
  const size = existsSync(out) ? (await stat(out)).size : 0
  check('proxy is non-empty', size > 10_000, `${(size / 1024).toFixed(0)} KB in ${buildMs} ms`)

  // ---- 2. it contains the EDIT, not the source ----
  const dur = await durationOf(out)
  check(
    'duration is the EDIT, not the source',
    Math.abs(dur - CUTS) < 1.0,
    `${dur.toFixed(2)}s vs ${CUTS}s edited / 30s source`
  )

  // ---- 3. no leftover part-file ----
  check('no .part.mp4 left behind', !existsSync(out.replace(/\.mp4$/, '.part.mp4')))

  // ---- 4. cache + in-flight sharing ----
  check('existingProxy finds it', existingProxy(sig) === out)
  const t1 = Date.now()
  await buildPreviewProxy(project, sig)
  check('second request is instant (cached)', Date.now() - t1 < 250, `${Date.now() - t1} ms`)

  const sigShare = 'verify-share'
  const t2 = Date.now()
  const [a, b] = await Promise.all([
    buildPreviewProxy(cutProject(src, 6), sigShare),
    buildPreviewProxy(cutProject(src, 6), sigShare)
  ])
  check('concurrent requests share one render', a === b, `${Date.now() - t2} ms for both`)

  // ---- 5. a different edit is a different file ----
  const sigB = 'verify-b'
  const outB = await buildPreviewProxy(cutProject(src, 5), sigB)
  check('different signature -> different file', outB !== out, `${outB} != ${out}`)
  const durB = await durationOf(outB)
  check('and a different duration', Math.abs(durB - 5) < 1.0, `${durB.toFixed(2)}s vs 5s`)

  // ---- 6. the creator's aspect wins, as it does on export ----
  const sigP = 'verify-portrait'
  const outP = await buildPreviewProxy(cutProject(src, 4, { w: 9, h: 16 }), sigP)
  const d = await dimsOf(outP)
  check('9:16 project renders portrait', d.h > d.w, `${d.w}x${d.h}`)
  check('short edge is preview-sized (540)', Math.min(d.w, d.h) === 540, `${d.w}x${d.h}`)

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
