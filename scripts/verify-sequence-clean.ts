// Validate per-clip cleaning in a montage: clip 1 has a mid-clip cut, so the
// rendered montage = (clip1 minus the cut) + clip2.
//   npx tsx scripts/verify-sequence-clean.ts <video1> <video2>
import path from 'path'
import os from 'os'
import fs from 'fs'
import { probe, exportProject } from '../src/main/ffmpeg'
import { createEmptyProject } from '../src/shared/project'
import type { SequenceClip } from '../src/shared/types'

const files = process.argv.slice(2)
if (files.length < 2) {
  console.error('Usage: tsx scripts/verify-sequence-clean.ts <video1> <video2>')
  process.exit(1)
}

async function main(): Promise<void> {
  const i0 = await probe(files[0])
  const i1 = await probe(files[1])
  const clip1: SequenceClip = {
    id: 'c1', sourcePath: files[0], name: path.basename(files[0]),
    sourceIn: 0, sourceOut: 6, sourceDuration: i0.duration, hasAudio: i0.hasAudio, srcW: i0.width, srcH: i0.height, fps: i0.fps,
    manualCuts: [{ start: 1, end: 3 }] // cut 2s out of the middle (simulates cleaning)
  }
  const clip2: SequenceClip = {
    id: 'c2', sourcePath: files[1], name: path.basename(files[1]),
    sourceIn: 0, sourceOut: 5, sourceDuration: i1.duration, hasAudio: i1.hasAudio, srcW: i1.width, srcH: i1.height, fps: i1.fps
  }
  const expected = (6 - 2) + 5 // clip1 kept = [0-1]+[3-6] = 4s, clip2 = 5s
  const project = createEmptyProject('montage-clean-test')
  project.baseSequence = [clip1, clip2]
  const out = path.join(os.tmpdir(), `ec-clean-${Date.now()}.mp4`)
  console.log(`clip1 0–6s with cut 1–3s (keep 4s) + clip2 0–5s  →  expect ~${expected}s`)
  await exportProject(project, out, { width: 720, height: 1280, bitrateMbps: 4 }, [], (p) =>
    process.stdout.write(`\r  ${p}%     `)
  )
  const info = await probe(out)
  console.log(`\n  montage: ${info.duration.toFixed(1)}s · audio=${info.hasAudio}`)
  if (Math.abs(info.duration - expected) > 1.5) console.log(`  ⚠ ${info.duration.toFixed(1)}s vs expected ${expected}s`)
  else console.log(`  ✓ per-clip cut applied before concat — montage trimmed to the kept ranges`)
  fs.unlinkSync(out)
}

main().catch((e) => {
  console.error('\nFAILED:', (e as Error)?.message ?? e)
  process.exit(1)
})
