// End-to-end check of the Node->Python Fast Cut adapter (spawn, JSON round-trip,
// time-range -> word-id mapping). Run: npx tsx scripts/verify-fast-cut.ts
import { readFileSync } from 'fs'
import { fastCutSuggest } from '../src/main/fast-cut'
import type { Transcript, Word } from '../src/shared/types'

const raw = JSON.parse(readFileSync('fastcut/sample_words.json', 'utf-8')) as Array<{
  word: string; start: number; end: number
}>
const words: Word[] = raw.map((w, i) => ({ id: `w${i}`, text: w.word, start: w.start, end: w.end }))
const transcript: Transcript = { words, segments: [{ id: 's0', start: 0, end: words.at(-1)!.end, words }] }

const res = await fastCutSuggest(transcript, (p, m) => process.stdout.write(`\r  ${p}% ${m ?? ''}            `))
console.log('\n\nflagged ids:', res.ids.length)
for (const c of res.cuts) console.log(`  [${c.kind}] "${c.text}"`)

const cutIds = new Set(res.ids)
const kept = words.filter((w) => !cutIds.has(w.id)).map((w) => w.text).join(' ')
console.log('\nKEPT:', kept)
