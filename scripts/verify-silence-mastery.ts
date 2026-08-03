// Headless tests for the Silence Mastery engine (shared/silenceMastery.ts).
// Run: npx tsx scripts/verify-silence-mastery.ts
import {
  planSilenceMastery,
  normalizeSilenceMastery,
  DEFAULT_SILENCE_MASTERY_SETTINGS,
  type SilenceMasterySettings,
  type SpeechSpan
} from '../src/shared/silenceMastery'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? '✓' : '✗ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const S = (p?: Partial<SilenceMasterySettings>): SilenceMasterySettings => ({
  ...DEFAULT_SILENCE_MASTERY_SETTINGS,
  ...p
})
const fmt = (rs: { start: number; end: number }[]): string =>
  rs.map((r) => `[${r.start.toFixed(2)},${r.end.toFixed(2)}]`).join(' ')
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9

console.log('1) the spec example — 15s video, words at 3–7 and 9–12')
{
  // "word 1 starts at 3 sec and word 5 ends at 7 sec" … "word 6 starts at 9,
  // word 10 ends at 12" → remove 0–3, 7–9, 12–15 (pads/trim zeroed for the
  // literal example).
  const words: SpeechSpan[] = [
    { start: 3, end: 4 }, { start: 4, end: 5 }, { start: 5, end: 6 }, { start: 6, end: 6.5 }, { start: 6.5, end: 7 },
    { start: 9, end: 10 }, { start: 10, end: 10.8 }, { start: 10.8, end: 11.3 }, { start: 11.3, end: 11.7 }, { start: 11.7, end: 12 }
  ]
  const cuts = planSilenceMastery(words, 15, S({ padLeftMs: 0, padRightMs: 0, trimEdgesMs: 0 }))
  check('exactly three cuts', cuts.length === 3, fmt(cuts))
  check('leading 0–3 removed', near(cuts[0].start, 0) && near(cuts[0].end, 3))
  check('gap 7–9 removed', near(cuts[1].start, 7) && near(cuts[1].end, 9))
  check('trailing 12–15 removed', near(cuts[2].start, 12) && near(cuts[2].end, 15))
  check('all cuts protect:true remove', cuts.every((c) => c.protect === true && c.action === 'remove'))
}

console.log('2) min silence gates gaps')
{
  const words: SpeechSpan[] = [{ start: 0, end: 1 }, { start: 1.3, end: 2 }, { start: 4, end: 5 }]
  const cuts = planSilenceMastery(words, 5, S({ minSilenceS: 0.5, padLeftMs: 0, padRightMs: 0 }))
  check('0.3s beat kept, 2s gap cut', cuts.length === 1 && near(cuts[0].start, 2) && near(cuts[0].end, 4), fmt(cuts))
  const none = planSilenceMastery(words, 5, S({ minSilenceS: 3, padLeftMs: 0, padRightMs: 0 }))
  check('min above every gap → nothing cut', none.length === 0)
}

console.log('3) pads keep silence at the gap edges')
{
  const words: SpeechSpan[] = [{ start: 0, end: 2 }, { start: 5, end: 7 }]
  const cuts = planSilenceMastery(words, 7, S({ padLeftMs: 200, padRightMs: 100, trimEdgesMs: 0 }))
  check('cut shrunk by padLeft on the left', cuts.length === 1 && near(cuts[0].start, 2.2), fmt(cuts))
  check('cut shrunk by padRight on the right', near(cuts[0].end, 4.9))
  // Pads bigger than the gap swallow the cut entirely.
  const tight: SpeechSpan[] = [{ start: 0, end: 2 }, { start: 2.6, end: 4 }]
  const gone = planSilenceMastery(tight, 4, S({ minSilenceS: 0.5, padLeftMs: 400, padRightMs: 400 }))
  check('pads ≥ gap → no cut', gone.length === 0, fmt(gone))
}

