// Headless tests for the overlay revamp: Phase 0 (doc-native placement + keyword
// word-boundary fix) and Phase 1 (occurrence selection, name-only rules).
// Run: npx tsx scripts/verify-overlay-doc.ts
import { projectToDocument, normalizeDefaultLanes, overlayEventsToDocClips, labelSuggestionsToDocTextClips } from '../src/shared/timeline/bridge'
import { findShowMoments } from '../src/shared/overlay'
import { keywordFallback, validateAndCleanEvents, keywordOverlayTimeline, parseOverlayLlmResponse, chunkTranscript, parseOverlaySuggestions, buildOverlayUserMessage, buildSuggestUserMessage } from '../src/shared/overlay'
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

console.log('\n=== cloud matcher: keywordOverlayTimeline (browser path) matches the desktop keyword path ===')
const cloud = keywordOverlayTimeline(transcript, nameAssets, nameRules, { duration: 12, cuts: [] })
check('cloud keyword matcher places the same single name-only event',
  cloud.events.length === 1 && cloud.events[0].start >= 4 && cloud.via === 'keyword', `${cloud.events.length} via ${cloud.via}`)

console.log('\n=== semantic parse (shared by desktop LLM + cloud edge): index->time, confidence gate ===')
const sents = chunkTranscript(transcript) // [0]=0s "Welcome...", [1]=4s "My bloating..."
const rawGood = JSON.stringify({ events: [{ overlayId: 'a1', sentenceIndex: 1, confidence: 0.9, reason: 'bloating' }] })
const parsedGood = parseOverlayLlmResponse(rawGood, sents)
check('parses a match and maps sentenceIndex -> that sentence start time',
  parsedGood.events.length === 1 && Math.abs((parsedGood.events[0].start ?? -1) - sents[1].start) < 0.01,
  `start=${parsedGood.events[0]?.start}`)
const rawLow = JSON.stringify({ events: [{ overlayId: 'a1', sentenceIndex: 1, confidence: 0.2 }] })
check('drops a below-threshold-confidence match (logged)', parseOverlayLlmResponse(rawLow, sents).events.length === 0)
const rawBad = JSON.stringify({ events: [{ overlayId: 'a1', sentenceIndex: 99, confidence: 1 }] })
check('drops a hallucinated (out-of-range) sentence index', parseOverlayLlmResponse(rawBad, sents).events.length === 0)
check('tolerates junk / non-JSON without throwing', parseOverlayLlmResponse('not json', sents).events.length === 0)

console.log('\n=== Suggest parser: proposals -> reviewable suggestions (index->time, gate, pace, cut-avoid) ===')
let sid = 0
const sUid = (): string => `s${sid++}`
const sOpts = { duration: 30, cuts: [] as { start: number; end: number }[] }
const sugRaw = JSON.stringify({ suggestions: [
  { overlayId: 'a1', sentenceIndex: 1, position: 'bottom_center', confidence: 0.9, reason: 'bloating result' },
  { overlayId: 'a1', sentenceIndex: 0, position: 'garbage', confidence: 0.2, reason: 'too weak' },       // low conf -> dropped
  { overlayId: 'nope', sentenceIndex: 1, position: 'top_center', confidence: 0.9, reason: 'unknown id' }  // unknown overlay -> dropped
] })
const sug = parseOverlaySuggestions(sugRaw, sents, nameAssets, sOpts, sUid)
check('keeps the strong, known-overlay suggestion', sug.suggestions.length === 1 && sug.suggestions[0].overlayId === 'a1', `${sug.suggestions.length}`)
check('maps sentenceIndex -> real moment time', Math.abs(sug.suggestions[0].start - sents[1].start) < 0.01, `${sug.suggestions[0]?.start}`)
check('carries the triggering sentence + reason + confidence for the review card',
  !!sug.suggestions[0].sentence && !!sug.suggestions[0].reason && sug.suggestions[0].confidence === 0.9)
