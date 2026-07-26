// Silence Settings presets (redesigned UI). Each preset is a BUNDLE of the real
// VadSilenceSettings fields — there is no second settings store. Presets are
// applied through the existing store setter, and `detectPreset` reports which
// preset (if any) the current values match so the UI can highlight it / fall
// back to "Custom". Pure + framework-free so it is unit-testable.

import { DEFAULT_VAD_SILENCE_SETTINGS, normalizeVadSilence, type VadSilenceSettings } from '@shared/vadsilence'

export type SilencePresetId = 'natural' | 'balanced' | 'snappy'
export type SilencePresetOrCustom = SilencePresetId | 'custom'

export interface SilencePreset {
  id: SilencePresetId
  label: string
  blurb: string
  values: VadSilenceSettings
  seamFade: { enabled: boolean; ms: number }
}

// Balanced == the app default, so "Reset to defaults" lands back on a named
// preset. Every value runs through normalizeVadSilence so a preset can never
// carry an out-of-range value.
//
// The retained pause equals padAfterS (after the previous word) + padBeforeS
// (before the next word) in all three profiles. Crossfade is part of the preset.
export const SILENCE_PRESETS: SilencePreset[] = [
  {
    id: 'natural',
    label: 'Natural',
    blurb: 'Sentence boundaries only, with a relaxed half-second pause.',
    values: normalizeVadSilence({
      scope: 'sentences',
      speechThreshold: 0.68,
      minGapS: 0.7,
      targetPauseS: 0.5,
      padBeforeS: 0.3,
      padAfterS: 0.2,
      edgeTrimS: 0,
      removeBreaths: false,
      breathDb: -34
    }),
    seamFade: { enabled: true, ms: 15 }
  },
  {
    id: 'balanced',
    label: 'Balanced',
    blurb: 'Trims most dead air while keeping a little breathing room.',
    values: { ...DEFAULT_VAD_SILENCE_SETTINGS },
    seamFade: { enabled: true, ms: 20 }
  },
  {
    id: 'snappy',
    label: 'Snappy',
    blurb: 'Transcript-safe word gaps with a tight 160ms pause.',
    values: normalizeVadSilence({
      scope: 'all_word_gaps',
      speechThreshold: 0.76,
      minGapS: 0.35,
      targetPauseS: 0.16,
      padBeforeS: 0.1,
      padAfterS: 0.06,
      edgeTrimS: 0,
      removeBreaths: false,
      breathDb: -34
    }),
    seamFade: { enabled: true, ms: 25 }
  }
]

const EPS = 1e-6
function sameSettings(a: VadSilenceSettings, b: VadSilenceSettings): boolean {
  return (
    a.scope === b.scope &&
    Math.abs(a.speechThreshold - b.speechThreshold) < EPS &&
    Math.abs(a.minGapS - b.minGapS) < EPS &&
    Math.abs(a.targetPauseS - b.targetPauseS) < EPS &&
    Math.abs(a.padBeforeS - b.padBeforeS) < EPS &&
    Math.abs(a.padAfterS - b.padAfterS) < EPS &&
    Math.abs(a.edgeTrimS - b.edgeTrimS) < EPS &&
    Math.abs(a.breathDb - b.breathDb) < EPS &&
    a.removeBreaths === b.removeBreaths
  )
}

/** Which preset the current settings match, or 'custom' if none. */
export function detectPreset(s: VadSilenceSettings, fade?: { enabled: boolean; ms: number }): SilencePresetOrCustom {
  for (const p of SILENCE_PRESETS) {
    if (sameSettings(s, p.values) && (!fade || (fade.enabled === p.seamFade.enabled && Math.abs(fade.ms - p.seamFade.ms) < EPS))) return p.id
  }
  return 'custom'
}

/** A fresh copy of a named preset's values. */
export function presetValues(id: SilencePresetId): VadSilenceSettings {
  const p = SILENCE_PRESETS.find((x) => x.id === id)
  if (!p) throw new Error(`unknown silence preset: ${id}`)
  return { ...p.values }
}

/** Fresh settings + crossfade bundle for preset application. */
export function presetProfile(id: SilencePresetId): { values: VadSilenceSettings; seamFade: { enabled: boolean; ms: number } } {
  const preset = SILENCE_PRESETS.find((x) => x.id === id)
  if (!preset) throw new Error(`unknown silence preset: ${id}`)
  return { values: { ...preset.values }, seamFade: { ...preset.seamFade } }
}
