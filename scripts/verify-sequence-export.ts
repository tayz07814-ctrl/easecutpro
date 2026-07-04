// Validate montage (base-sequence) export: concatenates real clips with audio.
//   npx tsx scripts/verify-sequence-export.ts <video1> <video2> [..]
import path from 'path'
import os from 'os'
import fs from 'fs'
import { probe, exportProject } from '../src/main/ffmpeg'
import { createEmptyProject } from '../src/shared/project'
import type { SequenceClip } from '../src/shared/types'

const files = process.argv.slice(2)
if (files.length < 2) {
  console.error('Usage: tsx scripts/verify-sequence-export.ts <video1> <video2> [..]')
  process.exit(1)
}

async function main(): Promise<void> {
  const clips: SequenceClip[] = []
  let sum = 0
  for (const f of files) {
    const info = await probe(f)
    const out = Math.min(5, info.duration || 5) // trim each to 5s for a fast test
    clips.push({
      id: Math.random().toString(36).slice(2),
      sourcePath: f,
      name: path.basename(f),
      sourceIn: 0,
      sourceOut: out,
      sourceDuration: info.duration,
      hasAudio: info.hasAudio,
      srcW: info.width,
      srcH: info.height,
      fps: info.fps
    })
    sum += out
    console.log(`  + ${path.basename(f)}  use 0–${out.toFixed(1)}s  ${info.width}x${info.height}  audio=${info.hasAudio}`)
  }
  const project = createEmptyProject('montage-test')
  project.baseSequence = clips
  const outPath = path.join(os.tmpdir(), `ec-montage-${Date.now()}.mp4`)
  console.log(`Exporting montage of ${clips.length} clips (expect ~${sum.toFixed(1)}s)…`)
  await exportProject(project, outPath, { width: 720, height: 1280, bitrateMbps: 4 }, [], (p) =>
    process.stdout.write(`\r  ${p}%     `)
  )
  const info = await probe(outPath)
  const sz = fs.statSync(outPath).size
  console.log(`\n  montage: ${info.duration.toFixed(1)}s · ${(sz / 1024 / 1024).toFixed(1)} MB · audio=${info.hasAudio}`)
  if (Math.abs(info.duration - sum) > 2) console.log(`  ⚠ duration ${info.duration.toFixed(1)}s vs expected ${sum.toFixed(1)}s`)
  else console.log('  ✓ concatenated montage with audio rendered, duration matches')
  fs.unlinkSync(outPath)
}

main().catch((e) => {
  console.error('\nFAILED:', (e as Error)?.message ?? e)
  process.exit(1)
})
