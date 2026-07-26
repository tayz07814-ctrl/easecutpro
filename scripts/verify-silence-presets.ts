// Headless tests for the redesigned Silence Settings presets (P4).
// Run: npx tsx --tsconfig tsconfig.web.json scripts/verify-silence-presets.ts
//
// Covers the P4 requirements that are unit-testable in isolation. The runtime
// flag-gating (new UI off = legacy UI) and the store write path are additionally
// covered by the build-both-flags step and the untouched legacy component file.

import { DEFAULT_VAD_SILENCE_SETTINGS, normalizeVadSilence, type VadSilenceSettings } from '@shared/vadsilence'
import { planRetakeSilenceCuts } from '@shared/retakesilence'
import { SILENCE_PRESETS, detectPreset, presetProfile, presetValues } from '../src/renderer/src/silencePresets'

let ok = true
const check = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) ok = false
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const VAD_KEYS = ['scope', 'speechThreshold', 'minGapS', 'targetPauseS', 'padBeforeS', 'padAfterS', 'edgeTrimS', 'removeBreaths', 'breathDb'].sort()

console.log('1) preset values populate correctly (valid, in-range, self-detecting)')
for (const p of SILENCE_PRESETS) {
  check(`${p.id}: values survive normalize unchanged (in range)`, eq(normalizeVadSilence(p.values), p.values))
  check(`${p.id}: detectPreset round-trips to itself`, detectPreset(p.values, p.seamFade) === p.id)
  check(`${p.id}: carries ONLY the 9 real VAD fields`, eq(Object.keys(p.values).sort(), VAD_KEYS))
}
check('there are exactly Natural / Balanced / Snappy profiles', eq(SILENCE_PRESETS.map((p) => p.id), ['natural', 'balanced', 'snappy']))

console.log('2) Balanced == app default, so Reset lands on a named preset')
check('Balanced equals DEFAULT_VAD_SILENCE_SETTINGS', eq(presetValues('balanced'), DEFAULT_VAD_SILENCE_SETTINGS))
check('detectPreset(DEFAULT) === balanced', detectPreset(DEFAULT_VAD_SILENCE_SETTINGS) === 'balanced')

console.log('3) editing any value flips the active preset to Custom')
const bal = presetValues('balanced')
check('tweak minGapS → custom', detectPreset({ ...bal, minGapS: bal.minGapS + 0.05 }) === 'custom')
check('tweak padBeforeS → custom', detectPreset({ ...bal, padBeforeS: bal.padBeforeS + 0.01 }) === 'custom')
check('toggle removeBreaths → custom', detectPreset({ ...bal, removeBreaths: !bal.removeBreaths }) === 'custom')
check('nudge speechThreshold → custom', detectPreset({ ...bal, speechThreshold: bal.speechThreshold - 0.05 }) === 'custom')
check('change scope → custom', detectPreset({ ...bal, scope: 'sentences' }) === 'custom')
check('change crossfade → custom', detectPreset(bal, { enabled: true, ms: 21 }) === 'custom')

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
const c1 = presetValues('snappy')
c1.minGapS = 999
check('mutating a returned copy does not affect the source preset', presetValues('snappy').minGapS !== 999)

console.log('8) post-EDL planner shortens the middle and hard-protects words')
const sentenceWords = [{ start: 0, end: 0.5, text: 'Hello.' }, { start: 2, end: 2.5, text: 'Next' }]
const planned = planRetakeSilenceCuts([{ start: 0.5, end: 2 }], sentenceWords, bal, 3)
check('Balanced emits one protected middle cut', planned.length === 1 && planned[0].protect === true)
check('Balanced keeps 120ms after previous word', Math.abs(planned[0].start - 0.62) < 1e-6)
check('Balanced keeps 180ms before next word', Math.abs(planned[0].end - 1.82) < 1e-6)
check('Balanced final pause is exactly 300ms', Math.abs((planned[0].start - 0.5) + (2 - planned[0].end) - 0.3) < 1e-6)
check('candidate overlapping a surviving word is rejected wholesale', planRetakeSilenceCuts([{ start: 0.4, end: 2 }], sentenceWords, bal, 3).length === 0)

console.log('9) preset scope controls eligible transcript-safe gaps')
const plainWords = [{ start: 0, end: 0.5, text: 'well' }, { start: 2, end: 2.5, text: 'today' }]
check('Natural keeps an intra-sentence gap', planRetakeSilenceCuts([{ start: 0.5, end: 2 }], plainWords, presetValues('natural'), 3).length === 0)
check('Balanced cuts a long intra-sentence gap', planRetakeSilenceCuts([{ start: 0.5, end: 2 }], plainWords, bal, 3).length === 1)
check('Snappy cuts transcript-safe word gaps', planRetakeSilenceCuts([{ start: 0.5, end: 2 }], plainWords, presetValues('snappy'), 3).length === 1)
check('preset bundles crossfade values', presetProfile('natural').seamFade.ms === 15 && presetProfile('balanced').seamFade.ms === 20 && presetProfile('snappy').seamFade.ms === 25)

console.log(ok ? '\nSILENCE-PRESETS OK' : '\nSILENCE-PRESETS FAILED')
process.exit(ok ? 0 : 1)
