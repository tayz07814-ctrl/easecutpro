// Verify FastCut retake accuracy on the failing clip (the "major warning signs" /
// "body isn't sending the signals" retakes). The fix: clause-level detection with
// directional CONTAINMENT (is the last take mostly inside the earlier one?) so
// varied retakes are cut WHOLE and the surviving last take is kept intact — no
// broken half-sentences, no fragments on the kept take.
// Run: npx tsx scripts/verify-retake-cuts.ts

import type { Transcript, Word, Segment } from '../src/shared/types'
import { detectRepeatIds, snapRetakeFlags } from '../src/shared/fillers'

let ok = true
const check = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) ok = false
}

// Build a sentence into timed words (small intra gaps, a pause after) + a segment.
let clock = 0
function sentence(prefix: string, text: string): { words: Word[]; seg: Segment } {
  const words: Word[] = text.split(' ').map((tok, i) => {
    const start = clock
    const end = clock + 0.3
    clock = end + 0.05 // small intra-sentence gap (< PAUSE_GAP)
    return { id: `${prefix}-${i}`, text: tok, start, end }
  })
  clock += 0.55 // inter-sentence pause (>= PAUSE_GAP)
  return { words, seg: { id: prefix, start: words[0].start, end: words[words.length - 1].end, words } }
}

const A = sentence('A', 'And if you feel as if you tried everything for insulin and not a thing has worked.')
const B1 = sentence('B1', 'And these are all major warning signs that something inside of you is out of balance.') // earlier take -> CUT
const B2 = sentence('B2', 'These are major warning signs that something inside of you is definitely out of balance.') // last take -> KEEP
const C1 = sentence('C1', "uh uh because all the the uh because your your uh body isn't sending the signals to your stomach.") // earlier take -> CUT
const C2 = sentence('C2', 'Because your body is not sending the signals to your stomach.') // last take -> KEEP

const words = [...A.words, ...B1.words, ...B2.words, ...C1.words, ...C2.words]
const t: Transcript = { words, segments: [A.seg, B1.seg, B2.seg, C1.seg, C2.seg] }

const all = (ws: Word[], f: Set<string>): boolean => ws.every((w) => f.has(w.id))
const none = (ws: Word[], f: Set<string>): boolean => ws.every((w) => !f.has(w.id))

// ---- detectRepeatIds: clean whole-take cuts, correct takes kept ----
const flags = new Set(detectRepeatIds(t))
check('earlier take B1 cut WHOLE', all(B1.words, flags))
check('earlier take C1 (messy, stutters) cut WHOLE', all(C1.words, flags))
check('last take B2 kept (not flagged)', none(B2.words, flags))
check('last take C2 kept (not flagged)', none(C2.words, flags))
check('non-retake sentence A untouched (no "if you feel as" false-positive)', none(A.words, flags))

// ---- snapRetakeFlags: clean a MESSY union (fragments of both takes) ----
// Simulate what the Python engine + old heuristic produced: only the shared middle
// of B1, a couple of words from the KEPT take B2, and a fragment of C1.
const messy = [
  ...B1.words.slice(4, 12).map((w) => w.id), // "major warning signs that something inside of you"
  ...B2.words.slice(0, 2).map((w) => w.id), // "These are" (on the take we must keep!)
  ...C1.words.slice(12, 16).map((w) => w.id) // fragment of C1
]
const snapped = new Set(snapRetakeFlags(messy, t))
check('snap: B1 fragment expanded to WHOLE cut', all(B1.words, snapped))
check('snap: C1 fragment expanded to WHOLE cut', all(C1.words, snapped))
check('snap: stray flags on kept take B2 removed', none(B2.words, snapped))
check('snap: kept take C2 stays clean', none(C2.words, snapped))
check('snap: non-retake A stays clean', none(A.words, snapped))

console.log(ok ? '\nRETAKE-CUTS OK' : '\nRETAKE-CUTS FAILED')
process.exit(ok ? 0 : 1)
