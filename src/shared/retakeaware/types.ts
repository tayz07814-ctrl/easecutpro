// Retake-Aware Cut Beta — shared types.
//
// FULLY ADDITIVE: nothing in this directory is imported by the standard
// engines (FastCut / ProCut / Smart Smooth Cut); they remain byte-identical.
// The beta's contract with the rest of the app is the same review-first shape
// the other engines use: flagged word ids + staged spans, applied only when
// the user presses "Execute cuts".

export type VerbatimProvider = 'assemblyai' | 'deepgram' | 'existing' | 'mock'

export interface VerbatimWord {
  word: string
  start: number
  end: number
  confidence?: number
}

export interface VerbatimUtterance {
  start: number
  end: number
  text: string
}

/** RAW transcript used for ALL editing decisions. `clean_text` exists only for
 *  captions/display — decisions must never read it. */
export interface VerbatimTranscript {
  provider: VerbatimProvider
  mode: 'verbatim'
  words: VerbatimWord[]
  segments: VerbatimUtterance[]
  utterances: VerbatimUtterance[]
  raw_text: string
  clean_text: string
}

/** Sentence-ish chunk of consecutive words (utterance / pause / punctuation /
 *  max-length split). Indices are into VerbatimTranscript.words. */
export interface Chunk {
  id: string
  wordStart: number
  wordEnd: number // inclusive
  start: number
  end: number
  text: string
  /** normalized text for similarity (lowercase, no punctuation, fillers dropped). */
  norm: string
}

export type FillerClass = 'keep' | 'remove' | 'shorten' | 'retake_marker'

export interface FillerDecision {
  id: string
  word_start_index: number
  word_end_index: number // inclusive
  start: number
  end: number
  text: string
  classification: FillerClass
  reason: string
}

export interface RetakeAttempt {
  attempt_id: string
  start: number
  end: number
  text: string
  word_start_index: number
  word_end_index: number // inclusive
  complete: boolean
  score: number
  reasons: string[]
}

/** A group of repeated attempts at the same line. EXACTLY ONE attempt is kept;
 *  the others are removed as WHOLE spans — words are never spliced between
 *  attempts (the Frankenstein-sentence failure this engine exists to prevent). */
export interface RetakeGroup {
  retake_group_id: string
  attempts: RetakeAttempt[]
  keep_attempt: string
  remove_attempts: string[]
  reason: string
}

export interface CutSpan {
  start: number
  end: number
  type: 'failed_retake' | 'filler' | 'retake_marker'
  source: 'retake_aware_beta'
  reason: string
}

export interface LlmRetakeDecision {
  retake_group_id: string
  keep_attempt: string
  remove_attempts: string[]
  reason: string
}
export interface LlmFillerDecision {
  filler_id: string
  decision: FillerClass
  reason: string
}
export interface LlmDecisions {
  retake_group_decisions: LlmRetakeDecision[]
  filler_decisions: LlmFillerDecision[]
}

export interface RepetitionCandidate {
  a: string
  b: string
  similarity: number
}

export interface RetakeAwareDebug {
  mode: 'retake_aware_beta'
  transcription_provider: string
  llm_provider: string
  // ---- review-state audit (proves nothing is hidden before Execute cuts) ----
  raw_words_count: number
  raw_provider_words_count: number
  /** words the transcript tab WILL show (must equal raw_words_count). */
  visible_transcript_words_count: number
  final_cut_spans_count: number
  mapped_word_ids_count: number
  mapped_selected_word_text_preview: string[]
  review_state_applied: boolean
  words_hidden_before_execute: boolean
  hidden_words_before_execute_count: number
  /** the engine NEVER sets word.deleted — always false unless a bug slipped in. */
  auto_applied_before_review: boolean
  raw_words: VerbatimWord[]
  clean_text: string
  chunks: Chunk[]
  filler_candidates: FillerDecision[]
  filler_decisions: FillerDecision[]
  repetition_candidates: RepetitionCandidate[]
  retake_groups: RetakeGroup[]
  attempt_scores: { attempt_id: string; score: number; reasons: string[] }[]
  llm_decisions: LlmDecisions | null
  final_cut_spans: CutSpan[]
  warnings: string[]
  errors: string[]
}

export interface RetakeAwareResult {
  cut_mode: 'retake_aware_beta'
  provider: VerbatimProvider
  verbatim: VerbatimTranscript
  /** App-format transcript built from the verbatim words — adopted by the UI
   *  when the project has no transcript yet (same pattern as ProCut). */
  transcript: import('../types').Transcript
  /** ids (into `transcript`) covered by the final cut spans → review flags. */
  deleteWordIds: string[]
  cutSpans: CutSpan[]
  retakeGroups: RetakeGroup[]
  fillerDecisions: FillerDecision[]
  debugPath: string
  warnings: string[]
  summary: string
}
