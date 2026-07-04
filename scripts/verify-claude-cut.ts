// Test the Claude (Opus 4.8) Smart Cut engine on a transcript with a SEMANTIC
// retake (same idea, different words) — the case gpt-4o kept missing.
// Needs ANTHROPIC_API_KEY in env or a *.env file.
//   npx tsx scripts/verify-claude-cut.ts
import { suggestCutsAI } from '../src/main/ai-cut'
import { claudeAvailable } from '../src/main/claude'
import { detectRepeatIds } from '../src/shared/fillers'
import type { Transcript, Word } from '../src/shared/types'

if (!claudeAvailable()) {
  console.error('No ANTHROPIC_API_KEY found. Add it to a *.env file first.')
  process.exit(1)
}
console.log('Using Claude (Opus 4.8) for Smart Cut.\n')

// A semantic retake ("let me explain" -> "let me actually walk you through"),
// a stutter ("the the"), and filler ("um", "you know").
const text =
  "um Let me explain how this works. Okay so let me actually walk you through how this works step by step. " +
  "First you take the the bottle and you know you shake it well."
const words: Word[] = text
  .split(/\s+/)
  .map((t, i) => ({ id: `w${i}`, text: t, start: i * 0.4, end: i * 0.4 + 0.35 }))
const transcript: Transcript = { words, segments: [{ id: 's', start: 0, end: words.length, words }] }

suggestCutsAI(transcript, (p, m) => process.stdout.write(`\r  ${p}% ${m ?? ''}            `))
  .then((res) => {
    const ids = new Set([...res.ids, ...detectRepeatIds(transcript)])
    console.log(`\n  flagged ${ids.size} words across ${res.cuts.length} cuts:\n`)
    for (const c of res.cuts) console.log(`   [${c.kind}] "${c.text}" — ${c.reason}`)
    const kept = words.filter((w) => !ids.has(w.id)).map((w) => w.text).join(' ')
    console.log(`\n  --- kept text ---\n   ${kept}`)
  })
  .catch((e) => {
    console.error('\nFAILED:', (e as Error).message)
    process.exit(1)
  })
