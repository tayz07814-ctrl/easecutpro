// Verify the native preview frame server + rotation-aware probe WITHOUT
// launching Electron (framestream.ts / ffmpeg.ts are deliberately Electron-free
// so the standalone server reuses them — this harness drives them under tsx).
//
//   npx tsx scripts/verify-framestream.ts
//
// Generates its own fixtures (testsrc + sine; one landscape, one with rotation
// metadata) so it needs no checked-in media.

import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { mkdir, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { FFMPEG } from '../src/main/binaries'
import { probe } from '../src/main/ffmpeg'
import { handleFrameStream, extractPreviewAudioWav } from '../src/main/framestream'

const execFileP = promisify(execFile)

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function makeFixtures(dir: string): Promise<{ plain: string; rotated: string }> {
  await mkdir(dir, { recursive: true })
  const plain = join(dir, 'fs-plain.mp4')
  const rotated = join(dir, 'fs-rotated.mp4')
  if (!existsSync(plain)) {
    await execFileP(FFMPEG, [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=5:size=640x360:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', plain
    ])
  }
  if (!existsSync(rotated)) {
    // Same pixels, but with a -90° display matrix (what a portrait phone
    // recording carries): stored 640x360, displayed 360x640.
    await execFileP(FFMPEG, [
      '-y', '-v', 'error',
      '-display_rotation', '-90',
      '-i', plain,
      '-c', 'copy', rotated
    ])
  }
  return { plain, rotated }
}

async function readAll(res: Response): Promise<Uint8Array> {
  const reader = res.body!.getReader()
  const parts: Uint8Array[] = []
  let len = 0
  for (;;) {
    const r = await reader.read()
    if (r.done) break
    parts.push(r.value)
    len += r.value.length
  }
  const out = new Uint8Array(len)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function req(p: string, t: number, frames?: number): Request {
  const f = frames ? `&frames=${frames}` : ''
  return new Request(`ecframes://frames/?p=${encodeURIComponent(p)}&t=${t.toFixed(3)}${f}`)
}

async function main(): Promise<void> {
  const dir = join(tmpdir(), 'easecut-verify-framestream')
  const { plain, rotated } = await makeFixtures(dir)

  // ---- probe rotation ----
  const pi = await probe(plain)
  check('probe plain dims', pi.width === 640 && pi.height === 360, `${pi.width}x${pi.height}`)
  check('probe plain fps', Math.abs(pi.fps - 30) < 0.01, String(pi.fps))
  const ri = await probe(rotated)
  check('probe rotated dims SWAPPED', ri.width === 360 && ri.height === 640, `${ri.width}x${ri.height}`)

  // ---- full stream: byte math ----
  const res = await handleFrameStream(req(plain, 1.0, 30))
  check('stream status 200', res.status === 200, String(res.status))
  const w = Number(res.headers.get('X-EC-W'))
  const h = Number(res.headers.get('X-EC-H'))
  const fps = Number(res.headers.get('X-EC-FPS'))
  check('stream geometry headers', w === 640 && h === 360 && fps === 30, `${w}x${h}@${fps}`)
  const bytes = await readAll(res)
  const frameBytes = (w * h * 3) / 2
  check('stream: 30 whole frames', bytes.length === 30 * frameBytes, `${bytes.length} vs ${30 * frameBytes}`)

  // ---- rotated stream: even display-oriented geometry ----
  const rres = await handleFrameStream(req(rotated, 0, 2))
  const rw = Number(rres.headers.get('X-EC-W'))
  const rh = Number(rres.headers.get('X-EC-H'))
  const rbytes = await readAll(rres)
  check('rotated stream portrait geometry', rw === 360 && rh === 640, `${rw}x${rh}`)
  check('rotated stream frames whole', rbytes.length === 2 * ((rw * rh * 3) / 2), String(rbytes.length))

  // ---- single frame (seam-cache still) ----
  const sres = await handleFrameStream(req(plain, 4.5, 1))
  const sbytes = await readAll(sres)
  check('single-frame request', sbytes.length === frameBytes, `${sbytes.length}`)

  // ---- seek past EOF: empty stream, not an error ----
  const eres = await handleFrameStream(req(plain, 60, 1))
  const ebytes = await readAll(eres)
  check('past-EOF stream is empty', eres.status === 200 && ebytes.length === 0, `${ebytes.length}B`)

  // ---- missing file ----
  const mres = await handleFrameStream(req(join(dir, 'nope.mp4'), 0))
  check('missing file → 404', mres.status === 404, String(mres.status))

  // ---- preview audio WAV ----
  const wav = await extractPreviewAudioWav(plain)
  const wst = await stat(wav)
  // 5s * 48000Hz * 2ch * 2B ≈ 960044 with header; allow slack for priming.
  check('preview WAV exists', existsSync(wav), wav)
  check('preview WAV plausible size', wst.size > 900000 && wst.size < 1050000, `${wst.size}B`)
  const wav2 = await extractPreviewAudioWav(plain)
  check('preview WAV cached (same path)', wav2 === wav)

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall green')
  process.exit(failures ? 1 : 0)
}

void main().catch((e) => {
  console.error('harness crashed:', e)
  process.exit(1)
})
