// Smart Silence Cleaner — demo transcript so the page runs stand-alone.
//
// Faithful port of smart_silence_cleaner/sample_data.py. Times are ms. The gaps
// are deliberately varied — natural pauses, long dead air, a couple of fillers —
// so the live preview and statistics have something interesting to show.

import type { Word } from './types'

// (startMs, endMs, text) — a short spoken paragraph with realistic pauses.
const RAW: ReadonlyArray<readonly [number, number, string]> = [
  [0, 320, 'So'],
  [330, 700, 'today'],
  [720, 1050, 'I'],
  [1060, 1500, 'want'],
  [1520, 1780, 'to'],
  [1800, 2300, 'talk'],
  [2320, 2600, 'about'],
  [2620, 3200, 'editing.'], // sentence end, then a long pause
  [4100, 4400, 'Um,'], // filler + long lead-in
  [5200, 5600, 'the'],
  [5620, 6100, 'the'], // stutter / repeat
  [6120, 6800, 'hardest'],
  [6820, 7200, 'part'],
  [7220, 7600, 'is'],
  [7620, 8300, 'silence,'], // clause end
  [8600, 9000, 'you'], // "you know" filler phrase
  [9010, 9400, 'know,'],
  [10200, 10600, 'removing'],
  [10620, 11100, 'dead'],
  [11120, 11600, 'air'],
  [11620, 12400, 'without'],
  [12420, 13000, 'making'],
  [13020, 13300, 'it'],
  [13320, 13900, 'feel'],
  [13920, 14600, 'rushed.'], // sentence end
]

/** The demo media is a touch longer than the last word (trailing room tone). */
export const SAMPLE_DURATION_MS = 15200.0

/** A fresh list of demo Word objects. */
export function sampleWords(): Word[] {
  return RAW.map(([s, e, t]) => ({ startMs: s, endMs: e, text: t }))
}
