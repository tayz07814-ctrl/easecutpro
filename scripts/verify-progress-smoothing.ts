// Regression test for the export progress bar that "climbs to 30-70% then
// starts from the beginning, over and over".
//
//   npx tsx scripts/verify-progress-smoothing.ts
//
// The bar is a smoothing layer over the real job percentage. The reported bug
// was NOT in the export engine — a live capture showed the real percentages
// arriving perfectly monotonic (0 1 6 8 … 43 45 62 78 94) while the bar looped.
// The old smoother advanced at a floor of 1.5 %/s no matter how slow the job
// was, then reset itself once the truth fell 25 points behind. This simulates
// the animation loop against realistically slow jobs and fails on any backwards
// step, which is what the creator actually sees as "starting from the start".

import { stepProgress } from '../src/renderer/src/useSmoothProgress'

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/** Run the animation loop at 60fps over a job that takes `jobSeconds`. */
function simulate(jobSeconds: number, opts: { stallAfter?: number } = {}): {
  drops: number
  maxLead: number
  end: number
  frames: number
} {
  const dt = 1 / 60
  let shown = 0
  let drops = 0
  let maxLead = 0
  let frames = 0
  for (let elapsed = 0; elapsed <= jobSeconds; elapsed += dt) {
    // Real progress: linear, and optionally frozen partway (a long opaque
    // ffmpeg stretch that reports nothing).
    const raw = (elapsed / jobSeconds) * 100
    const target = opts.stallAfter != null && elapsed > opts.stallAfter ? (opts.stallAfter / jobSeconds) * 100 : raw
    const next = stepProgress(shown, target, dt)
    if (next < shown - 1e-9) drops++
    maxLead = Math.max(maxLead, next - target)
    shown = next
    frames++
  }
  return { drops, maxLead, end: shown, frames }
}

// A 10-minute export advances ~0.17 %/s — far under the old 1.5 %/s creep, so
// this is the exact case that looped.
const long = simulate(600)
check('10-min job: bar never goes backwards', long.drops === 0, `${long.drops} drops`)
check('10-min job: bar never runs away from the truth', long.maxLead <= 6.5, `max lead ${long.maxLead.toFixed(1)}%`)

// A very slow render on a weak laptop — the worst reported case.
const slow = simulate(1800)
check('30-min job: bar never goes backwards', slow.drops === 0, `${slow.drops} drops`)
check('30-min job: bar never runs away', slow.maxLead <= 6.5, `max lead ${slow.maxLead.toFixed(1)}%`)

// A quick job should still feel responsive and finish near the top.
const quick = simulate(8)
check('8s job: no backwards steps', quick.drops === 0, `${quick.drops} drops`)
check('8s job: reaches a high mark', quick.end >= 90, `ended ${quick.end.toFixed(1)}%`)

// A long silent stretch must still show life, but bounded.
const stalled = simulate(300, { stallAfter: 60 })
check('stalled job: no backwards steps', stalled.drops === 0, `${stalled.drops} drops`)
check('stalled job: keeps drifting (looks alive)', stalled.end > 20, `ended ${stalled.end.toFixed(1)}%`)
check('stalled job: drift stays bounded', stalled.maxLead <= 6.5, `max lead ${stalled.maxLead.toFixed(1)}%`)

// Completion glides to 100 rather than snapping.
let s = 40
for (let i = 0; i < 200; i++) s = stepProgress(s, 100, 1 / 60)
check('completion reaches 100', s >= 99.9, s.toFixed(2))

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall green')
process.exit(failures ? 1 : 0)