check('sanitizes an invalid position to a safe default', sug.suggestions[0].position === 'bottom_center')
check('assigns review ids', sug.suggestions[0].id === 's0')
// pacing: two very close strong proposals -> the crowding one is dropped
const closeRaw = JSON.stringify({ suggestions: [
  { overlayId: 'a1', sentenceIndex: 0, position: 'top_center', confidence: 0.9, reason: 'a' },
  { overlayId: 'a1', sentenceIndex: 1, position: 'top_center', confidence: 0.9, reason: 'b' }
] })
const closeSug = parseOverlaySuggestions(closeRaw, [{ index: 0, text: 'x', start: 0, end: 1 }, { index: 1, text: 'y', start: 1.0, end: 2 }], nameAssets, { duration: 30, cuts: [] }, () => 'z')
check('paces out proposals that would crowd each other', closeSug.suggestions.length === 1, `${closeSug.suggestions.length}`)

console.log('\n=== v1.5 vision: overlay description flows into the match + suggest prompts ===')
const mMsg = buildOverlayUserMessage([{ index: 0, text: 'hi' }], [{ overlayId: 'a1', name: 'Card', instruction: 'x', description: 'a red 50% OFF badge' }])
check('match prompt includes the overlay vision description', mMsg.includes('shows: a red 50% OFF badge'))
const mMsgNo = buildOverlayUserMessage([{ index: 0, text: 'hi' }], [{ overlayId: 'a1', name: 'Card', instruction: 'x' }])
check('match prompt omits "shows:" when there is no description', !mMsgNo.includes('shows:'))
const sMsg = buildSuggestUserMessage([{ index: 0, text: 'hi' }], [{ overlayId: 'a1', name: 'Card', description: 'a smiling before/after photo' }])
check('suggest prompt includes the overlay vision description', sMsg.includes('shows: a smiling before/after photo'))

console.log('\n=== moment vision: find "point-and-show" moments (deictic + repeated lines) ===')
const showSents = [
  { index: 0, text: 'Welcome to my skincare routine.', start: 0, end: 3 },       // neither -> skip
  { index: 1, text: 'This is not acne.', start: 4, end: 6 },                       // deictic + repeated
  { index: 2, text: 'This is not acne.', start: 8, end: 10 },                      // deictic + repeated
  { index: 3, text: 'This is not acne.', start: 12, end: 14 },                     // deictic + repeated
  { index: 4, text: 'Look right here at my elbow.', start: 16, end: 19 },          // deictic
  { index: 5, text: 'Anyway that is the whole story today.', start: 20, end: 24 }  // neither -> skip
]
const moments = findShowMoments(showSents)
check('flags the repeated "this is not acne" lines + the deictic "look here"',
  moments.length === 4 && moments.every((m) => [1, 2, 3, 4].includes(m.index)), `indices ${moments.map((m) => m.index).join(',')}`)
check('does NOT flag ordinary narration', !moments.some((m) => m.index === 0 || m.index === 5))

console.log('\n=== accept a moment label -> a doc TEXT clip on the text lane, mapped to time ===')
const labelDoc = normalizeDefaultLanes(projectToDocument(project)) // 60s media, cut 10-20
const { clips: textClips, skipped: textSkipped } = labelSuggestionsToDocTextClips(labelDoc, project, [
  { start: 5, end: 8, label: 'Armpit', position: 'bottom_center' },   // before the cut -> edited 5s
  { start: 25, end: 28, label: 'Legs', position: 'top_center' },      // after 10s cut -> edited 15s
  { start: 13, end: 16, label: 'Chest', position: 'bottom_center' }   // inside the cut -> skipped
])
check('places the two labels whose moment survives the cut', textClips.length === 2, `${textClips.length}`)
check('skips a label whose moment is cut', textSkipped.length === 1 && textSkipped[0].includes('Chest'))
check('label clips are TEXT clips on the text lane carrying the label text',
  textClips.every((c) => c.kind === 'text') && textClips[0].name === 'Armpit' && (textClips[0].text as { text: string }).text === 'Armpit')
const tLane = labelDoc.tracks.find((t) => t.kind === 'text')
check('label clips land on the text lane', textClips.every((c) => c.trackId === tLane?.id))
const tArmpit = framesToSeconds(textClips[0].start, labelDoc.timebase)
check('label at source 5s maps to edited 5s', Math.abs(tArmpit - 5) < 0.05, `${tArmpit.toFixed(2)}s`)

console.log(fails === 0 ? '\nAll checks passed.' : `\n${fails} CHECK(S) FAILED`)
process.exit(fails === 0 ? 0 : 1)
