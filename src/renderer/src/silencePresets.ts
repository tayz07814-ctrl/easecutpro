// Silence Settings presets (redesigned UI). Each preset is a BUNDLE of the real
// VadSilenceSettings fields — there is no second settings store. Presets are
// applied through the existing store setter, and `detectPreset` reports which
// preset (if any) the current values match so the UI can highlight it / fall
// back to "Custom". Pure + framework-free so it is unit-testable.

import { DEFAULT_VAD_SILENCE_SETTINGS, normalizeVadSilence, type VadSilenceSettings } from '@shared/vadsilence'

export type SilencePresetId = 'conservative' | 'balanced' | 'aggressive'
export type SilencePresetOrCustom = SilencePresetId | 'custom'

export interface SilencePreset {
  id: SilencePresetId
  label: string
  blurb: string
  values: VadSilenceSettings
}

// Balanced == the app default, so "Reset to defaults" lands back on a named
// preset. Conservative is gentler (only longer pauses, more breathing room);
// Aggressive is tighter and opts into breath removal. Every value is run through
// normalizeVadSilence so a preset can never carry an out-of-range value.
export const SILENCE_PRESETS: SilencePreset[] = [
  {
    id: 'conservative',
    label: 'Conservative',
    blurb: 'Only trims longer pauses; keeps a natural, relaxed rhythm.',
    values: normalizeVadSilence({
      speechThreshold: 0.7,
      minGapS: 0.5,
      padBeforeS: 0.12,
      padAfterS: 0.1,
      edgeTrimS: 0,
      removeBreaths: false,
      breathDb: -30
    })
  },
  {
    id: 'balanced',
    label: 'Balanced',
    blurb: 'Trims most dead air while keeping a little breathing room.',
    values: { ...DEFAULT_VAD_SILENCE_SETTINGS }
  },
  {
    id: 'aggressive',
    label: 'Aggressive',
    blurb: 'Tight, fast-paced — trims short pauses and removes soft breaths.',
    values: normalizeVadSilence({
      speechThreshold: 0.88,
      minGapS: 0.08,
      padBeforeS: 0.05,
      padAfterS: 0.04,
      edgeTrimS: 0.03,
      removeBreaths: true,
      breathDb: -28
    })
  }
]

const EPS = 1e-6
function sameSettings(a: VadSilenceSettings, b: VadSilenceSettings): boolean {
  return (
    Math.abs(a.speechThreshold - b.speechThreshold) < EPS &&
    Math.abs(a.minGapS - b.minGapS) < EPS &&
    Math.abs(a.padBeforeS - b.padBeforeS) < EPS &&
    Math.abs(a.padAfterS - b.padAfterS) < EPS &&
    Math.abs(a.edgeTrimS - b.edgeTrimS) < EPS &&
    Math.abs(a.breathDb - b.breathDb) < EPS &&
    a.removeBreaths === b.removeBreaths
  )
}

/** Which preset the current settings match, or 'custom' if none. */
export function detectPreset(s: VadSilenceSettings): SilencePresetOrCustom {
  for (const p of SILENCE_PRESETS) if (sameSettings(s, p.values)) return p.id
  return 'custom'
}

/** A fresh copy of a named preset's values. */
export function presetValues(id: SilencePresetId): VadSilenceSettings {
  const p = SILENCE_PRESETS.find((x) => x.id === id)
  if (!p) throw new Error(`unknown silence preset: ${id}`)
  return { ...p.values }
}
