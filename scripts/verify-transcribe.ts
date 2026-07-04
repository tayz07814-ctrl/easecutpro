// End-to-end transcribe test with the new VAD-gated, anti-hallucination flags.
//   npx tsx scripts/verify-transcribe.ts <video>
import { transcribe } from '../src/main/whisper'

const file = process.argv[2]
if (!file) {
  console.error('Usage: tsx scripts/verify-transcribe.ts <video>')
  process.exit(1)
}

transcribe(file, (p, m) => process.stdout.write(`\r  ${p}% ${m ?? ''}            `))
  .then((t) => {
    console.log(`\n  ${t.words.length} words · ${t.segments.length} segments`)
    console.log('  --- first lines ---')
    for (const s of t.segments.slice(0, 6)) {
      console.log(`   [${s.start.toFixed(1)}s] ${s.words.map((w) => w.text).join(' ')}`)
    }
  })
  .catch((e) => {
    console.error('\nFAILED:', (e as Error).message)
    process.exit(1)
  })
