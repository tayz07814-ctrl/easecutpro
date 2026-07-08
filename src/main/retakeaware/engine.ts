// Retake-Aware Cut Beta — orchestrator (cut_mode: "retake_aware_beta").
//
// Pipeline: extract audio -> verbatim transcription (provider chain) -> pure
// rule analysis (chunks, fillers, retake groups, scores) -> optional LLM
// review of the structured candidates -> whole-attempt cut spans -> review
// flags + per-run debug JSON in ~/.easecutpro/retakeaware/.
//
// This module is the ONLY entry point of the beta engine. It is not imported
// by (and does not import) FastCut / ProCut / Smart Smooth Cut internals —
// only neutral app services (ffmpeg audio extraction, whisper-1 fallback
// transcription, key resolution).

import { mkdir, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { Transcript, Segment } from '../../shared/types'
import type { RetakeAwareResult, RetakeAwareDebug, VerbatimTranscript } from '../../shared/retakeaware/types'
import {
  buildChunks,
  detectFillers,
  findRetakeGroups,
  extendProgressiveRetakes,
  detectFalseStarts,
  detectSelfCorrections,
  applyLlmDecisions,
  buildCutSpans,
  spansToWordIds,
  findMissedCutoffs
} from '../../shared/retakeaware/analyze'
import { transcribeVerbatim } from './providers'
import { reviewRetakeGroups } from './llm'
import { extractAudioWav } from '../ffmpeg'

type ProgressFn = (pct: number, msg?: string) => void

/** App-format transcript from the verbatim words (ids rw0..rwN, segments = chunks). */
function toAppTranscript(vt: VerbatimTranscript): Transcript {
  const words = vt.words.map((w, i) => ({
    id: `rw${i}`,
    text: w.word,
    start: w.start,
    end: w.end,
    conf: w.confidence
  }))
  const chunks = buildChunks(vt)
  const segments: Segment[] = chunks.map((c, i) => ({
    id: `rs${i}`,
    start: c.start,
    end: c.end,
    words: words.slice(c.wordStart, c.wordEnd + 1)
  }))
  return { segments: segments.length ? segments : [{ id: 'rs0', start: 0, end: words[words.length - 1]?.end ?? 0, words }], words }
}

export async function retakeAwareCut(mediaPath: string, onProgress?: ProgressFn): Promise<RetakeAwareResult> {
  const warnings: string[] = []
  const errors: string[] = []
  const op: ProgressFn = (pct, msg) => onProgress?.(pct, msg)
  console.log('[retake-aware-beta] job start:', mediaPath)

  // 1. audio (small mono WAV — every provider accepts it)
  op(3, 'Retake β: extracting audio…')
  let audioPath = mediaPath
  try {
    if (!/\.(wav|mp3|m4a|aac|flac|ogg)$/i.test(mediaPath)) audioPath = await extractAudioWav(mediaPath)
  } catch (e) {
    warnings.push(`Audio extraction failed (${(e as Error).message}) — sending the original file to the provider.`)
  }

  // 2. verbatim transcription (AssemblyAI -> Deepgram -> existing whisper-1)
  const { vt, warnings: provWarnings } = await transcribeVerbatim(audioPath, op)
  warnings.push(...provWarnings)
  op(45, `Retake β: analyzing ${vt.words.length} words…`)

  // 3-9. pure rule analysis
  const chunks = buildChunks(vt)
  const fillerCandidates = detectFillers(vt.words)
  const fillerDecisions = fillerCandidates.map((f) => ({ ...f }))
  const { groups, candidates, rejections } = findRetakeGroups(chunks, vt.words, fillerDecisions)
  // Progressive retakes (a restarted PARAGRAPH, not just one line) often span
  // several chunks per attempt — widen each confirmed group's anchor chunk to
  // its full retried passage before the LLM sees it (better context either way).
  extendProgressiveRetakes(chunks, groups, vt.words, fillerDecisions)

  // 10. optional LLM review of the STRUCTURED candidates only. Provisional
  // groups (ambiguous detections) cut ONLY if the judge affirms them.
  op(65, 'Retake β: reviewing retake groups…')
  const context = chunks.map((c) => `[${c.id}] ${c.text}`).join('\n').slice(0, 12000)
  const ambiguousFillers = fillerDecisions.filter((f) => f.classification === 'keep' || f.classification === 'shorten')
  const provisionalCount = groups.filter((g) => g.provisional).length
  const { decisions, judge } = await reviewRetakeGroups(
    { transcriptContext: context, retakeGroups: groups, fillerCandidates: ambiguousFillers, editingStyle: 'natural talking-head; keep conversational fillers unless ugly' },
    warnings
  )
  applyLlmDecisions(groups, fillerDecisions, decisions, warnings)
  // Every provisional group's fate becomes a rejection-debug entry (E-spec).
  for (const g of groups) {
    if (!g.provisional && !g.llm_rejected) continue
    const d = decisions?.retake_group_decisions?.find((x) => x.retake_group_id === g.retake_group_id)
    rejections.push({
      a: g.chunk_ids?.[0] ?? g.attempts[0]?.attempt_id ?? '?',
      b: g.chunk_ids?.[1] ?? g.attempts[1]?.attempt_id ?? '?',
      candidate_type: g.candidate_type ?? 'ambiguous',
      similarity_score: -1,
      prefix_overlap_score: -1,
      has_cutoff_marker: false,
      silence_after_ms: -1,
      rejection_reason: g.llm_rejected
        ? `LLM vetoed: ${g.reason}`
        : judge === 'none'
          ? 'ambiguous candidate — no LLM configured to review it, rules alone never cut ambiguous pairs'
          : 'ambiguous candidate — LLM gave no decision for it',
      was_sent_to_llm: judge !== 'none' && provisionalCount > 0,
      llm_decision_if_any: d ? JSON.stringify(d).slice(0, 200) : null
    })
  }
  const activeGroups = groups.filter((g) => !g.provisional && !g.llm_rejected)

  // 3b/3c. abandoned false starts + in-chunk self-corrections (run AFTER the
  // LLM so a chunk owned by an affirmed retake group is not tail-cut twice).
  const falseStarts = detectFalseStarts(chunks, vt.words, activeGroups)
  const selfCorrections = detectSelfCorrections(chunks, vt.words)

  // 11. cut spans (whole failed attempts + tails + corrections + fillers)
  op(85, 'Retake β: building cut spans…')
  const cutSpans = buildCutSpans(vt, groups, fillerDecisions, falseStarts, selfCorrections)
  const transcript = toAppTranscript(vt)
  const deleteWordIds = spansToWordIds(cutSpans, transcript)
  // cutoff-fragment debug buckets (E-spec): split the self-correction family by
  // detector kind, and surface any dash-terminated word NO span removed.
  const microCutoffs = selfCorrections.filter((s) => s.kind === 'micro_cutoff_fragment')
  const partialWordRestarts = selfCorrections.filter((s) => s.kind === 'partial_word_restart')
  const missedCutoffs = findMissedCutoffs(chunks, vt.words, cutSpans)

  // ---- review-state invariants (the store shows `transcript` in full and
  // stages `deleteWordIds` as blue highlights — nothing is removed pre-Execute).
  const rawCount = vt.words.length
  const visibleCount = transcript.words.length // exactly what the transcript tab renders
  const idSet = new Set(transcript.words.map((w) => w.id))
  const orphanIds = deleteWordIds.filter((id) => !idSet.has(id))
  if (visibleCount !== rawCount) {
    warnings.push(`REVIEW-STATE: transcript will show ${visibleCount} words but raw has ${rawCount} — words would be hidden before Execute cuts!`)
  }
  if (orphanIds.length) {
    warnings.push(`REVIEW-STATE: ${orphanIds.length} flagged id(s) are not in the visible transcript — they could not be highlighted.`)
  }
  const wordsHidden = visibleCount < rawCount || orphanIds.length > 0
  const hiddenCount = Math.max(0, rawCount - visibleCount) + orphanIds.length
  // The engine must NEVER pre-apply cuts: no word it hands to the UI may carry
  // deleted=true. (executeCuts is the only place that flag is ever set.)
  const autoApplied = transcript.words.some((w) => w.deleted === true)
  if (autoApplied) {
    errors.push('REVIEW-STATE ERROR: engine produced words with deleted=true before Execute cuts — this is a bug.')
    console.error('[retake-aware-beta] REVIEW-STATE ERROR: pre-applied deleted flags detected')
  }
  if (wordsHidden) {
    errors.push(`REVIEW-STATE ERROR: ${hiddenCount} word(s) would be hidden before Execute cuts (raw=${rawCount}, visible=${visibleCount}, orphan ids=${orphanIds.length}).`)
    console.error('[retake-aware-beta] REVIEW-STATE ERROR: words hidden before execute', { rawCount, visibleCount, orphans: orphanIds.length })
  }
  const idToText = new Map(transcript.words.map((w) => [w.id, w.text]))
  const previewText = deleteWordIds.slice(0, 24).map((id) => idToText.get(id) ?? '?')

  // 13. debug JSON — every run, always
  const debug: RetakeAwareDebug = {
    mode: 'retake_aware_beta',
    transcription_provider: vt.provider,
    llm_provider: judge,
    raw_words_count: rawCount,
    raw_provider_words_count: rawCount,
    visible_transcript_words_count: visibleCount,
    final_cut_spans_count: cutSpans.length,
    mapped_word_ids_count: deleteWordIds.length,
    mapped_selected_word_text_preview: previewText,
    review_state_applied: true,
    words_hidden_before_execute: wordsHidden,
    hidden_words_before_execute_count: hiddenCount,
    auto_applied_before_review: autoApplied,
    raw_words: vt.words,
    clean_text: vt.clean_text,
    chunks,
    filler_candidates: fillerCandidates,
    filler_decisions: fillerDecisions,
    repetition_candidates: candidates,
    retake_groups: groups,
    rejected_retake_candidates: rejections,
    false_starts: falseStarts,
    self_corrections: selfCorrections,
    micro_cutoff_fragments: microCutoffs,
    partial_word_restarts: partialWordRestarts,
    missed_cutoff_candidates: missedCutoffs,
    cutoff_fragment_reason:
      'micro_cutoff_fragments = short abandoned mini-clauses restarted with the same connective; ' +
      'partial_word_restarts = incomplete words ("pre-") finished/restarted by the next token; ' +
      'missed_cutoff_candidates = dash-terminated words no span removed (each with a per-item reason).',
    attempt_scores: groups.flatMap((g) => g.attempts.map((a) => ({ attempt_id: `${g.retake_group_id}/${a.attempt_id}`, score: a.score, reasons: a.reasons }))),
    llm_decisions: decisions,
    final_cut_spans: cutSpans,
    warnings,
    errors
  }
  const dir = join(homedir(), '.easecutpro', 'retakeaware')
  await mkdir(dir, { recursive: true })
  const debugPath = join(dir, `debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  await writeFile(debugPath, JSON.stringify(debug, null, 2), 'utf8')
  console.log(`[retake-aware-beta] done: ${groups.length} retake group(s), ${cutSpans.length} span(s), debug: ${debugPath}`)

  const removed = activeGroups.reduce((n, g) => n + g.remove_attempts.length, 0)
  const extras: string[] = []
  if (falseStarts.length) extras.push(`${falseStarts.length} false start(s)`)
  if (selfCorrections.length) extras.push(`${selfCorrections.length} self-correction(s)`)
  const fillersFlagged = fillerDecisions.filter((f) => f.classification !== 'keep').length
  if (fillersFlagged) extras.push(`${fillersFlagged} filler(s)`)
  return {
    cut_mode: 'retake_aware_beta',
    provider: vt.provider,
    verbatim: vt,
    transcript,
    deleteWordIds,
    cutSpans,
    retakeGroups: groups,
    fillerDecisions,
    debugPath,
    warnings,
    summary: `Retake β (${vt.provider}${judge !== 'none' ? ` + ${judge}` : ''}): ${activeGroups.length} retake group(s), ${removed} failed attempt(s) removed whole${extras.length ? ', ' + extras.join(', ') : ''}`
  }
}
