// Smart Silence Cleaner — central configuration + Word-level predicates.
//
// Faithful port of:
//   - smart_silence_cleaner/config.py           (filler words, punctuation,
//     engine guards, slider bounds)
//   - smart_silence_cleaner/models/word.py      (normalize + ends_sentence /
//     ends_clause / is_single_filler predicates)
//
// Every constant is IDENTICAL to the Python spec. All durations are in
// milliseconds unless a name ends in `_S`.

import type { Word } from './types'

/** DORMANT SWITCH for this whole engine.
 *
 *  The transcript-gap Smart Silence cutter is retired: FSMN (FunASR) VAD is the
 *  only live silence engine, driven by the "Silence settings" modal. This module
 *  and its UI components are kept intact but unreferenced — no Find cuts stage,
 *  no "Find Silences" button, no settings modal mounted, and `runSmartSilence`
 *  no-ops in the store.
 *
 *  Flip this to `false` and restore the call sites to bring the engine back:
 *    - store.ts        runSmartSilence()  (drop the guard)
 *    - SpeechCleanerPanel.tsx             (re-add the two buttons)
 *    - Editor.tsx / MobileEditor.tsx      (re-mount SmartSilenceSettingsModal)
 *    - useRetake.ts                       (re-add findSilences/openSmartSilenceSettings)
 *    - main.tsx        SMART_SILENCE_DORMANT (the ?silence=1 preview route) */
export const SMART_SILENCE_DORMANT = true

// --------------------------------------------------------------------------- //
// Filler words                                                                //
// --------------------------------------------------------------------------- //
export const SINGLE_FILLERS: ReadonlySet<string> = new Set([
  'uh', 'um', 'erm', 'uhh', 'umm', 'hmm', 'mm', 'mhm', 'eh', 'ah', 'er',
])

// Ordered longest-first so the phrase matcher is greedy ("you know" before "like").
export const PHRASE_FILLERS: ReadonlyArray<ReadonlyArray<string>> = [
  ['you', 'know'],
  ['i', 'mean'],
  ['sort', 'of'],
  ['kind', 'of'],
]

// "like" is a filler only in its discourse sense; opt-in and still protected by
// the phrase logic above.
export const CONTEXTUAL_FILLERS: ReadonlySet<string> = new Set(['like', 'basically', 'literally'])

// --------------------------------------------------------------------------- //
// Punctuation                                                                 //
// --------------------------------------------------------------------------- //
export const SENTENCE_ENDERS: ReadonlySet<string> = new Set(['.', '?', '!', '…'])
export const COMMA_ENDERS: ReadonlySet<string> = new Set([',', ';', ':', '—', '-'])

// --------------------------------------------------------------------------- //
// Engine guards                                                               //
// --------------------------------------------------------------------------- //
/** A trim shorter than this is not worth a splice — skip it. */
export const MIN_MEANINGFUL_TRIM_MS = 40.0
/** Absolute floor for any kept pause; 0 allows a true gapless cut. */
export const MIN_KEPT_PAUSE_MS = 0.0

// --------------------------------------------------------------------------- //
// Custom-control bounds — each tuple is (min_ms, max_ms)                      //
// --------------------------------------------------------------------------- //
export const BOUNDS_MIN_GAP_MS: readonly [number, number] = [80.0, 700.0]
export const BOUNDS_TARGET_PAUSE_MS: readonly [number, number] = [0.0, 400.0]
export const BOUNDS_SENTENCE_PAUSE_MS: readonly [number, number] = [120.0, 600.0]
export const BOUNDS_COMMA_PAUSE_MS: readonly [number, number] = [80.0, 450.0]
export const BOUNDS_MERGE_GAP_MS: readonly [number, number] = [0.0, 400.0]
export const BOUNDS_PAD_MS: readonly [number, number] = [0.0, 200.0]

// --------------------------------------------------------------------------- //
// Word-level pure predicates (port of models/word.py)                         //
// --------------------------------------------------------------------------- //
// Python `str.strip(chars)` / `str.rstrip(chars)` treat the argument as a SET
// of characters removed from the ends — replicated below.

// normalize()'s strip set: `.,!?;:—-…"'`()[]`
const NORMALIZE_STRIP: ReadonlySet<string> = new Set([
  '.', ',', '!', '?', ';', ':', '—', '-', '…', '"', "'", '`', '(', ')', '[', ']',
])
// ends_sentence/ends_clause's rstrip set: `"'`)]}`
const EDGE_QUOTES: ReadonlySet<string> = new Set(['"', "'", '`', ')', ']', '}'])

/** Python str.strip(chars): remove leading + trailing chars that are IN `chars`. */
function stripChars(s: string, chars: ReadonlySet<string>): string {
  let start = 0
  let end = s.length
  while (start < end && chars.has(s[start])) start++
  while (end > start && chars.has(s[end - 1])) end--
  return s.slice(start, end)
}

/** Python str.rstrip(chars): remove trailing chars that are IN `chars`. */
function rstripChars(s: string, chars: ReadonlySet<string>): string {
  let end = s.length
  while (end > 0 && chars.has(s[end - 1])) end--
  return s.slice(0, end)
}

/** Lower-case a token and strip surrounding punctuation. Interior apostrophes kept. */
export function normalize(text: string): string {
  return stripChars(text.trim(), NORMALIZE_STRIP).toLowerCase()
}

/** How long the word itself occupies (never negative). */
export const wordDurationMs = (w: Word): number => Math.max(0.0, w.endMs - w.startMs)

/** The token lower-cased with edge punctuation removed. */
export const wordClean = (w: Word): string => normalize(w.text)

/** True when the token ends a sentence (`.` `?` `!` `…`). */
export function endsSentence(w: Word): boolean {
  const stripped = rstripChars(w.text, EDGE_QUOTES)
  return stripped.length > 0 && SENTENCE_ENDERS.has(stripped[stripped.length - 1])
}

/** True when the token ends a clause (`,` `;` `:` `—` `-`). */
export function endsClause(w: Word): boolean {
  const stripped = rstripChars(w.text, EDGE_QUOTES)
  return stripped.length > 0 && COMMA_ENDERS.has(stripped[stripped.length - 1])
}

/** True for a one-word filler (uh/um/… and optionally like/basically/literally). */
export function isSingleFiller(w: Word, includeContextual = true): boolean {
  const c = wordClean(w)
  if (SINGLE_FILLERS.has(c)) return true
  return includeContextual && CONTEXTUAL_FILLERS.has(c)
}
