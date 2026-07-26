// Retake 0.07 silence planner. Runs AFTER the Retake judge EDL and converts raw
// VAD non-speech gaps into exact middle ranges to remove. It never edits audio
// that overlaps a surviving transcript word.

import type { SilenceRegion } from './types'
import type { PauseContextWord, VadSilenceSettings } from './vadsilence'

const EPS = 0.002

function endsSentence(text: string | undefined): boolean {
  return /[.!?][\]"')]*$/.test(text?.trim() ?? '')
}

function scopeAllows(
  settings: VadSilenceSettings,
  previous: PauseContextWord,
  gapDuration: number
): boolean {
  if (settings.scope === 'all_word_gaps') return true
  if (endsSentence(previous.text)) return true
  return settings.scope === 'sentences_and_long_words' && gapDuration >= settings.minGapS
}

/** Return exact protected REMOVE ranges. The caller already applied minGapS in
 * VAD, but the planner checks it again so fixtures and future detectors cannot
 * bypass the creator's threshold. */
export function planRetakeSilenceCuts(
  rawGaps: { start: number; end: number }[],
  survivingWords: PauseContextWord[],
  settings: VadSilenceSettings,
  durationS: number,
  idPrefix = 'retake-sil'
): SilenceRegion[] {
  const words = [...survivingWords].sort((a, b) => a.start - b.start)
  const planned: SilenceRegion[] = []

  for (const [index, raw] of rawGaps.entries()) {
    const gap = {
      start: Math.max(0, Math.min(raw.start, durationS)),
      end: Math.max(0, Math.min(raw.end, durationS))
    }
    const gapDuration = gap.end - gap.start
    if (gapDuration < settings.minGapS) continue

    // Hard safety invariant: if VAD and transcript disagree, transcript wins.
    // Reject the WHOLE candidate rather than carving pieces around quiet words.
    if (words.some((word) => word.start < gap.end - EPS && word.end > gap.start + EPS)) continue

    const previous = [...words].reverse().find((word) => word.end <= gap.start + EPS)
    const next = words.find((word) => word.start >= gap.end - EPS)

    let cutStart = gap.start
    let cutEnd = gap.end
    if (previous && next) {
      if (!scopeAllows(settings, previous, gapDuration)) continue
      const minimumKept = settings.padAfterS + settings.padBeforeS
      const target = Math.max(settings.targetPauseS, minimumKept)
      if (gapDuration <= target + 0.02) continue
      const extra = Math.max(0, target - minimumKept) / 2
      cutStart += settings.padAfterS + extra
      cutEnd -= settings.padBeforeS + extra
    } else if (next) {
      // Leading dead air: preserve only the configured lead-in to first speech.
      cutEnd -= settings.padBeforeS
    } else if (previous) {
      // Trailing dead air: preserve only the configured tail after last speech.
      cutStart += settings.padAfterS
    } else {
      continue // no transcript context: never erase an entire uncertain clip
    }

    if (cutEnd - cutStart <= 0.02) continue
    planned.push({
      id: `${idPrefix}-${index}`,
      start: cutStart,
      end: cutEnd,
      action: 'remove',
      protect: true
    })
  }
  return planned
}
