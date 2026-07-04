// Prove the clean<-timed word alignment works WITHOUT any OpenAI call.
//   npx tsx scripts/verify-align.ts
import { alignWords, type TimedTok } from '../src/main/align'

let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond ? '' : `  <-- ${detail}`}`)
  if (!cond) failed++
}

// Build whisper-style timed tokens: one word per second.
function timed(words: string[], startAt = 0): TimedTok[] {
  return words.map((text, i) => ({ text, start: startAt + i, end: startAt + i + 0.8 }))
}

// --- Case 1: identical sequences -> clean text + whisper timing, 1:1 ---
{
  const clean = ['Hello', 'there', 'world']
  const t = timed(['hello', 'there', 'world'])
  const out = alignWords(clean, t)
  check('1 identical: same length', out.length === 3, `got ${out.length}`)
  check('1 identical: keeps clean casing', out[0].text === 'Hello')
  check('1 identical: borrows whisper timing', out[1].start === 1 && out[1].end === 1.8)
}

// --- Case 2: whisper hallucinated a repeated phrase gpt-4o doesn't have ---
//   clean (truth):  "brush their teeth"
//   whisper:        "brush their their teeth teeth"  (stutter/halluc)
{
  const clean = ['brush', 'their', 'teeth']
  const t = timed(['brush', 'their', 'their', 'teeth', 'teeth'])
  const out = alignWords(clean, t)
  check('2 halluc: collapses to clean 3 words', out.length === 3, `got ${out.map((w) => w.text).join(' ')}`)
  check('2 halluc: text is the clean version', out.map((w) => w.text).join(' ') === 'brush their teeth')
  // timing should be monotonic and within the whisper span [0, 4.8]
  const mono = out.every((w, i) => w.end > w.start && (i === 0 || w.start >= out[i - 1].start))
  check('2 halluc: timing monotonic & valid', mono)
}

// --- Case 3: gpt-4o has a word whisper MISSED -> interpolate timing ---
//   clean:   "I really like this"
//   whisper: "I like this"  (dropped "really")
{
  const clean = ['I', 'really', 'like', 'this']
  const t: TimedTok[] = [
    { text: 'i', start: 0, end: 0.5 },
    { text: 'like', start: 2, end: 2.5 },
    { text: 'this', start: 3, end: 3.5 }
  ]
  const out = alignWords(clean, t)
  check('3 missed word: all 4 clean words kept', out.length === 4, `got ${out.length}`)
  const really = out.find((w) => w.text === 'really')!
  check('3 missed word: "really" got interpolated timing', really.start >= 0.5 && really.end <= 2.01, `${really.start}-${really.end}`)
  const mono = out.every((w, i) => i === 0 || w.start >= out[i - 1].start - 1e-9)
  check('3 missed word: order preserved', mono)
}

// --- Case 4: word-level mismatch (there/their) -> keep clean text, whisper time ---
{
  const clean = ['walk', 'over', 'there']
  const t = timed(['walk', 'over', 'their'])
  const out = alignWords(clean, t)
  check('4 mismatch: clean text wins', out[2].text === 'there')
  check('4 mismatch: whisper timing used', out[2].start === 2)
}

// --- Case 5: chunk offset applied to all timestamps ---
{
  const clean = ['a', 'b']
  const t = timed(['a', 'b'])
  const out = alignWords(clean, t, 600) // chunk starts at 10 min
  check('5 offset: timestamps shifted by 600s', out[0].start === 600 && out[1].start === 601)
}

// --- Case 6: empty clean (gpt-4o returned nothing) -> empty output ---
{
  const out = alignWords([], timed(['a', 'b']))
  check('6 empty clean: produces no words', out.length === 0)
}

console.log(`\n${failed === 0 ? 'ALL PASSED' : `${failed} FAILED`}`)
process.exit(failed === 0 ? 0 : 1)
