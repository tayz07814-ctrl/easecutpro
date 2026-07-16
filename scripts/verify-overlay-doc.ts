// Headless tests for the overlay revamp: Phase 0 (doc-native placement + keyword
// word-boundary fix) and Phase 1 (occurrence selection, name-only rules).
// Run: npx tsx scripts/verify-overlay-doc.ts
import { projectToDocument, normalizeDefaultLanes, overlayEventsToDocClips } from '../src/shared/timeline/bridge'
import { keywordFallback, validateAndCleanEvents } from '../src/shared/overlay'
import { generateOverlayTimeline } from '../src/main/overlay-rules'
import { framesToSeconds } from '../src/shared/timeline/time'
import type { OverlayAsset, OverlayEvent, OverlayRule, Project, Segment, Transcript, Word } from '../src/shared/types'

let fails = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) fails++
}

// --- fixture: 60s video, manual cut 10–20s -> main lane = [0-10s][20-60s] edited gaplessly
const project = {
  name: 'verify',
  media: { path: '/v/test.mp4', duration: 60, width: 1920, height: 1080, fps: 30, hasAudio: true, hasVideo: true },
  silences: [],
  manualCuts: [{ start: 10, end: 20 }],
  keepOverrides: [],
  baseSplits: [],
  tracks: [],
  texts: [],
  playhead: 0,
  pxPerSec: 80,
  aspectW: 16,
  aspectH: 9
} as unknown as Project

const doc = normalizeDefaultLanes(projectToDocument(project))
const assets: OverlayAsset[] = [{ id: 'ov1', file: 'card.png', name: 'Card' }]
const events: OverlayEvent[] = [
  { overlayId: 'ov1', start: 5, end: 8, position: 'top_center', animation: 'pop', reason: 'before the cut' },
  { overlayId: 'ov1', start: 25, end: 28, position: 'bottom_left', animation: 'fade', reason: 'after the cut' },
  { overlayId: 'ov1', start: 12, end: 15, position: 'center', animation: 'none', reason: 'inside the cut' }
]

console.log('=== overlayEventsToDocClips: source seconds -> edited frames on the overlay lane ===')
const { clips, skipped } = overlayEventsToDocClips(doc, project, events, assets)

check('places the two events whose footage survives the cut', clips.length === 2, `got ${clips.length}`)
check('skips the event inside cut footage', skipped.length === 1 && skipped[0].includes('12.0s'), skipped.join('; '))

const lane = doc.tracks.filter((t) => t.kind === 'video' && !t.isMain).sort((a, b) => a.order - b.order)[0]
check('clips land on the first overlay lane', clips.every((c) => c.trackId === lane?.id))

// source 5s is before the cut -> edited 5s; source 25s is after the 10s cut -> edited 15s
const t0 = framesToSeconds(clips[0]?.start ?? -1, doc.timebase)
const t1 = framesToSeconds(clips[1]?.start ?? -1, doc.timebase)
check('event at source 5s stays at edited 5s', Math.abs(t0 - 5) < 0.05, `${t0.toFixed(2)}s`)
check('event at source 25s maps to edited 15s', Math.abs(t1 - 15) < 0.05, `${t1.toFixed(2)}s`)

const m = clips[0]?.metadata ?? {}
check('clip carries the AI metadata (rule id / animation / reason)',
  m.overlayRuleId === 'ov1' && m.overlayAnimation === 'pop' && String(m.overlayReason).includes('before'))
check('clip carries the position box', typeof m.ovX === 'number' && typeof m.ovY === 'number' && typeof m.ovScale === 'number')
check('clip is an image with the asset file', clips[0]?.kind === 'image' && clips[0]?.sourcePath === 'card.png')

console.log('\n=== keywordFallback: word-boundary matching (no substring false hits) ===')
const mkSentences = (texts: string[]): { index: number; text: string; start: number; end: number }[] =>
  texts.map((text, index) => ({ index, text, start: index * 5, end: index * 5 + 4 }))

