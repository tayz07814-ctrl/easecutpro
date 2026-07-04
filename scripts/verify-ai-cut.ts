// Test the AI cut suggester (gpt-4o) + heuristic union on a realistic transcript
// with the kinds of repeats a talking-head video has. Needs OPENAI_API_KEY.
//   npx tsx scripts/verify-ai-cut.ts
import { suggestCutsAI } from '../src/main/ai-cut'
import { detectRepeatIds } from '../src/shared/fillers'
import { openaiAvailable } from '../src/main/openai'
import type { Transcript, Word } from '../src/shared/types'

if (!openaiAvailable()) {
  console.error('No OPENAI_API_KEY found. Add it to a *.env file first.')
  process.exit(1)
}

// Two real cases: (1) THREE takes of "one of the most…" — keep only the final
// take, cut all earlier incl. the first fragment; (2) "but most importantly" used
// for THREE DIFFERENT points — keep all three, only collapse the doubled stutter.
const text =
  "One of the most power one of the most one of the most powerful prescription dark spot removers on the market. " +
  "But most importantly, but most importantly, it's gonna help strengthen. " +
  "But most importantly, it's gonna help restore your skin barrier."
const words: Word[] = text
  .split(/\s+/)
  .map((t, i) => ({ id: `w${i}`, text: t, start: i * 0.4, end: i * 0.4 + 0.35 }))
const transcript: Transcript = { words, segments: [{ id: 's', start: 0, end: words.length, words }] }

suggestCutsAI(transcript, (p, m) => process.stdout.write(`\r  ${p}% ${m ?? ''}            `))
  .then((res) => {
    // Mirror the app: union AI cuts with the deterministic heuristic repeats.
    const ids = new Set([...res.ids, ...detectRepeatIds(transcript)])
    console.log(`\n  AI flagged ${res.ids.length}, +heuristic = ${ids.size} total:\n`)
    for (const c of res.cuts) console.log(`   [AI ${c.kind}] "${c.text}" — ${c.reason}`)
    const heur = detectRepeatIds(transcript).filter((id) => !res.ids.includes(id))
    if (heur.length) console.log(`   [heuristic only] ${heur.map((id) => words.find((w) => w.id === id)!.text).join(' ')}`)
    const kept = words.filter((w) => !ids.has(w.id)).map((w) => w.text).join(' ')
    console.log(`\n  --- kept text ---\n   ${kept}`)
  })
  .catch((e) => {
    console.error('\nFAILED:', (e as Error).message)
    process.exit(1)
  })
