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
