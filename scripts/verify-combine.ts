// Validate "Combine clips into one base": concatenates clips into a single file.
//   npx tsx scripts/verify-combine.ts <video1> <video2> [..]
import path from 'path'
import fs from 'fs'
import { probe, combineClips } from '../src/main/ffmpeg'
import type { SequenceClip } from '../src/shared/types'

const files = process.argv.slice(2)
if (files.length < 2) {
  console.error('Usage: tsx scripts/verify-combine.ts <video1> <video2> [..]')
  process.exit(1)
}

async function main(): Promise<void> {
  const clips: SequenceClip[] = []
  let sum = 0
  for (const f of files) {
    const info = await probe(f)
    const out = Math.min(5, info.duration || 5)
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
  }
  console.log(`Combining ${clips.length} clips (5s each) → expect ~${sum.toFixed(1)}s…`)
  const combined = await combineClips(clips, (p) => process.stdout.write(`\r  ${p}%     `))
  const info = await probe(combined)
  console.log(`\n  combined: ${info.duration.toFixed(1)}s · ${info.width}x${info.height} · audio=${info.hasAudio}`)
  console.log(`  → ${combined}`)
  if (Math.abs(info.duration - sum) > 1.5) console.log('  ⚠ duration mismatch')
  else console.log('  ✓ clips combined into one base video (ready to transcribe / edit as one)')
  fs.unlinkSync(combined)
}

main().catch((e) => {
  console.error('\nFAILED:', (e as Error)?.message ?? e)
  process.exit(1)
})
