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
  applyLlmDecisions,
  buildCutSpans,
  spansToWordIds
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
  const { groups, candidates } = findRetakeGroups(chunks, vt.words, fillerDecisions)

  // 10. optional LLM review of the STRUCTURED candidates only
  op(65, 'Retake β: reviewing retake groups…')
  const context = chunks.map((c) => `[${c.id}] ${c.text}`).join('\n').slice(0, 12000)
  const ambiguousFillers = fillerDecisions.filter((f) => f.classification === 'keep' || f.classification === 'shorten')
  const { decisions, judge } = await reviewRetakeGroups(
    { transcriptContext: context, retakeGroups: groups, fillerCandidates: ambiguousFillers, editingStyle: 'natural talking-head; keep conversational fillers unless ugly' },
    warnings
  )
  applyLlmDecisions(groups, fillerDecisions, decisions, warnings)

  // 11. cut spans (whole failed attempts + ugly fillers, padded + merged)
  op(85, 'Retake β: building cut spans…')
  const cutSpans = buildCutSpans(vt, groups, fillerDecisions)
  const transcript = toAppTranscript(vt)
  const deleteWordIds = spansToWordIds(cutSpans, transcript)

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
  const idToText = new Map(transcript.words.map((w) => [w.id, w.text]))
  const previewText = deleteWordIds.slice(0, 24).map((id) => idToText.get(id) ?? '?')

  // 13. debug JSON — every run, always
  const debug: RetakeAwareDebug = {
    mode: 'retake_aware_beta',
    transcription_provider: vt.provider,
    llm_provider: judge,
    raw_words_count: rawCount,
    visible_transcript_words_count: visibleCount,
    mapped_word_ids_count: deleteWordIds.length,
    mapped_selected_word_text_preview: previewText,
    review_state_applied: true,
    words_hidden_before_execute: wordsHidden,
    raw_words: vt.words,
    clean_text: vt.clean_text,
    chunks,
    filler_candidates: fillerCandidates,
    filler_decisions: fillerDecisions,
    repetition_candidates: candidates,
    retake_groups: groups,
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

  const removed = groups.reduce((n, g) => n + g.remove_attempts.length, 0)
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
    summary: `Retake β (${vt.provider}${judge !== 'none' ? ` + ${judge}` : ''}): ${groups.length} retake group(s), ${removed} failed attempt(s) removed whole, ${fillerDecisions.filter((f) => f.classification !== 'keep').length} filler(s) flagged`
  }
}
