// Smart Silence Cleaner — settings defaults + creator-slider <-> param maps.
//
// Faithful port of smart_silence_cleaner/models/settings.py:
//   default SilenceSettings, _lerp / _inv_lerp, apply_pause/speed/breath_slider,
//   to_sliders.
//
// Sliders are 0-100 integers. Each helper is pure so it drives both directions:
// slider moved -> settings, and preset selected -> where the sliders sit.

import * as config from './config'
import type { SilenceSettings } from './types'
import { pyRound } from './types'

/** The default settings object (matches Balanced's raw params). */
export function defaultSettings(): SilenceSettings {
  return {
    minGapMs: 300.0,
    targetPauseMs: 180.0,
    sentencePauseMs: 350.0,
    commaPauseMs: 250.0,
    mergeGapMs: 100.0,
    padBeforeMs: 60.0,
    padAfterMs: 80.0,
    keepSentenceFlow: true,
    removeFillers: false,
    smartSilence: true,
  }
}

/** Return a new settings object with `changes` applied (immutable style). */
export function copySettings(
  s: SilenceSettings,
  changes: Partial<SilenceSettings> = {},
): SilenceSettings {
  return { ...s, ...changes }
}

/** Linear interpolation; `t` clamped to [0, 1]. */
export function lerp(lo: number, hi: number, t: number): number {
  t = t < 0 ? 0.0 : t > 1 ? 1.0 : t
  return lo + (hi - lo) * t
}

/** Inverse of `lerp` — where does `value` sit in [lo, hi] as [0, 1]? */
export function invLerp(lo: number, hi: number, value: number): number {
  if (hi === lo) return 0.0
  const t = (value - lo) / (hi - lo)
  return t < 0 ? 0.0 : t > 1 ? 1.0 : t
}

/** Slider 1 — Keep More Pauses … Remove More Pauses. Drives minGap + target. */
export function applyPauseSlider(s: SilenceSettings, value: number): SilenceSettings {
  const t = value / 100.0
  return copySettings(s, {
    minGapMs: lerp(config.BOUNDS_MIN_GAP_MS[1], config.BOUNDS_MIN_GAP_MS[0], t),
    targetPauseMs: lerp(config.BOUNDS_TARGET_PAUSE_MS[1], config.BOUNDS_TARGET_PAUSE_MS[0], t),
  })
}

/** Slider 2 — Relaxed … Fast Conversation. Drives sentence + comma (+ target). */
export function applySpeedSlider(s: SilenceSettings, value: number): SilenceSettings {
  const t = value / 100.0
  return copySettings(s, {
    sentencePauseMs: lerp(config.BOUNDS_SENTENCE_PAUSE_MS[1], config.BOUNDS_SENTENCE_PAUSE_MS[0], t),
    commaPauseMs: lerp(config.BOUNDS_COMMA_PAUSE_MS[1], config.BOUNDS_COMMA_PAUSE_MS[0], t),
    targetPauseMs: lerp(config.BOUNDS_TARGET_PAUSE_MS[1], config.BOUNDS_TARGET_PAUSE_MS[0], t),
  })
}

/** Slider 3 — Natural Breathing … Minimal Breathing. Drives padding + merge. */
export function applyBreathSlider(s: SilenceSettings, value: number): SilenceSettings {
  const t = value / 100.0
  const pad = lerp(config.BOUNDS_PAD_MS[1], config.BOUNDS_PAD_MS[0], t)
  return copySettings(s, {
    padBeforeMs: pad * 0.75,
    padAfterMs: pad,
    mergeGapMs: lerp(config.BOUNDS_MERGE_GAP_MS[1], config.BOUNDS_MERGE_GAP_MS[0], t),
  })
}

/** Best-fit slider positions (pause, speed, breath) for a settings object. */
export function toSliders(s: SilenceSettings): [number, number, number] {
  const pause = invLerp(config.BOUNDS_MIN_GAP_MS[1], config.BOUNDS_MIN_GAP_MS[0], s.minGapMs)
  const speed = invLerp(config.BOUNDS_SENTENCE_PAUSE_MS[1], config.BOUNDS_SENTENCE_PAUSE_MS[0], s.sentencePauseMs)
  const breath = invLerp(config.BOUNDS_PAD_MS[1], config.BOUNDS_PAD_MS[0], s.padAfterMs)
  return [pyRound(pause * 100), pyRound(speed * 100), pyRound(breath * 100)]
}
