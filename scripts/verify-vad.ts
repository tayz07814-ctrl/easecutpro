// Validate Silero-VAD silence detection end-to-end (the same detectSilence the app calls).
//   npx tsx scripts/verify-vad.ts <video>
import { detectSilence } from '../src/main/ffmpeg'

const file = process.argv[2]
if (!file) {
  console.error('Usage: tsx scripts/verify-vad.ts <video>')
  process.exit(1)
}

async function main(): Promise<void> {
  console.log(`VAD on ${file} …`)
  const regions = await detectSilence(
    file,
    { noiseDb: -30, minDuration: 0.4, mode: 'vad', vadThreshold: 0.5, speechPadMs: 40 },
    (p) => process.stdout.write(`\r  ${p}%   `)
  )
  console.log(`\n  ${regions.length} non-speech region(s) to cut:`)
  for (const r of regions.slice(0, 15)) {
    console.log(`   ${r.start.toFixed(2)}–${r.end.toFixed(2)}s  (${(r.end - r.start).toFixed(2)}s)  ${r.action}`)
  }
  if (regions.length > 15) console.log(`   … +${regions.length - 15} more`)
}

main().catch((e) => {
  console.error('\nFAILED:', (e as Error)?.message ?? e)
  process.exit(1)
})
