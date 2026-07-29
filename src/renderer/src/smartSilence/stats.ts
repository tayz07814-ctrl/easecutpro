// Smart Silence Cleaner — statistics derived from transcript + cut list.
//
// Faithful port of smart_silence_cleaner/engine/stats.py. Pure functions: feed
// in words and the plan totals, get numbers back. The UI formats them.

import type { Stats, Word } from './types'
import { wordDurationMs } from './config'
import { pyRound } from './types'

/** `83500` -> "1:23"; sub-minute -> "12.4s". Matches Python Stats.fmt_duration. */
export function fmtDuration(ms: number): string {
  ms = Math.max(0.0, ms)
  const secs = ms / 1000.0
  if (secs < 60) return `${secs.toFixed(1)}s`
  const total = pyRound(secs)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Inter-word gaps (ms) across the transcript, negatives clamped to 0. */
function gaps(words: Word[]): number[] {
  const out: number[] = []
  for (let i = 0; i < words.length - 1; i++) {
    out.push(Math.max(0.0, words[i + 1].startMs - words[i].endMs))
  }
  return out
}

/** Assemble a Stats from the transcript and the plan's totals. */
export function computeStats(
  words: Word[],
  totalRemovedMs: number,
  pausesRemoved: number,
  fillersRemoved: number,
  originalDurationMs: number,
): Stats {
  const g = gaps(words)
  const silenceBefore = g.reduce((a, b) => a + b, 0.0)
  const speech = words.reduce((a, w) => a + wordDurationMs(w), 0.0)
  const output = Math.max(0.0, originalDurationMs - totalRemovedMs)
  const percent = originalDurationMs > 0 ? (totalRemovedMs / originalDurationMs) * 100.0 : 0.0

  let longest = 0.0
  for (const x of g) if (x > longest) longest = x

  return {
    originalDurationMs,
    outputDurationMs: output,
    timeSavedMs: totalRemovedMs,
    percentRemoved: percent,
    speechDurationMs: speech,
    silenceDurationMs: silenceBefore,
    pausesTotal: g.length,
    pausesRemoved,
    fillersRemoved,
    averagePauseMs: g.length ? silenceBefore / g.length : 0.0,
    longestPauseMs: g.length ? longest : 0.0,
  }
}
