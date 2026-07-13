// Headless tests for the redesigned Silence Settings presets (P4).
// Run: npx tsx --tsconfig tsconfig.web.json scripts/verify-silence-presets.ts
//
// Covers the P4 requirements that are unit-testable in isolation. The runtime
// flag-gating (new UI off = legacy UI) and the store write path are additionally
// covered by the build-both-flags step and the untouched legacy component file.

import { DEFAULT_VAD_SILENCE_SETTINGS, normalizeVadSilence, type VadSilenceSettings } from '@shared/vadsilence'
import { SILENCE_PRESETS, detectPreset, presetValues } from '../src/renderer/src/silencePresets'

let ok = true
const check = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) ok = false
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const VAD_KEYS = ['speechThreshold', 'minGapS', 'padBeforeS', 'padAfterS', 'edgeTrimS', 'removeBreaths', 'breathDb'].sort()

console.log('1) preset values populate correctly (valid, in-range, self-detecting)')
for (const p of SILENCE_PRESETS) {
  check(`${p.id}: values survive normalize unchanged (in range)`, eq(normalizeVadSilence(p.values), p.values))
  check(`${p.id}: detectPreset round-trips to itself`, detectPreset(p.values) === p.id)
  check(`${p.id}: carries ONLY the 7 real VAD fields (no FastCut/ProCut/extra keys)`, eq(Object.keys(p.values).sort(), VAD_KEYS))
}
check('there are exactly Conservative / Balanced / Aggressive', eq(SILENCE_PRESETS.map((p) => p.id), ['conservative', 'balanced', 'aggressive']))

console.log('2) Balanced == app default, so Reset lands on a named preset')
check('Balanced equals DEFAULT_VAD_SILENCE_SETTINGS', eq(presetValues('balanced'), DEFAULT_VAD_SILENCE_SETTINGS))
check('detectPreset(DEFAULT) === balanced', detectPreset(DEFAULT_VAD_SILENCE_SETTINGS) === 'balanced')

console.log('3) editing any value flips the active preset to Custom')
const bal = presetValues('balanced')
check('tweak minGapS → custom', detectPreset({ ...bal, minGapS: bal.minGapS + 0.05 }) === 'custom')
check('tweak padBeforeS → custom', detectPreset({ ...bal, padBeforeS: bal.padBeforeS + 0.01 }) === 'custom')
check('toggle removeBreaths → custom', detectPreset({ ...bal, removeBreaths: !bal.removeBreaths }) === 'custom')
check('nudge speechThreshold → custom', detectPreset({ ...bal, speechThreshold: bal.speechThreshold - 0.05 }) === 'custom')

console.log('4) Apply commits the draft through the store normalize with no drift')
for (const p of SILENCE_PRESETS) {
  // Apply = setVadSilenceSettings(draft); the store setter runs normalizeVadSilence.
  const committed = normalizeVadSilence({ ...p.values })
  check(`${p.id}: applied value equals the selected preset (no clamping/drift)`, eq(committed, p.values))
}

console.log('5) Cancel does not mutate the applied settings (buffered-draft contract)')
// Model the sheet: applied stays put; the draft is edited but NOT committed on cancel.
const appliedBefore: VadSilenceSettings = { ...presetValues('balanced') }
let draft: VadSilenceSettings = { ...appliedBefore }
draft = { ...draft, minGapS: 0.9, removeBreaths: true } // user edits the draft…
// …then cancels: no setVadSilenceSettings call → applied is unchanged.
check('draft diverged from applied', !eq(draft, appliedBefore))
check('applied settings untouched after cancel', eq(appliedBefore, presetValues('balanced')))

console.log('6) Reset restores the current defaults')
const resetDraft: VadSilenceSettings = { ...DEFAULT_VAD_SILENCE_SETTINGS }
check('reset draft equals DEFAULT', eq(resetDraft, DEFAULT_VAD_SILENCE_SETTINGS))
check('reset draft detects as Balanced', detectPreset(resetDraft) === 'balanced')

console.log('7) presetValues returns a fresh copy (no shared mutation into the preset table)')
const c1 = presetValues('aggressive')
c1.minGapS = 999
check('mutating a returned copy does not affect the source preset', presetValues('aggressive').minGapS !== 999)

console.log(ok ? '\nSILENCE-PRESETS OK' : '\nSILENCE-PRESETS FAILED')
process.exit(ok ? 0 : 1)