const rules: OverlayRule[] = [
  { overlayId: 'ov1', name: 'Art', instruction: 'show when I mention art or tea', position: 'center', durationSeconds: 3, animation: 'none' }
]
const falseHits = keywordFallback(rules, mkSentences(['Let us start the review instead.', 'This team is great.']))
check('"art"/"tea" do NOT match inside "start"/"instead"/"team"', falseHits.length === 0, `${falseHits.length} hit(s)`)

const realHits = keywordFallback(rules, mkSentences(['I love art, honestly.', 'Drinking tea helps me.']))
check('"art" and "tea" still match as real words (with punctuation)', realHits.length === 2, `${realHits.length} hit(s)`)

console.log('\n=== occurrence selection: deterministic "first / last / every mention" ===')
const occOpts = { duration: 60, cuts: [] }
const mkRule = (occurrence?: OverlayRule['occurrence']): OverlayRule[] => [
  { overlayId: 'ov1', name: 'Card', instruction: 'x', position: 'top_center', durationSeconds: 3, animation: 'pop', occurrence }
]
const threeMentions: Array<Partial<OverlayEvent>> = [
  { overlayId: 'ov1', start: 5, end: 8, reason: 'mention 1' },
  { overlayId: 'ov1', start: 20, end: 23, reason: 'mention 2' },
  { overlayId: 'ov1', start: 40, end: 43, reason: 'mention 3' }
]
const first = validateAndCleanEvents(threeMentions, mkRule('first'), occOpts)
check("'first' keeps only the earliest mention", first.events.length === 1 && first.events[0].start === 5,
  first.events.map((e) => e.start).join(','))
const last = validateAndCleanEvents(threeMentions, mkRule('last'), occOpts)
check("'last' keeps only the latest mention", last.events.length === 1 && last.events[0].start === 40,
  last.events.map((e) => e.start).join(','))
const every = validateAndCleanEvents(threeMentions, mkRule('every'), occOpts)
check("'every' keeps all mentions (within caps)", every.events.length === 3, `${every.events.length}`)
// 'first' means first mention the VIEWER hears: a mention whose footage is cut
// is rejected at normalization, so the next surviving mention is promoted.
const firstCut = validateAndCleanEvents(threeMentions, mkRule('first'), { duration: 60, cuts: [{ start: 4, end: 10 }] })
check("'first' promotes the next surviving mention when mention 1 is cut",
  firstCut.events.length === 1 && firstCut.events[0].start === 20, firstCut.events.map((e) => e.start).join(','))

console.log('\n=== name-only rules: a named image with no instruction still matches ===')
let wid = 0
const mkSeg = (text: string, start: number): Segment => {
  const words: Word[] = text.split(' ').map((t, k) => ({ id: `w${wid++}`, text: t, start: +(start + k * 0.3).toFixed(2), end: +(start + k * 0.3 + 0.3).toFixed(2) }))
  return { id: `s${start}`, start, end: words[words.length - 1].end, words }
}
const segs = [mkSeg('Welcome back to another video everyone.', 0), mkSeg('My bloating is finally gone after two weeks.', 4)]
const transcript: Transcript = { segments: segs, words: segs.flatMap((s) => s.words) }
const nameAssets: OverlayAsset[] = [{ id: 'a1', file: 'b.png', name: 'Bloating' }]
const nameRules: OverlayRule[] = [{ overlayId: 'a1', name: 'Bloating', instruction: '', position: 'top_center', durationSeconds: 3, animation: 'pop', occurrence: 'first' }]
const gen = await generateOverlayTimeline(transcript, nameAssets, nameRules, { duration: 12, cuts: [] })
check('empty-instruction rule matches via its NAME (keyword path, no API key)',
  gen.events.length === 1 && gen.events[0].start >= 4, `${gen.events.length} event(s) via ${gen.via}`)

console.log(fails === 0 ? '\nAll checks passed.' : `\n${fails} CHECK(S) FAILED`)
process.exit(fails === 0 ? 0 : 1)
