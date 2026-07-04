/**
 * Instruments EXACTLY what ffmpeg's `zoompan` does to each frame, to prove why a
 * slow Ken Burns zoom jitters while a big zoom is smooth — and that supersampling
 * fixes it.
 *
 * zoompan, per output frame: scales the input to round(iw*z) px, then crops the
 * output window at an INTEGER (x,y). Both are whole pixels. We replicate that math
 * for a 100%->130% eased zoom and log the crop-x in OUTPUT pixels, flagging where
 * the value HOLDS (no change for ≥1 frame) then JUMPS — the visible stutter.
 *
 * Then we re-run it as if rendered on an S× supersampled frame (the fix): one
 * integer pixel becomes 1/S of an output pixel, so the steps go sub-pixel.
 *
 *   npx tsx scripts/verify-zoom-smoothness.ts
 */
const OUT_W = 1080 // output width (vertical short-form)
const FRAMES = 300 // ~10s @ 30fps
const Z0 = 1.0
const Z1 = 1.3
const easeInOut = (p: number): number => p * p * (3 - 2 * p) // the app's 'inout'

function report(label: string, S: number): { holds: number; maxJump: number } {
  let holds = 0
  let maxJump = 0
  let prev = Number.NaN
  const rows: string[] = []
  for (let f = 0; f < FRAMES; f++) {
    const p = easeInOut(f / (FRAMES - 1)) // independent per-frame (no accumulation)
    const z = Z0 + (Z1 - Z0) * p
    // What zoompan actually rasterizes, on an S× frame:
    const scaledW = Math.round(OUT_W * S * z) // integer scaled width
    const cropXpx = Math.round((scaledW - OUT_W * S) / 2) // integer centered crop
    const cropXout = cropXpx / S // expressed back in OUTPUT pixels
    if (f > 0) {
      const d = Math.abs(cropXout - prev)
      if (d === 0) holds++
      else maxJump = Math.max(maxJump, d)
    }
    if (f >= 40 && f < 52) rows.push(`   f${String(f).padStart(3)}  z=${z.toFixed(4)}  cropX=${cropXout.toFixed(3)} px`)
    prev = cropXout
  }
  console.log(`\n[${label}]  supersample S=${S}`)
  console.log(rows.join('\n'))
  console.log(`   → crop-x HELD (frozen) on ${holds}/${FRAMES - 1} frame steps; largest single jump = ${maxJump.toFixed(3)} output px`)
  return { holds, maxJump }
}

console.log('Slow Ken Burns: 100% → 130% over 300 frames, ease-in-out, 1080px wide')
const before = report('BEFORE — native zoompan (integer pixels)', 1)
const after = report('AFTER  — supersampled zoompan (our fix)', 3)

console.log('\n──────── verdict ────────')
console.log(`BEFORE: motion freezes for ${before.holds} frame steps, then snaps ${before.maxJump.toFixed(2)}px  → visible jitter`)
console.log(`AFTER : motion freezes for ${after.holds} frame steps, max snap ${after.maxJump.toFixed(2)}px (sub-pixel) → smooth`)
