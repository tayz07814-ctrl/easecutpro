// Headless verification of the Batch Video Cleaner pipeline.
// Runs the REAL backend (ffmpeg probe + GPU whisper + silence detect) on a video
// and the SAME cleaning logic the UI uses, then prints a before/after summary.
//
//   npx tsx scripts/verify-batch-clean.ts "C:\vids1\some.mov"
import path from 'path'
import { probe, detectSilence } from '../src/main/ffmpeg'
import { transcribe } from '../src/main/whisper'
import { detectFillerIds, detectRepeatIds, DEFAULT_FILLERS } from '../src/shared/fillers'
import { createEmptyProject } from '../src/shared/project'
import { computeKeepRanges, editedDuration } from '../src/shared/edit'

const file = process.argv[2]
if (!file) {
  console.error('Usage: tsx scripts/verify-batch-clean.ts "<path-to-video>"')
  process.exit(1)
}
const fmt = (s: number): string => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

async function main(): Promise<void> {
  console.log(`\n=== Verifying Batch Video Cleaner on: ${file} ===\n`)

  console.log('1/3 Probing…')
  const info = await probe(file)
  console.log(`    ${fmt(info.duration)} (${info.duration.toFixed(1)}s), ${info.width}x${info.height}, fps ${info.fps}, audio=${info.hasAudio}`)

  console.log('2/3 Transcribing (whisper / GPU)…')
  const t = await transcribe(file, (p, m) => process.stdout.write(`\r    ${p}% ${m ?? ''}            `))
  console.log(`\n    ${t.words.length} words, ${t.segments.length} segments`)
  const fillerIds = detectFillerIds(t, DEFAULT_FILLERS)
  const repeatIds = detectRepeatIds(t)
  const fillers = new Set([...fillerIds, ...repeatIds])
  console.log(`    fillers: ${fillerIds.length}, repeats/retakes: ${repeatIds.length}  ->  ${fillers.size} words to remove`)

  console.log('3/3 Detecting silence…')
  const regions = await detectSilence(file, { noiseDb: -30, minDuration: 0.4 }, () => {})
  console.log(`    ${regions.length} silence regions`)

  // Build the cleaned project exactly as cleanVideo() does.
  const project = createEmptyProject(path.basename(file))
  project.media = {
    path: file,
    duration: info.duration,
    width: info.width,
    height: info.height,
    fps: info.fps,
    hasAudio: info.hasAudio,
    hasVideo: info.hasVideo
  }
  project.transcript = {
    words: t.words.map((w) => (fillers.has(w.id) ? { ...w, deleted: true } : w)),
    segments: t.segments.map((s) => ({ ...s, words: s.words.map((w) => (fillers.has(w.id) ? { ...w, deleted: true } : w)) }))
  }
  project.silences = regions.map((r) => ({ ...r, action: 'remove' as const }))

  const keeps = computeKeepRanges(project)
  const edited = editedDuration(project)

  console.log(`\n--- RESULT ---`)
  console.log(`  original : ${fmt(info.duration)}  (${info.duration.toFixed(1)}s)`)
  console.log(`  cleaned  : ${fmt(edited)}  (${edited.toFixed(1)}s)  across ${keeps.length} kept range(s)`)
  console.log(`  removed  : ${(info.duration - edited).toFixed(1)}s of fillers + silence`)
  if (edited <= 0 || edited > info.duration + 0.1) {
    console.log('  ⚠ SANITY CHECK FAILED — edited duration out of range')
    process.exit(2)
  }
  console.log('  ✓ sanity check passed — cleaned project is well-formed and editable\n')
}

main().catch((e) => {
  console.error('\nFAILED:', e?.message ?? e)
  process.exit(1)
})
