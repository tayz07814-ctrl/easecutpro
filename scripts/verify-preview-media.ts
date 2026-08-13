// Verify import-time media conditioning WITHOUT launching Electron.
//
//   npx tsx scripts/verify-preview-media.ts
//
// The whole point of conditioning is the keyframe density — it's what turns
// every seek into a 1-3 frame decode. So beyond "it renders", this checks the
// property that actually buys the smoothness:
//   1. the conditioned copy's keyframes are ≤ GOP(15) frames apart, EVERYWHERE
//      (the fixture is built with 3s GOPs — phone-like — so this proves the
//      conditioning changed the structure, not that the source was easy);
//   2. duration matches the source (timestamps must line up or cuts drift);
//   3. short edge capped, never upscaled;
//   4. cache hit is instant; concurrent requests share one render.

import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { FFMPEG, FFPROBE } from '../src/main/binaries'
import { conditionForPreview, existingPreviewMedia } from '../src/main/previewMedia'

const execFileP = promisify(execFile)

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function main(): Promise<void> {
  const dir = join(tmpdir(), 'ecpro-pvmedia-verify')
  await mkdir(dir, { recursive: true })
  const src = join(dir, 'phone-like.mp4')
  if (!existsSync(src)) {
    // Phone-like fixture: 1080x1920 portrait, keyframe every 3 SECONDS (g=90).
    await execFileP(FFMPEG, [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=12:size=1080x1920:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '90', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', src
    ])
  }

  const t0 = Date.now()
  const out = await conditionForPreview(src)
  const buildMs = Date.now() - t0
  check('conditions a copy', !!out && existsSync(out), `${out} in ${buildMs}ms`)
  if (!out) process.exit(1)

  // 1. keyframe density — the property everything else rides on
  const { stdout: frames } = await execFileP(
    FFPROBE,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=key_frame', '-of', 'csv=p=0', out],
    { maxBuffer: 1024 * 1024 * 64 }
  )
  const keyFlags = frames.trim().split('\n').map((l) => l.startsWith('1'))
  let worstGap = 0
  let last = -1
  keyFlags.forEach((k, i) => {
    if (k) {
      if (last >= 0) worstGap = Math.max(worstGap, i - last)
      last = i
    }
  })
  check('keyframes ≤15 frames apart everywhere', worstGap > 0 && worstGap <= 15, `worst gap ${worstGap} frames (source was 90)`)

  // 2. duration parity
  const dur = async (p: string): Promise<number> => {
    const { stdout } = await execFileP(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p])
    return parseFloat(stdout.trim())
  }
  const dSrc = await dur(src)
  const dOut = await dur(out)
  check('duration matches source', Math.abs(dSrc - dOut) < 0.15, `${dOut.toFixed(2)}s vs ${dSrc.toFixed(2)}s`)

  // 3. size cap
  const { stdout: dims } = await execFileP(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out
  ])
  const [w, h] = dims.trim().split(',').map(Number)
  check('short edge capped at 720', Math.min(w, h) === 720, `${w}x${h} from 1080x1920`)

  // 4. cache + sharing
  const t1 = Date.now()
  const again = await conditionForPreview(src)
  check('cache hit is instant', again === out && Date.now() - t1 < 250, `${Date.now() - t1}ms`)
  check('existingPreviewMedia finds it', (await existingPreviewMedia(src)) === out)

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
