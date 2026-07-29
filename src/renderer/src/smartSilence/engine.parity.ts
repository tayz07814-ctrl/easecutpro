// Smart Silence Cleaner — parity check.
//
// Mirrors smart_silence_cleaner/tests/test_engine.py one-for-one. These lock the
// canonical behaviour the TypeScript port must reproduce EXACTLY.
//
// Run:  npx tsx src/renderer/src/smartSilence/engine.parity.ts
// Prints a summary and exits non-zero if any assertion fails.

import { planSilence } from './engine'
import { getPreset, allPresets } from './presets'
import { copySettings } from './settings'
import { SAMPLE_DURATION_MS, sampleWords } from './sampleData'
import type { Word } from './types'

let checks = 0
let fails = 0

function check(name: string, cond: boolean, detail = ''): void {
  checks++
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    fails++
    console.log(`  FAIL ${name}  ${detail}`)
  }
}

function w(start: number, end: number, text = 'word'): Word {
  return { startMs: start, endMs: end, text }
}

function testTrimToTarget(): void {
  // 900ms gap, mid-sentence, Balanced (target 180) -> removes exactly 720ms.
  const words = [w(0, 1000, 'hello'), w(1900, 2400, 'there')] // gap = 900
  const s = getPreset('balanced').settings
  const plan = planSilence(words, s, 2400)
  check('one cut produced', plan.cuts.length === 1, `cuts=${plan.cuts.length}`)
  if (plan.cuts.length) {
    const cut = plan.cuts[0]
    const removed = cut.removedMs
    check('removed == 720ms (900-180)', Math.abs(removed - 720) < 1.0, `removed=${removed}`)
    const keptPause = 900 - removed
    check('kept pause == target 180ms', Math.abs(keptPause - 180) < 1.0, `kept=${keptPause}`)
    // SYMMETRIC split: 90ms (target/2) of silence retained on EACH side.
    const silenceBefore = cut.startMs - 1000 // after current word (end=1000)
    const silenceAfter = 1900 - cut.endMs // before next word (start=1900)
    check('90ms kept after current word', Math.abs(silenceBefore - 90) < 1.0, `before=${silenceBefore}`)
    check('90ms kept before next word', Math.abs(silenceAfter - 90) < 1.0, `after=${silenceAfter}`)
    check(
      'split is symmetric (both sides equal)',
      Math.abs(silenceBefore - silenceAfter) < 0.5,
      `before=${silenceBefore} after=${silenceAfter}`,
    )
  }
}

function testBelowThresholdKept(): void {
  // A gap under min_gap is left completely alone.
  const words = [w(0, 1000), w(1200, 1600)] // gap 200 < balanced min_gap 300
  const s = getPreset('balanced').settings
  const plan = planSilence(words, s, 1600)
  check('no cut below min_gap', plan.cuts.length === 0, `cuts=${plan.cuts.length}`)
}

function testGaplessRemovesEverything(): void {
  // Aggressive Gapless: every gap > 80ms collapses to ~0 (whole gap removed).
  const words = [w(0, 1000), w(1300, 1700)] // gap 300
  const s = getPreset('aggressive_gapless').settings
  const plan = planSilence(words, s, 1700)
  check('gapless makes one cut', plan.cuts.length === 1, `cuts=${plan.cuts.length}`)
  if (plan.cuts.length) {
    check(
      'gapless removes the whole 300ms gap',
      Math.abs(plan.cuts[0].removedMs - 300) < 1.0,
      `removed=${plan.cuts[0].removedMs}`,
    )
  }
  // a 60ms gap (< 80 min) survives
  const words2 = [w(0, 1000), w(1060, 1400)]
  const plan2 = planSilence(words2, s, 1400)
  check('gapless keeps sub-80ms gap', plan2.cuts.length === 0, `cuts=${plan2.cuts.length}`)
}

function testPunctuationTargets(): void {
  // Sentence enders keep a longer pause than plain gaps (Smart Silence on).
  const s = getPreset('balanced').settings // sentence 350, comma 250, target 180
  const sent = planSilence([w(0, 1000, 'done.'), w(2000, 2400, 'next')], s, 2400) // gap 1000
  const plain = planSilence([w(0, 1000, 'and'), w(2000, 2400, 'then')], s, 2400) // gap 1000
  if (sent.cuts.length && plain.cuts.length) {
    const sentKept = 1000 - sent.cuts[0].removedMs
    const plainKept = 1000 - plain.cuts[0].removedMs
    check(
      'sentence pause (350) > plain pause (180)',
      sentKept > plainKept,
      `sent=${sentKept} plain=${plainKept}`,
    )
    check('sentence keeps ~350ms', Math.abs(sentKept - 350) < 1.0, `sent=${sentKept}`)
  }
}

