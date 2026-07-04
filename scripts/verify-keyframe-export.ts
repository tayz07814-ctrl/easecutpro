// Validate the keyframe-driven ffmpeg export filter on a real video.
//   npx tsx scripts/verify-keyframe-export.ts "C:\vids1\some.mov"
import path from 'path'
import os from 'os'
import fs from 'fs'
import { probe, exportProject } from '../src/main/ffmpeg'
import { createEmptyProject } from '../src/shared/project'
import type { ZoomKeyframe } from '../src/shared/types'

const file = process.argv[2]
if (!file) {
  console.error('Usage: tsx scripts/verify-keyframe-export.ts "<video>"')
  process.exit(1)
}

async function main(): Promise<void> {
  const info = await probe(file)
  const dur = info.duration || 5
  const project = createEmptyProject(path.basename(file))
  project.media = {
    path: file,
    duration: dur,
    width: info.width,
    height: info.height,
    fps: info.fps,
    hasAudio: info.hasAudio,
    hasVideo: info.hasVideo
  }
  // Zoom in & pan toward top-right, drift to bottom-left, settle back to centre.
  const kfs: ZoomKeyframe[] = [
    { t: 0, zoom: 1.0, x: 0.5, y: 0.5, ease: 'inout' },
    { t: Math.min(1.2, dur * 0.3), zoom: 1.5, x: 0.75, y: 0.3, ease: 'inout' },
    { t: Math.min(2.5, dur * 0.6), zoom: 1.2, x: 0.3, y: 0.7, ease: 'inout' },
    { t: dur, zoom: 1.0, x: 0.5, y: 0.5, ease: 'out' }
  ]
  project.baseKeyframes = kfs

  const out = path.join(os.tmpdir(), `ec-kf-test-${Date.now()}.mp4`)
  console.log(`Exporting ${path.basename(file)} (${dur.toFixed(1)}s) with ${kfs.length} zoom/pan keyframes…`)
  await exportProject(project, out, { width: 720, height: 1280, bitrateMbps: 4 }, [], (p) =>
    process.stdout.write(`\r  export ${p}%      `)
  )
  const sz = fs.statSync(out).size
  console.log(`\n  ✓ wrote ${(sz / 1024 / 1024).toFixed(1)} MB — keyframe zoompan filter is valid and rendered`)
  fs.unlinkSync(out)
}

main().catch((e) => {
  console.error('\nEXPORT FAILED:', (e as Error)?.message ?? e)
  process.exit(1)
})