console.log('4) trim edges moves the cutter INTO the words')
{
  const words: SpeechSpan[] = [{ start: 0, end: 2 }, { start: 5, end: 7 }]
  const cuts = planSilenceMastery(words, 7, S({ padLeftMs: 0, padRightMs: 0, trimEdgesMs: 150 }))
  check('left edge bites 150ms into the ending word', cuts.length === 1 && near(cuts[0].start, 1.85), fmt(cuts))
  check('right edge bites 150ms into the starting word', near(cuts[0].end, 5.15))
  // Trim can never pass a word's midpoint, no matter the setting vs word size.
  const tiny: SpeechSpan[] = [{ start: 0, end: 0.2 }, { start: 3, end: 3.2 }]
  const clamped = planSilenceMastery(tiny, 3.2, S({ padLeftMs: 0, padRightMs: 0, trimEdgesMs: 300 }))
  check('trim clamped at word midpoints', clamped.length === 1 && near(clamped[0].start, 0.1) && near(clamped[0].end, 3.1), fmt(clamped))
}

console.log('5) leading/trailing follow the same rules')
{
  const words: SpeechSpan[] = [{ start: 1, end: 2 }, { start: 2.2, end: 3 }]
  const cuts = planSilenceMastery(words, 10, S({ minSilenceS: 0.5, padLeftMs: 100, padRightMs: 100, trimEdgesMs: 0 }))
  check('leading cut starts at 0 (no left pad against nothing)', cuts.length === 2 && near(cuts[0].start, 0), fmt(cuts))
  check('leading cut keeps padRight before the first word', near(cuts[0].end, 0.9))
  check('trailing cut keeps padLeft after the last word', near(cuts[1].start, 3.1))
  check('trailing cut runs to the end of the media', near(cuts[1].end, 10))
  const shortLead: SpeechSpan[] = [{ start: 0.3, end: 2 }]
  const noLead = planSilenceMastery(shortLead, 2, S({ minSilenceS: 0.5 }))
  check('sub-threshold leading silence kept', noLead.length === 0, fmt(noLead))
}

console.log('6) degenerate inputs stay sane')
{
  check('no words → whole runtime cut', fmt(planSilenceMastery([], 8, S())) === '[0.00,8.00]')
  check('no words, short clip under min → nothing', planSilenceMastery([], 0.2, S()).length === 0)
  const overlap: SpeechSpan[] = [{ start: 1, end: 3 }, { start: 2, end: 4 }] // ASR overlap
  const oCuts = planSilenceMastery(overlap, 4.2, S({ minSilenceS: 0.1, padLeftMs: 0, padRightMs: 0 }))
  check('overlapping words → no phantom gap cut between them', !oCuts.some((c) => c.start >= 1 && c.end <= 4), fmt(oCuts))
  const junk = planSilenceMastery([{ start: NaN, end: 2 }, { start: 5, end: 5 }], 6, S({ padLeftMs: 0, padRightMs: 0 }))
  check('invalid words ignored (falls back to whole-runtime cut)', junk.length === 1 && near(junk[0].start, 0) && near(junk[0].end, 6), fmt(junk))
  const n = normalizeSilenceMastery({ minSilenceS: -4, padLeftMs: 1e9, trimEdgesMs: NaN })
  check('normalize clamps garbage', n.minSilenceS === 0.05 && n.padLeftMs === 1000 && n.trimEdgesMs === DEFAULT_SILENCE_MASTERY_SETTINGS.trimEdgesMs)
}

console.log('7) ids are stable and ordered')
{
  const words: SpeechSpan[] = [{ start: 2, end: 3 }, { start: 6, end: 7 }]
  const cuts = planSilenceMastery(words, 10, S({ padLeftMs: 0, padRightMs: 0 }))
  check('ids sm0..smN in time order', cuts.map((c) => c.id).join(',') === 'sm0,sm1,sm2' && cuts.every((c, i) => i === 0 || c.start >= cuts[i - 1].end))
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall silence-mastery checks green')
process.exit(failures ? 1 : 0)
