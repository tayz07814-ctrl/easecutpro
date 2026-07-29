// Smart Silence Cleaner — the five editing modes (presets).
//
// Faithful port of smart_silence_cleaner/models/presets.py. The EXACT numbers
// come straight from the product spec so the modes behave predictably.

import type { Preset } from './types'
import { copySettings } from './settings'

export const CONSERVATIVE: Preset = {
  id: 'conservative',
  icon: '🐢',
  title: 'Keep More Natural Pauses',
  description:
    'Perfect for storytelling, interviews, podcasts, emotional videos and cinematic pacing. Very light trimming.',
  editable: false,
  settings: {
    minGapMs: 450,
    targetPauseMs: 280,
    sentencePauseMs: 450,
    commaPauseMs: 300,
    mergeGapMs: 140,
    padBeforeMs: 90,
    padAfterMs: 110,
    keepSentenceFlow: true,
    removeFillers: false,
    smartSilence: true,
  },
}

export const BALANCED: Preset = {
  id: 'balanced',
  icon: '⚖️',
  title: 'Recommended',
  description: 'Removes awkward dead air while keeping speech natural. This is the default.',
  editable: false,
  settings: {
    minGapMs: 300,
    targetPauseMs: 180,
    sentencePauseMs: 350,
    commaPauseMs: 250,
    mergeGapMs: 100,
    padBeforeMs: 60,
    padAfterMs: 80,
    keepSentenceFlow: true,
    removeFillers: false,
    smartSilence: true,
  },
}

export const AGGRESSIVE: Preset = {
  id: 'aggressive',
  icon: '⚡',
  title: 'Fast Paced',
  description: 'Creates energetic YouTube Shorts, Reels and TikTok-style pacing.',
  editable: false,
  settings: {
    minGapMs: 180,
    targetPauseMs: 80,
    sentencePauseMs: 220,
    commaPauseMs: 150,
    mergeGapMs: 80,
    padBeforeMs: 40,
    padAfterMs: 50,
    keepSentenceFlow: true,
    removeFillers: false,
    smartSilence: true,
  },
}

// Strip *every* gap over 80 ms down to nothing — a true gapless cut. Smart
// Silence is off (uniform, no punctuation rules), pads are zero.
export const AGGRESSIVE_GAPLESS: Preset = {
  id: 'aggressive_gapless',
  icon: '✂️',
  title: 'Aggressive Gapless',
  description: 'Removes every silence gap longer than 80 ms. Tightest possible — no breathing room.',
  editable: false,
  settings: {
    minGapMs: 80,
    targetPauseMs: 0,
    sentencePauseMs: 0,
    commaPauseMs: 0,
    mergeGapMs: 60,
    padBeforeMs: 0,
    padAfterMs: 0,
    keepSentenceFlow: false,
    removeFillers: false,
    smartSilence: false,
  },
}

// Custom starts as a copy of Balanced and is the one mode the user may tune.
export const CUSTOM: Preset = {
  id: 'custom',
  icon: '🎚️',
  title: 'Custom',
  description: 'Adjust everything manually with the sliders below, or open Advanced for exact values.',
  editable: true,
  settings: copySettings(BALANCED.settings),
}

/** Display order for the mode cards. */
export const PRESET_ORDER: readonly Preset[] = [
  CONSERVATIVE,
  BALANCED,
  AGGRESSIVE,
  AGGRESSIVE_GAPLESS,
  CUSTOM,
]

/** The mode selected on first open. */
export const DEFAULT_PRESET_ID = 'balanced'

const BY_ID: ReadonlyMap<string, Preset> = new Map(PRESET_ORDER.map((p) => [p.id, p]))

/** Every preset, in display order. */
export function allPresets(): readonly Preset[] {
  return PRESET_ORDER
}

/** Look up a preset by id (falls back to the default). */
export function getPreset(id: string): Preset {
  return BY_ID.get(id) ?? BY_ID.get(DEFAULT_PRESET_ID)!
}

/** The Balanced/Recommended default. */
export function defaultPreset(): Preset {
  return getPreset(DEFAULT_PRESET_ID)
}
