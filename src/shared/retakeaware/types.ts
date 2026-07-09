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
  /** how the group was detected (similarity / dash_retake / prefix_swap / marker / ambiguous). */
  candidate_type?: string
  /** uncertain group: cut ONLY if the LLM judge affirms it (never by rules alone). */
  provisional?: boolean
  /** the LLM judge explicitly said "not a retake" — group produces no cuts. */
  llm_rejected?: boolean
  /** source chunk ids, for rejection debugging. */
  chunk_ids?: string[]
  /** attempts were widened past their anchor chunk into a full multi-chunk
   *  retried passage (see extendProgressiveRetakes). */
  extended?: boolean
}

/** An abandoned tail ("…I'm gonna need—") or in-chunk self-correction
 *  ("…if you got— or do not be surprised…") — word-index range to cut. */
export interface TailCut {
  chunk_id: string
  word_start_index: number
  word_end_index: number // inclusive
  text: string
  reason: string
  silence_after_ms?: number
  /** detector family: self_correction | lead_in_orphan | stutter_restart |
   *  partial_word_restart | micro_cutoff_fragment. Used only for debug bucketing. */
  kind?: string
}

/** A cut-off word ("foo—") that NO detector removed — surfaced for debugging
 *  so genuinely-missed fragments are visible instead of silently dropped. */
export interface MissedCutoff {
  chunk_id: string
  word_index: number
  word: string
  gap_after_ms: number
  reason: string
}

/** A repetition candidate that did NOT become a cut — and exactly why. */
export interface RejectedCandidate {
  a: string
  b: string
  candidate_type: string
  similarity_score: number
  prefix_overlap_score: number
  has_cutoff_marker: boolean
  silence_after_ms: number
  rejection_reason: string
  was_sent_to_llm: boolean
  llm_decision_if_any: string | null
}

export interface CutSpan {
  start: number
  end: number
  type: 'failed_retake' | 'filler' | 'retake_marker' | 'false_start' | 'self_correction' | 'repeated_setup' | 'orphan_connector' | 'orphan_word_artifact'
  source: 'retake_aware_beta'
  reason: string
}

export interface LlmRetakeDecision {
  retake_group_id: string
  keep_attempt: string
  remove_attempts: string[]
  reason: string
  /** the judge may VETO a provisional group entirely. */
  not_a_retake?: boolean
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
  rejected_retake_candidates: RejectedCandidate[]
  false_starts: TailCut[]
  self_corrections: TailCut[]
  micro_cutoff_fragments: TailCut[]
  partial_word_restarts: TailCut[]
  missed_cutoff_candidates: MissedCutoff[]
  cutoff_fragment_reason: string
  repeated_setups: TailCut[]
  orphan_connectors: TailCut[]
  attempt_scores: { attempt_id: string; score: number; reasons: string[] }[]
  llm_decisions: LlmDecisions | null
  // ---- word cuts: delete spoken words, map to word ids, highlight blue ----
  final_cut_spans: CutSpan[]
  /** Retake β conservative, word-clamped silence path (provenance + guards). */
  retake_beta_silence: import('./silence').BetaSilenceResult['debug'] | null
  /** Retake β ASR-artifact cleanup: isolated fake words removed, stretched words repaired. */
  retake_beta_artifacts?: import('./artifacts').ArtifactResult['debug']
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
  /** ids (into `transcript`) covered by the WORD cut spans → blue review flags.
   *  (Silence is staged separately by the store via the shared VAD pass — the
   *  engine emits word cuts only.) */
  deleteWordIds: string[]
  cutSpans: CutSpan[]
  /** Retake β word-clamped silence regions (protect:true, action:'remove').
   *  Staged as review-first silence chips; NEVER touch word highlighting. */
  silenceRegions: import('../types').SilenceRegion[]
  retakeGroups: RetakeGroup[]
  fillerDecisions: FillerDecision[]
  debugPath: string
  warnings: string[]
  summary: string
}
