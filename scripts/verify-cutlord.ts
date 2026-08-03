// Headless tests for Cut Lord pure logic (shared/cutlord.ts).
// Run: npx tsx scripts/verify-cutlord.ts
// (The VAD/dB detection helpers were removed with the silence engines; what
// remains is the settings shape, the word-splice pad, and the silence chips.)
import {
  DEFAULT_CUTLORD_SETTINGS,
  wordCutPad,
  buildSilenceChips,
  type CutLordSettings
} from '../src/shared/cutlord'
import type { SilenceRegion, Word } from '../src/shared/types'

let ok = true
const check = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) ok = false
}

console.log('1) trim-cuts feeds the word splice pad')
const smooth: CutLordSettings = { ...DEFAULT_CUTLORD_SETTINGS }
const agg: CutLordSettings = { ...DEFAULT_CUTLORD_SETTINGS, mode: 'aggressive', vad: { ...DEFAULT_CUTLORD_SETTINGS.vad, trimCuts: 0.25 }, manual: true }
check('preset wordCutPad', wordCutPad(smooth) === 0.1)
check('manual wordCutPad', Math.abs(wordCutPad(agg) - 0.25) < 1e-9)

console.log('2) inline silence chips')
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
