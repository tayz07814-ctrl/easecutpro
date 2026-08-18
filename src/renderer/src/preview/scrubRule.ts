// The scrub restart rule, kept in its own dependency-free module so it can be
// executed by a plain `tsx` harness (importing it from wcPlayer.ts drags in
// platform.ts and `import.meta.env`, which only exists under Vite).
//
// Reported symptom: "when I'm scrubbing the playhead manually the preview
// doesn't update in realtime." A drag moves the playhead every animation frame,
// and the old rule abandoned the in-flight decode as soon as the target moved —
// so each frame killed the decode the previous one started, nothing ever
// landed, and the picture only appeared once the drag stopped.

/** How long an in-flight scrub restart may decode before a newer drag position
 *  is allowed to replace it. Measured restart latency on a 1080x1920 phone clip
 *  is 55 ms median / 165 ms max, so most land well inside this. */
export const SCRUB_GRACE_MS = 140

/**
 * Should a new scrub position abandon the restart already decoding?
 *
 * @param nowMs        current clock
 * @param restartAtMs  when the in-flight restart was issued, or 0 if none pending
 * @param t            newly requested time (source seconds)
 * @param pendingStart what the in-flight restart is decoding toward
 */
export function shouldSupersedeScrub(
  nowMs: number,
  restartAtMs: number,
  t: number,
  pendingStart: number
): boolean {
  if (Math.abs(t - pendingStart) <= 0.08) return false // already heading there
  if (restartAtMs !== 0 && nowMs - restartAtMs < SCRUB_GRACE_MS) return false // let it land
  return true
}

/** Minimum spacing between PAUSED-scrub element seeks. A fast swipe used to
 *  issue one cold seek per newly-shown source per rAF tick (a 1s drag across a
 *  30-clip timeline = ~60 seeks/second into one decoder). The reconciler
 *  re-derives the target every frame, so pacing the ISSUE rate is enough —
 *  the seek that does fire always carries the latest playhead position. */
export const PAUSED_SEEK_MIN_MS = 90

/** How long after the last external playhead move the timeline still counts as
 *  "being scrubbed". Background decoder work (seam warm-up) must yield for this
 *  window or it contends with the scrub's own seeks for the same decoder. */
export const SCRUB_IDLE_MS = 240

/** May a paused-scrub seek be issued now? Latest-target-wins pacing: the
 *  reconciler targets the CURRENT playhead whenever this returns true, so a
 *  held frame just means the next allowed seek lands exactly where the finger
 *  is by then (the trailing edge is the always-running rAF loop itself). */
export function shouldIssuePausedSeek(nowMs: number, lastIssuedAtMs: number): boolean {
  return nowMs - lastIssuedAtMs >= PAUSED_SEEK_MIN_MS
}

/** True while a scrub is in progress (a playhead move landed within the idle
 *  window). Decoder-heavy background jobs (seam warm-up walkers) poll this and
 *  wait the scrub out instead of racing it. */
export function scrubActive(nowMs: number, lastMoveAtMs: number): boolean {
  return lastMoveAtMs !== 0 && nowMs - lastMoveAtMs < SCRUB_IDLE_MS
}
