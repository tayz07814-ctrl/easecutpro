// Standalone logic test for ZoomAnimator (run: npx tsx <thisfile>). Mocks the
// DOM element's Web-Animations surface so we can assert the compositor path
// without a browser. NOT part of the build.
import { ZoomAnimator, kenBurnsTransform, kenBurnsScale, kenBurnsEase } from '../src/renderer/src/kenBurns'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, extra = ''): void => {
  if (ok) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')) }
}

// --- Minimal fake Animation + Element -------------------------------------
class FakeAnimation {
  currentTime = 0
  playState: 'idle' | 'running' | 'paused' | 'finished' = 'running'
  cancelled = false
  plays = 0
  constructor(public keyframes: Keyframe[], public opts: KeyframeAnimationOptions) {}
  play(): void { this.playState = 'running'; this.plays++ }
  cancel(): void { this.cancelled = true; this.playState = 'idle' }
}
class FakeEl {
  style: Record<string, string> = {}
  anims: FakeAnimation[] = []
  animate(keyframes: Keyframe[], opts: KeyframeAnimationOptions): FakeAnimation {
    const a = new FakeAnimation(keyframes, opts)
    this.anims.push(a)
    return a
  }
}
const asEl = (f: FakeEl): HTMLElement => f as unknown as HTMLElement

// --- 1. Paused → exact static frame, no animation -------------------------
{
  const el = new FakeEl()
  const z = new ZoomAnimator()
  z.drive(asEl(el), { origin: '50% 50%', zoomStart: 1, zoomEnd: 1.3, startSec: 0, lenSec: 2, playing: false, clockSec: 0, playheadSec: 1 })
  const wantMid = kenBurnsTransform({ zoomStart: 1, zoomEnd: 1.3, progress: 0.5 }) // playhead 1 / len 2
  check('paused writes no animation', el.anims.length === 0)
  check('paused writes exact static transform', el.style.transform === wantMid, `${el.style.transform} vs ${wantMid}`)
  check('paused sets transform-origin', el.style.transformOrigin === '50% 50%')
}

// --- 2. Playing → one animation, correct keyframe endpoints ----------------
{
  const el = new FakeEl()
  const z = new ZoomAnimator()
  z.drive(asEl(el), { origin: '50% 50%', zoomStart: 1, zoomEnd: 1.3, startSec: 0, lenSec: 2, playing: true, clockSec: 0, playheadSec: 0 })
  check('playing creates exactly one animation', el.anims.length === 1)
  const a = el.anims[0]
  check('duration is lenSec*1000 ms', (a.opts as { duration: number }).duration === 2000)
  check('linear compositor easing', (a.opts as { easing: string }).easing === 'linear')
  check('fills both ends', (a.opts as { fill: string }).fill === 'both')
  check('61 keyframes (0..60)', a.keyframes.length === 61)
  const first = a.keyframes[0].transform as string
  const last = a.keyframes[a.keyframes.length - 1].transform as string
  check('first keyframe = zoomStart', first === kenBurnsTransform({ zoomStart: 1, zoomEnd: 1.3, progress: 0 }), first)
  check('last keyframe = zoomEnd', last === kenBurnsTransform({ zoomStart: 1, zoomEnd: 1.3, progress: 1 }), last)
  check('first offset 0', a.keyframes[0].offset === 0)
  check('last offset 1', a.keyframes[a.keyframes.length - 1].offset === 1)
}

// --- 3. Steady playback (small drift) does NOT re-seek currentTime ---------
{
  const el = new FakeEl()
  const z = new ZoomAnimator()
  const p = { origin: '50% 50%', zoomStart: 1, zoomEnd: 1.3, startSec: 0, lenSec: 2, playing: true, clockSec: 0, playheadSec: 0 }
  z.drive(asEl(el), p)
  const a = el.anims[0]
  a.currentTime = 500 // compositor advanced to 0.5s
  z.drive(asEl(el), { ...p, clockSec: 0.52 }) // clock says 520ms — 20ms drift (< 120)
  check('no rebuild on same params', el.anims.length === 1)
  check('small drift left uncorrected (free-run)', a.currentTime === 500, String(a.currentTime))
}

// --- 4. A real jump (seek/loop) DOES re-seek currentTime ------------------
{
  const el = new FakeEl()
  const z = new ZoomAnimator()
  const p = { origin: '50% 50%', zoomStart: 1, zoomEnd: 1.3, startSec: 0, lenSec: 2, playing: true, clockSec: 0, playheadSec: 0 }
  z.drive(asEl(el), p)
  const a = el.anims[0]
  a.currentTime = 1800
  z.drive(asEl(el), { ...p, clockSec: 0.1 }) // looped back to 100ms → drift 1700ms
  check('large drift corrects currentTime', a.currentTime === 100, String(a.currentTime))
}

// --- 5. Params change rebuilds; retarget clears old element ----------------
{
  const elA = new FakeEl()
  const elB = new FakeEl()
  const z = new ZoomAnimator()
  z.drive(asEl(elA), { origin: '50% 50%', zoomStart: 1, zoomEnd: 1.3, startSec: 0, lenSec: 2, playing: true, clockSec: 0, playheadSec: 0 })
  z.drive(asEl(elA), { origin: '50% 50%', zoomStart: 1, zoomEnd: 2.0, startSec: 0, lenSec: 2, playing: true, clockSec: 0, playheadSec: 0 })
  check('param change cancels old + builds new', elA.anims.length === 2 && elA.anims[0].cancelled)
  // retarget to a different element
  z.drive(asEl(elB), { origin: '50% 50%', zoomStart: 1, zoomEnd: 2.0, startSec: 0, lenSec: 2, playing: true, clockSec: 0, playheadSec: 0 })
  check('retarget clears previous element transform', elA.style.transform === '')
  check('retarget cancels previous animation', elA.anims[1].cancelled)
  check('retarget starts animation on new element', elB.anims.length === 1 && !elB.anims[0].cancelled)
}

// --- 6. stop() cancels + clears -------------------------------------------
{
  const el = new FakeEl()
  const z = new ZoomAnimator()
  z.drive(asEl(el), { origin: '50% 50%', zoomStart: 1, zoomEnd: 1.3, startSec: 0, lenSec: 2, playing: true, clockSec: 0, playheadSec: 0 })
  z.stop()
  check('stop cancels animation', el.anims[0].cancelled)
  check('stop clears transform', el.style.transform === '')
}

// --- 7. Constant velocity: equal time steps → equal scale steps (linear) -----
{
  check('default easing is identity (linear, no easing)', Math.abs(kenBurnsEase(0.37) - 0.37) < 1e-9, String(kenBurnsEase(0.37)))
  const s = (p: number): number => kenBurnsScale({ zoomStart: 1, zoomEnd: 1.3, progress: p })
  const d1 = s(0.25) - s(0.0)
  const d2 = s(0.5) - s(0.25)
  const d3 = s(0.75) - s(0.5)
  const d4 = s(1.0) - s(0.75)
  const uniform = [d1, d2, d3, d4].every((d) => Math.abs(d - d1) < 1e-9)
  check('equal Δscale per equal Δtime (constant velocity)', uniform, `${d1.toFixed(4)}/${d2.toFixed(4)}/${d3.toFixed(4)}/${d4.toFixed(4)}`)
  check('midpoint is the exact linear midpoint (1.15)', Math.abs(s(0.5) - 1.15) < 1e-9, String(s(0.5)))
}

console.log(`\nZoomAnimator: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
