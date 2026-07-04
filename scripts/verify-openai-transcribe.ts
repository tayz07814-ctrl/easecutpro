// End-to-end test of the premium-merge OpenAI backend (gpt-4o-transcribe text +
// whisper-1 timestamps, aligned). Needs OPENAI_API_KEY in env or .env.
//   npx tsx scripts/verify-openai-transcribe.ts <video-or-audio>
import { transcribeOpenAI } from '../src/main/openai-transcribe'
import { openaiAvailable } from '../src/main/openai'

const file = process.argv[2]
if (!file) {
  console.error('Usage: tsx scripts/verify-openai-transcribe.ts <video-or-audio>')
  process.exit(1)
}
if (!openaiAvailable()) {
  console.error('No OPENAI_API_KEY found. Add it to .env or the environment first.')
  process.exit(1)
}

transcribeOpenAI(file, (p, m) => process.stdout.write(`\r  ${p}% ${m ?? ''}                    `))
  .then((t) => {
    console.log(`\n  ${t.words.length} words · ${t.segments.length} segments`)
    console.log('  --- first lines (clean text + merged timing) ---')
    for (const s of t.segments.slice(0, 8)) {
      console.log(`   [${s.start.toFixed(1)}s] ${s.words.map((w) => w.text).join(' ')}`)
    }
    // sanity: timing must be monotonic and finite
    let bad = 0
    for (let i = 1; i < t.words.length; i++) {
      const a = t.words[i - 1]
      const b = t.words[i]
      if (!(b.start >= a.start - 1e-6) || !(b.end >= b.start)) bad++
    }
    console.log(`  timing check: ${bad === 0 ? 'OK (monotonic)' : `${bad} ordering issues`}`)
  })
  .catch((e) => {
    console.error('\nFAILED:', (e as Error).message)
    process.exit(1)
  })
