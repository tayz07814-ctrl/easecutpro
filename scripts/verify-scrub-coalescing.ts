// Verify the scrub restart rule WITHOUT a GPU.
//
//   npx tsx scripts/verify-scrub-coalescing.ts
//
// Reported symptom: "when I'm scrubbing the playhead manually the preview
// doesn't update in realtime". Cause: a drag moves the playhead every animation
// frame, and the old rule superseded an in-flight decode on sight — so each rAF
// killed the decode the previous one started and no frame ever landed. The
// picture only appeared once the drag STOPPED.
//
// The fix is a timing rule, so this replays a drag against it and asserts on the
// thing that actually matters: how many frames land while the finger is moving.

import {
  shouldSupersedeScrub,
  shouldIssuePausedSeek,
  scrubActive,
  PAUSED_SEEK_MIN_MS,
  SCRUB_IDLE_MS
} from '../src/renderer/src/preview/scrubRule'

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/** Replay a drag: 60 Hz positions, each restart taking `decodeMs` to deliver. */
function simulateDrag(opts: {
  seconds: number
  pxPerSecond: number // how fast the playhead moves, in source seconds per second
  decodeMs: number
  rule: (now: number, restartAt: number, t: number, pending: number) => boolean
}): { restarts: number; framesLanded: number } {
  const { seconds, pxPerSecond, decodeMs, rule } = opts
  let restarts = 0
  let framesLanded = 0
  let pendingStart: number | null = null
  let restartAt = 0
  // Where the decoder currently holds a frame. requestStill() only restarts an
  // idle pipe when the wanted time is OUTSIDE what is already decoded, so the
  // simulation has to model that or a stationary finger "restarts" forever.
  let covered: number | null = null

  for (let ms = 0; ms < seconds * 1000; ms += 16.7) {
    const t = (ms / 1000) * pxPerSecond // where the finger is now

    // A pending restart delivers once its decode time has elapsed.
    if (pendingStart !== null && ms - restartAt >= decodeMs) {
      framesLanded++
      covered = pendingStart
      pendingStart = null
      restartAt = 0
    }

    if (pendingStart === null) {
      if (covered === null || Math.abs(t - covered) > 0.08) {
        pendingStart = t // idle and not already showing t -> start one
        restartAt = ms
        restarts++
      }
    } else if (rule(ms, restartAt, t, pendingStart)) {
      pendingStart = t // supersede: the old decode is thrown away undelivered
      restartAt = ms
      restarts++
    }
  }
  return { restarts, framesLanded }
}

/** The rule as it behaved before the fix: supersede the moment the target moves. */
const oldRule = (_now: number, _restartAt: number, t: number, pending: number): boolean =>
  Math.abs(t - pending) > 0.08

// ---- the unit rule ----
check('same target -> never supersedes', !shouldSupersedeScrub(1000, 900, 5.0, 5.02))
check(
  'moved target, restart still settling -> waits',
  !shouldSupersedeScrub(1000, 950, 6.0, 5.0),
  '50ms into a 140ms grace'
)
check(
  'moved target, restart had its chance -> supersedes',
  shouldSupersedeScrub(1000, 800, 6.0, 5.0),
  '200ms > 140ms grace'
)
check('no restart in flight -> supersedes', shouldSupersedeScrub(1000, 0, 6.0, 5.0))

// ---- the behaviour that was actually broken ----
// A 2s drag across a clip at 4x speed, decoder taking the measured 55ms median.
const drag = { seconds: 2, pxPerSecond: 4, decodeMs: 55 }
const before = simulateDrag({ ...drag, rule: oldRule })
const after = simulateDrag({ ...drag, rule: shouldSupersedeScrub })

console.log(
  `\n  old rule: ${before.restarts} restarts, ${before.framesLanded} frames landed` +
    `\n  new rule: ${after.restarts} restarts, ${after.framesLanded} frames landed\n`
)
check(
  'old rule starves the picture during a drag',
  before.framesLanded === 0,
  `${before.framesLanded} frames in ${drag.seconds}s of dragging`
)
check(
  'new rule keeps the picture live while dragging',
  after.framesLanded >= 10,
  `${after.framesLanded} frames = ${(after.framesLanded / drag.seconds).toFixed(1)} fps`
)
// The property that matters isn't "fewer restarts" — it's that the decoder work
// BUYS something. Under the old rule almost every restart was thrown away
// undelivered; under the new one each one gets to finish.
check(
  'old rule: decoder work is wasted',
  before.framesLanded / Math.max(1, before.restarts) < 0.1,
  `${before.framesLanded}/${before.restarts} restarts delivered a frame`
)
check(
  'new rule: nearly every restart delivers a frame',
  after.framesLanded / Math.max(1, after.restarts) > 0.8,
  `${after.framesLanded}/${after.restarts} restarts delivered a frame`
)

// A slow drag inside one decoded region must not thrash either.
const slow = simulateDrag({ seconds: 2, pxPerSecond: 0.02, decodeMs: 55, rule: shouldSupersedeScrub })
check('a slow drag barely restarts at all', slow.restarts <= 3, `${slow.restarts} restarts`)

// ---- paused-scrub seek pacing (the element path's global budget) ----
// The reported freeze: apply cuts, then a FAST swipe across the timeline, then
// play(). The paused reconciler used to issue one cold element seek per newly
// SHOWN source — a swipe across a dense timeline queued dozens of decoder
// seeks in a second, and play() inherited a thrashed pipeline. The budget caps
// the issue rate; the always-running reconciler makes the seek that does fire
// carry the LATEST playhead position.
check('paused seek: nothing issued yet -> allowed', shouldIssuePausedSeek(1000, 0))
check('paused seek: inside the pacing window -> held', !shouldIssuePausedSeek(1000, 1000 - PAUSED_SEEK_MIN_MS + 10))
check('paused seek: window elapsed -> allowed', shouldIssuePausedSeek(1000, 1000 - PAUSED_SEEK_MIN_MS))

check('scrub counts as active right after a move', scrubActive(1000, 1000 - SCRUB_IDLE_MS + 10))
check('no move recorded -> never active', !scrubActive(1000, 0))
check('scrub goes idle after the window', !scrubActive(1000, 1000 - SCRUB_IDLE_MS))

/** 1s of 60 Hz reconciler ticks during a drag: how many paused seeks fire. */
function countPausedSeeks(): number {
  let seeks = 0
  let lastIssued = 0
  for (let ms = 0; ms <= 1000; ms += 16.7) {
    if (shouldIssuePausedSeek(ms, lastIssued)) {
      seeks++
      lastIssued = ms
    }
  }
  return seeks
}
const paced = countPausedSeeks()
const budgetedMax = Math.ceil(1000 / PAUSED_SEEK_MIN_MS) + 1
check(
  'paused scrub: a fast swipe issues a bounded number of seeks',
  paced <= budgetedMax,
  `${paced} seeks in 1s of dragging (was: one per newly-shown clip, unbounded)`
)
check('paused scrub: the budget still tracks the finger', paced >= 8, `${paced} seeks/s`)

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed')
process.exit(failures ? 1 : 0)
