// Verify EXPORT PROGRESS is monotonic, and that an export spawns a sane number
// of ffmpeg processes.
//
//   npx tsx scripts/verify-export-progress.ts
//
// The reported bug: "the bar climbs to 30-70% then starts from the beginning,
// forever". A progress value that goes BACKWARDS is the signature, so this
// harness records every value exportProject emits and fails on any decrease.
// It also samples the OS process table while the render runs, because the same
// report mentioned 4-7 ffmpeg processes swarming a low-end CPU.
//
// Runs the MONTAGE path on purpose: that one pre-concatenates the sequence
// (0-45%) and then re-runs the single-base pipeline (45-100%), so it is where
// a mis-mapped percentage would show up.

import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { mkdir, rm } from 'fs/promises'
import { tmpdir, platform } from 'os'
import { join } from 'path'
import { FFMPEG } from '../src/main/binaries'
import { exportProject } from '../src/main/ffmpeg'
import type { Project, SequenceClip } from '../src/shared/types'

const execFileP = promisify(execFile)

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function makeClip(path: string, seconds: number, colour: string): Promise<void> {
  if (existsSync(path)) return
  await execFileP(FFMPEG, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=640x360:rate=30`,
    '-f', 'lavfi', '-i', `sine=frequency=${colour}:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', path
  ])
}

function clip(id: string, sourcePath: string, dur: number): SequenceClip {
  return {
    id,
    sourcePath,
    name: id,
    sourceIn: 0,
    sourceOut: dur,
    sourceDuration: dur,
    hasAudio: true,
    srcW: 640,
    srcH: 360,
    fps: 30
  }
}

/** How many ffmpeg processes are alive right now. */
async function ffmpegCount(): Promise<number> {
  try {
    if (platform() === 'win32') {
      const { stdout } = await execFileP('tasklist', ['/FI', 'IMAGENAME eq ffmpeg.exe', '/NH'])
      return (stdout.match(/ffmpeg\.exe/gi) || []).length
    }
    const { stdout } = await execFileP('sh', ['-c', 'pgrep -c ffmpeg || true'])
    return Number(stdout.trim()) || 0
  } catch {
    return -1
  }
}

async function main(): Promise<void> {
  const dir = join(tmpdir(), 'easecut-verify-export')
  await mkdir(dir, { recursive: true })
  const a = join(dir, 'exp-a.mp4')
  const b = join(dir, 'exp-b.mp4')
  await makeClip(a, 4, '440')
  await makeClip(b, 4, '660')

  const project = {
    name: 'progress-check',
    media: undefined,
    baseSequence: [clip('a', a, 4), clip('b', b, 4)],
    tracks: [],
    texts: [],
    silences: [],
    baseSplits: [],
    manualCuts: [],
    keepOverrides: [],
    transcript: undefined
  } as unknown as Project

  const out = join(dir, 'out.mp4')
  await rm(out, { force: true })

  const seen: number[] = []
  let peakFfmpeg = 0
  const sampler = setInterval(() => {
    void ffmpegCount().then((n) => {
      if (n > peakFfmpeg) peakFfmpeg = n
    })
  }, 250)

  await exportProject(project, out, { width: 640, height: 360, bitrateMbps: 4 }, undefined, (pct) => seen.push(pct))
  clearInterval(sampler)

  console.log(`progress values (${seen.length}): ${seen.join(' ')}`)

  check('export produced a file', existsSync(out), out)
  check('progress was reported', seen.length > 0, `${seen.length} updates`)

  // THE regression: any decrease means the bar restarted mid-export.
  const drops: string[] = []
  for (let i = 1; i < seen.length; i++) {
    if (seen[i] < seen[i - 1]) drops.push(`${seen[i - 1]}→${seen[i]}`)
  }
  check('progress never goes backwards', drops.length === 0, drops.length ? drops.join(', ') : 'monotonic')

  check('progress stays within 0..100', seen.every((p) => p >= 0 && p <= 100), `max ${Math.max(...seen)}`)
  check('progress reaches a high-water mark', Math.max(...seen) >= 90, `max ${Math.max(...seen)}`)
  // One export should not put a pile of encoders on the machine at once.
  check('concurrent ffmpeg stayed sane', peakFfmpeg <= 2, `peak ${peakFfmpeg}`)

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall green')
  process.exit(failures ? 1 : 0)
}

void main().catch((e) => {
  console.error('harness crashed:', e)
  process.exit(1)
})
