// Headless tests for Cut Lord pure logic (shared/cutlord.ts).
// Run: npx tsx scripts/verify-cutlord.ts
import {
  CUTLORD_PRESETS,
  DEFAULT_CUTLORD_SETTINGS,
  effectiveSettings,
  vadDetectOpts,
  dbDetectOpts,
  padDbRegions,
  wordCutPad,
  mergeStagedSilences,
  buildSilenceChips,
  type CutLordSettings
} from '../src/shared/cutlord'
import type { SilenceRegion, Word } from '../src/shared/types'

let ok = true
const check = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) ok = false
}

console.log('1) presets map to detect options per the spec')
const smooth: CutLordSettings = { ...DEFAULT_CUTLORD_SETTINGS }
const oSmooth = vadDetectOpts(smooth)
check('smooth: VAD 50% / trim 100ms / pad 40ms / min gap 0.15', oSmooth.vadThreshold === 0.5 && oSmooth.edgeTrimMs === 100 && oSmooth.speechPadMs === 40 && oSmooth.minDuration === 0.15 && oSmooth.mode === 'vad')
check('smooth: no dB pass', effectiveSettings(smooth).useDb === false)
const agg: CutLordSettings = { ...DEFAULT_CUTLORD_SETTINGS, mode: 'aggressive' }
const oAgg = vadDetectOpts(agg)
check('aggressive: VAD 70% / trim 250ms / pad 20ms / min gap 0.10', oAgg.vadThreshold === 0.7 && oAgg.edgeTrimMs === 250 && oAgg.speechPadMs === 20 && oAgg.minDuration === 0.1)
const oDb = dbDetectOpts(agg)
check('aggressive: dB pass -28dB / 0.1 min gap / fast mode', effectiveSettings(agg).useDb === true && oDb.noiseDb === -28 && oDb.minDuration === 0.1 && oDb.mode === 'fast')
check('trim-cuts feeds the word splice pad', wordCutPad(smooth) === 0.1 && wordCutPad(agg) === 0.25)

console.log('1b) Smooth modifier NEVER uses the fast dB pass — VAD only')
// even with a corrupted/stale persisted state carrying useDb=true:
const corrupted: CutLordSettings = { ...DEFAULT_CUTLORD_SETTINGS, mode: 'smooth', manual: false, useDb: true }
check('smooth (preset) forces useDb=false', effectiveSettings(corrupted).useDb === false)
check('smooth stays VAD-only regardless of stored db values', effectiveSettings({ ...corrupted, db: { noiseDb: -20, minGap: 0.05, padding: 0 } }).useDb === false)
check('aggressive still enables the dB pass', effectiveSettings({ ...DEFAULT_CUTLORD_SETTINGS, mode: 'aggressive' }).useDb === true)
check('manual keeps the user in charge', effectiveSettings({ ...DEFAULT_CUTLORD_SETTINGS, manual: true, useDb: true }).useDb === true)

console.log('2) manual switch overrides presets')
const manual: CutLordSettings = {
  mode: 'aggressive',
  manual: true,
  vad: { threshold: 0.6, trimCuts: 0.05, padding: 0.1, minGap: 0.3 },
  db: { noiseDb: -40, minGap: 0.2, padding: 0.02 },
  useDb: false
}
const oMan = vadDetectOpts(manual)
check('manual values used, preset ignored', oMan.vadThreshold === 0.6 && oMan.edgeTrimMs === 50 && oMan.speechPadMs === 100 && oMan.minDuration === 0.3)
check('manual can turn the dB pass off', effectiveSettings(manual).useDb === false)
check('manual wordCutPad', Math.abs(wordCutPad(manual) - 0.05) < 1e-9)

console.log('3) dB region padding')
const padded = padDbRegions([{ id: 'a', start: 1.0, end: 1.5, action: 'remove' }, { id: 'b', start: 2.0, end: 2.05, action: 'remove' }], agg)
check('regions shrunk by padding on both sides', padded.length === 1 && Math.abs(padded[0].start - 1.01) < 1e-9 && Math.abs(padded[0].end - 1.49) < 1e-9)

console.log('4) staged merge: union, dedupe, respect user regions')
const existing: SilenceRegion[] = [{ id: 'user', start: 5, end: 6, action: 'remove' }]
const merged = mergeStagedSilences(
  [
    [{ id: 'v1', start: 1.0, end: 1.4, action: 'remove' }, { id: 'v2', start: 5.2, end: 5.6, action: 'remove' }],
    [{ id: 'd1', start: 1.3, end: 1.7, action: 'remove' }]
  ],
  existing
)
check('overlapping VAD+dB regions merged into one', merged.length === 1 && merged[0].start === 1.0 && Math.abs(merged[0].end - 1.7) < 1e-9)
check('region overlapping a USER region dropped', !merged.some((r) => r.start >= 5 && r.start < 6))

console.log('5) inline silence chips')
const words: Word[] = [
  { id: 'w0', text: 'what', start: 0.0, end: 0.3 },
  { id: 'w1', text: 'if', start: 0.35, end: 0.5 }, // 50ms gap -> no chip
  { id: 'w2', text: 'chipotle', start: 0.9, end: 1.4 }, // 400ms gap -> chip
  { id: 'w3', text: 'O', start: 1.6, end: 1.7 }, // 200ms gap -> chip
  { id: 'w4', text: 'yes', start: 1.78, end: 1.95 } // 80ms gap, but staged -> chip
]
const staged: SilenceRegion[] = [{ id: 's1', start: 0.5, end: 0.9, action: 'remove' }, { id: 's2', start: 1.7, end: 1.78, action: 'remove' }]
const applied: SilenceRegion[] = [{ id: 'a1', start: 1.4, end: 1.6, action: 'remove' }]
const chips = buildSilenceChips(words, staged, applied)
check('gap under 0.2s without staging skipped… unless staged', chips.length === 3)
check('chip carries duration', chips.find((c) => c.afterWordId === 'w1')?.durS === 0.4)
check('staged chip linked for toggling', chips.find((c) => c.afterWordId === 'w1')?.stagedId === 's1')
check('applied chip marked', chips.find((c) => c.afterWordId === 'w2')?.applied === true)
check('short gap WITH staged region still gets a chip', chips.find((c) => c.afterWordId === 'w3')?.stagedId === 's2')

console.log(ok ? '\nCUTLORD OK' : '\nCUTLORD FAILED')
process.exit(ok ? 0 : 1)
