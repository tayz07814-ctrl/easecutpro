// Silence Settings presets (redesigned UI). Each preset is a BUNDLE of the real
// VadSilenceSettings fields — there is no second settings store. Presets are
// applied through the existing store setter, and `detectPreset` reports which
// preset (if any) the current values match so the UI can highlight it / fall
// back to "Custom". Pure + framework-free so it is unit-testable.

import { DEFAULT_VAD_SILENCE_SETTINGS, normalizeVadSilence, type VadSilenceSettings } from '@shared/vadsilence'

export type SilencePresetId = 'conservative' | 'balanced' | 'aggressive' | 'zero'
export type SilencePresetOrCustom = SilencePresetId | 'custom'

export interface SilencePreset {
  id: SilencePresetId
  label: string
  blurb: string
  values: VadSilenceSettings
}

// Balanced == the app default, so "Reset to defaults" lands back on a named
// preset. Every value runs through normalizeVadSilence so a preset can never
// carry an out-of-range value.
//
// Retuned after real-run overcutting: pace now comes from WHICH pauses are cut
// (minGapS) and how much air is left (pads) — NOT from cranking the VAD
// threshold or eating into speech. The old Aggressive (threshold .88 + 40-50ms
// pads + 30ms edgeTrim + breaths at -28dB) classified soft-spoken words as
// silence and clipped word edges; thresholds now stay ≤0.8, edgeTrimS is 0
// everywhere, and breath removal (Aggressive only) uses a quieter -34dB gate so
// it sweeps real breaths, not quiet speech.
export const SILENCE_PRESETS: SilencePreset[] = [
  {
    id: 'conservative',
    label: 'Conservative',
    blurb: 'Only trims longer pauses; keeps a natural, relaxed rhythm.',
    values: normalizeVadSilence({
      speechThreshold: 0.65,
      minGapS: 0.6,
      padBeforeS: 0.15,
      padAfterS: 0.2,
      edgeTrimS: 0,
      removeBreaths: false,
      breathDb: -34
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
      speechThreshold: 0.8,
      minGapS: 0.15,
      padBeforeS: 0.06,
      padAfterS: 0.06,
      edgeTrimS: 0,
      removeBreaths: true,
      breathDb: -34
    })
  },
  {
    id: 'zero',
    label: 'Zero pause',
    blurb: 'Gapless jump cuts — the next word starts the instant the last one ends.',
    // pads 0 = the cut lands exactly on the word boundary (no residual air);
    // minGap at the floor = even 50ms pauses collapse. Words themselves stay
    // protected by the interval-subtraction clamp, and the seam blend (overlap)
    // keeps the joins from clicking. Breaths on: dead air of any kind goes.
    values: normalizeVadSilence({
      speechThreshold: 0.75,
      minGapS: 0.05,
      padBeforeS: 0,
      padAfterS: 0,
      edgeTrimS: 0,
      removeBreaths: true,
      breathDb: -34
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
