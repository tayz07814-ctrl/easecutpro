// Headless test for AI overlay placement. Part A hits the real LLM; Part B tests
// the deterministic validation/fallback paths. Run: npx tsx scripts/verify-overlay-rules.ts
import { generateOverlayTimeline } from '../src/main/overlay-rules'
import { keywordFallback, validateAndCleanEvents, chunkTranscript } from '../src/shared/overlay'
import type { OverlayAsset, OverlayRule, Segment, Transcript, Word } from '../src/shared/types'

let wid = 0
function seg(text: string, start: number): Segment {
  const toks = text.split(' ')
  const d = 0.3
  const words: Word[] = toks.map((t, k) => ({ id: `w${wid++}`, text: t, start: +(start + k * d).toFixed(2), end: +(start + k * d + d).toFixed(2) }))
  return { id: `s${start}`, start, end: words[words.length - 1].end, words }
}
const LINES = [
  'So I have been using this gut health supplement for about a month now.',
  'Honestly the bloating I used to get after every single meal is basically gone now.', // bloating
  'My stomach feels so much lighter and flatter these days.',                            // bloating (lighter)
  'I am also sleeping way better and waking up actually refreshed in the morning.',      // sleep
  'And right now they have a fifty percent off promo code for a limited time only.',     // discount
  'Anyway that is my honest review of the product so far.'
]
let t = 0
const segments: Segment[] = LINES.map((l) => { const g = seg(l, t); t = g.end + 0.4; return g })
const transcript: Transcript = { segments, words: segments.flatMap((s) => s.words) }
const duration = transcript.words[transcript.words.length - 1].end + 0.5

const assets: OverlayAsset[] = [
  { id: 'overlay_1', file: 'no-bloating.png', name: 'No Bloating' },
  { id: 'overlay_2', file: 'better-sleep.png', name: 'Better Sleep' },
  { id: 'overlay_3', file: 'discount-code.png', name: 'Discount' },
  { id: 'overlay_4', file: 'energy.png', name: 'More Energy' }
]
const rules: OverlayRule[] = [
  { overlayId: 'overlay_1', name: 'No Bloating', instruction: 'Show this when I talk about bloating, digestion, gut health, or my stomach feeling lighter.', position: 'top_center', durationSeconds: 3, animation: 'pop' },
  { overlayId: 'overlay_2', name: 'Better Sleep', instruction: 'Show this when I mention sleeping better, waking up refreshed, or not feeling tired.', position: 'top_right', durationSeconds: 3, animation: 'fade' },
  { overlayId: 'overlay_3', name: 'Discount', instruction: 'Show this when I mention 50% off, a promo code, or a limited-time offer.', position: 'bottom_center', durationSeconds: 3, animation: 'none' },
  { overlayId: 'overlay_4', name: 'More Energy', instruction: 'Show this when I mention having tons of energy or powering through tough workouts.', position: 'center', durationSeconds: 3, animation: 'pop' } // distractor: never said
]

console.log('=== Part A: local-first matching (expect via:keyword; distractor finds nothing) ===')
const res = await generateOverlayTimeline(transcript, assets, rules, { duration, cuts: [] }, (p, m) => process.stdout.write(`\r  ${p}% ${m ?? ''}            `))
console.log('\n  via:', res.via)
for (const e of res.events) {
  const name = assets.find((a) => a.id === e.overlayId)?.name
  console.log(`  ${name}  ${e.start.toFixed(1)}-${e.end.toFixed(1)}s  [${e.position}/${e.animation}]  ${e.reason}`)
}
console.log('  log:'); res.log.forEach((l) => console.log('   ', l))

console.log('\n=== Part B: deterministic edge cases ===')
const sentences = chunkTranscript(transcript)

// (case: keyword fallback path, no LLM)
const kw = keywordFallback(rules, sentences)
console.log(`  [fallback] keyword matcher produced ${kw.length} raw candidate(s)`)

// (case 5: overlapping events -> de-overlap keeps one)
const overlapRaw = [
  { overlayId: 'overlay_1', start: 5, end: 8, reason: 'a' },
  { overlayId: 'overlay_2', start: 6, end: 9, reason: 'b (overlaps a)' }
]
const ov = validateAndCleanEvents(overlapRaw, rules, { duration: 60, cuts: [] })
console.log(`  [overlap] 2 overlapping in -> ${ov.events.length} kept (expect 1), rejected: ${ov.rejected.length}`)

// (case: event inside a cut-out section -> dropped)
const cutRaw = [{ overlayId: 'overlay_1', start: 10, end: 13, reason: 'in cut' }]
const cut = validateAndCleanEvents(cutRaw, rules, { duration: 60, cuts: [{ start: 9, end: 15 }] })
console.log(`  [cut-out] event in cut -> ${cut.events.length} kept (expect 0)`)

// (case 4: garbage/invalid candidates -> rejected, never throws)
const badRaw = [{ overlayId: 'nope', start: 5 }, { overlayId: 'overlay_1', start: NaN }] as any
const bad = validateAndCleanEvents(badRaw, rules, { duration: 60, cuts: [] })
console.log(`  [invalid] bad candidates -> ${bad.events.length} kept (expect 0), rejected: ${bad.rejected.length}`)