function testSmartOffIsUniform(): void {
  // Smart Silence OFF ignores punctuation — sentence gap uses the plain target.
  const s = copySettings(getPreset('balanced').settings, { smartSilence: false })
  const sent = planSilence([w(0, 1000, 'done.'), w(2000, 2400, 'next')], s, 2400)
  if (sent.cuts.length) {
    const kept = 1000 - sent.cuts[0].removedMs
    check("smart-off keeps plain target 180 after '.'", Math.abs(kept - 180) < 1.0, `kept=${kept}`)
  }
}

function testFillerRemovalMerges(): void {
  // 'um' between two words is removed and the surrounding silence collapses.
  const words = [w(0, 1000, 'the'), w(1200, 1500, 'um'), w(1700, 2200, 'point')]
  const off = copySettings(getPreset('balanced').settings, { removeFillers: false })
  const on = copySettings(getPreset('balanced').settings, { removeFillers: true })
  const planOff = planSilence(words, off, 2200)
  const planOn = planSilence(words, on, 2200)
  check(
    'fillers off removes less than on',
    planOn.stats.timeSavedMs > planOff.stats.timeSavedMs,
    `off=${planOff.stats.timeSavedMs} on=${planOn.stats.timeSavedMs}`,
  )
  check(
    'filler count reported',
    planOn.stats.fillersRemoved === 1,
    `fillers=${planOn.stats.fillersRemoved}`,
  )
}

function testKeepsComplement(): void {
  // KEEP ranges are the exact complement of the cuts over [0, duration].
  const s = getPreset('aggressive').settings
  const words = [w(0, 1000), w(1800, 2400), w(3600, 4000)]
  const plan = planSilence(words, s, 4200)
  const covered: Array<[number, number]> = [
    ...plan.keeps,
    ...plan.cuts.map((c) => [c.startMs, c.endMs] as [number, number]),
  ].sort((a, b) => a[0] - b[0])
  let ok = covered.length > 0 && Math.abs(covered[0][0]) < 1e-6 && Math.abs(covered[covered.length - 1][1] - 4200) < 1e-6
  for (let i = 0; i + 1 < covered.length; i++) {
    if (Math.abs(covered[i][1] - covered[i + 1][0]) > 1e-6) ok = false
  }
  check('keeps+cuts tile the whole timeline', ok, `covered=${JSON.stringify(covered)}`)
}

function testSampleSmoke(): void {
  // The demo transcript runs and produces sane stats under every preset.
  for (const p of allPresets()) {
    const plan = planSilence(sampleWords(), p.settings, SAMPLE_DURATION_MS)
    const ok =
      plan.stats.timeSavedMs >= 0 &&
      plan.stats.timeSavedMs <= SAMPLE_DURATION_MS &&
      plan.stats.outputDurationMs <= SAMPLE_DURATION_MS &&
      plan.cuts.every((c) => c.endMs > c.startMs)
    check(
      `preset '${p.id}' produces a sane plan`,
      ok,
      `saved=${plan.stats.timeSavedMs.toFixed(0)} cuts=${plan.cuts.length}`,
    )
  }
}

function main(): number {
  const tests: Array<[string, () => void]> = [
    ['testTrimToTarget', testTrimToTarget],
    ['testBelowThresholdKept', testBelowThresholdKept],
    ['testGaplessRemovesEverything', testGaplessRemovesEverything],
    ['testPunctuationTargets', testPunctuationTargets],
    ['testSmartOffIsUniform', testSmartOffIsUniform],
    ['testFillerRemovalMerges', testFillerRemovalMerges],
    ['testKeepsComplement', testKeepsComplement],
    ['testSampleSmoke', testSampleSmoke],
  ]
  for (const [name, fn] of tests) {
    console.log(`\n${name}:`)
    fn()
  }
  console.log(`\n${checks - fails}/${checks} checks passed`)
  return fails ? 1 : 0
}

const code = main()
// Exit non-zero on failure when run directly under tsx/node.
if (typeof process !== 'undefined' && typeof process.exit === 'function') {
  process.exit(code)
}
