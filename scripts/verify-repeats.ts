// Confirm the repeat detector catches real retakes but NOT phrases recurring in
// different sentences (connector gaps).  npx tsx scripts/verify-repeats.ts
import { detectRepeatIds } from '../src/shared/fillers'
import type { Transcript, Word } from '../src/shared/types'

function flags(text: string): string {
  const words: Word[] = text.split(/\s+/).map((txt, i) => ({ id: String(i), text: txt, start: i, end: i + 1 }))
  const t: Transcript = { words, segments: [{ id: 's0', start: 0, end: words.length, words }] }
  const ids = new Set(detectRepeatIds(t))
  return words.filter((w) => ids.has(w.id)).map((w) => w.text).join(' ') || '(none)'
}

const cases: [string, string][] = [
  ['real retake, gap 0 (SHOULD flag)', 'either see most people see most people brush their teeth'],
  ['retake w/ hesitation gap (SHOULD flag)', 'go to the store uh go to the store today'],
  ['picture 2 — connector gap "if" (should NOT flag)', 'i use this oil pulling rinse from white just switch this around for five minutes a day and if just switch this around for five minutes a day and it breaks down'],
  ['picture 1 — connector gap "but" (should NOT flag)', "the top selling brands on tick tock for a reason just trust me on this but just trust me on this but if you don't see that link"],
  ['2-word stutter "all I all I" (SHOULD flag one "all I")', 'you have all I all I do to take care of this'],
  ['leading "all" is content (should NOT flag the first all)', 'all that bacteria and plaque is just sitting there building up']
]
for (const [name, text] of cases) console.log(`${name}\n   -> ${flags(text)}\n`)
