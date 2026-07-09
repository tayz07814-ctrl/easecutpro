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
import type { Transcript, Segment, SilenceRegion } from '../../shared/types'
import type { RetakeAwareResult, RetakeAwareDebug, VerbatimTranscript } from '../../shared/retakeaware/types'
import {
  buildChunks,
  detectFillers,
  findRetakeGroups,
  extendProgressiveRetakes,
  detectFalseStarts,
  detectSelfCorrections,
  detectRepeatedSetups,
  detectOrphanConnectors,
  applyLlmDecisions,
  buildCutSpans,
  spansToWordIds,
  findMissedCutoffs
} from '../../shared/retakeaware/analyze'
import { detectBetaSilencesHybrid, retakeBetaVadSafetyOpts, retakeBetaVadHardCutOpts, DEFAULT_RETAKE_BETA_SILENCE_SETTINGS, type BetaSilenceResult, type RetakeBetaSilenceSettings } from '../../shared/retakeaware/silence'
import { detectArtifacts, type ArtifactResult } from '../../shared/retakeaware/artifacts'
import { transcribeVerbatim } from './providers'
import { reviewRetakeGroups } from './llm'
import { extractAudioWav, detectSilence } from '../ffmpeg'

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

export async function retakeAwareCut(
  mediaPath: string,
  onProgress?: ProgressFn,
  silenceSettings: RetakeBetaSilenceSettings = DEFAULT_RETAKE_BETA_SILENCE_SETTINGS
): Promise<RetakeAwareResult> {
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
  const repeatedSetups = detectRepeatedSetups(chunks, vt.words)
  const orphanConnectors = detectOrphanConnectors(chunks, vt.words)

  // 11. cut spans (whole failed attempts + tails + corrections + fillers)
  op(85, 'Retake β: building cut spans…')
  const baseCutSpans = buildCutSpans(vt, groups, fillerDecisions, falseStarts, selfCorrections, repeatedSetups, orphanConnectors)

  // 12. Retake β HYBRID silence: the pause SPAN comes from the TRANSCRIPT word
  // gaps (the full perceived pause), guarded off both words; VAD is only a safety
  // check (drops a cut if real speech sits inside the centre), never the span —
  // so VAD under-detection can't leave 1–3s of silence. Regions are protect:true
  // so computeKeepRanges applies them verbatim. If the VAD scan fails we still
  // trim from the transcript gaps (VAD safety is optional).
  op(90, 'Retake β: tightening pauses (transcript-gap hybrid)…')
  let vadSil: { start: number; end: number }[] = []
  try {
    vadSil = (await detectSilence(audioPath, retakeBetaVadSafetyOpts())).map((r) => ({ start: r.start, end: r.end }))
  } catch (e) {
    warnings.push(`VAD safety scan failed (${(e as Error).message}) — trimming from transcript gaps only.`)
  }

  // 11b. ASR ARTIFACT cleanup (Retake β only): transcript words are usually
  // protected, but an isolated fake word (a record-button click heard as "Do") is
  // ADDED to the delete set, and an impossibly-stretched short word (a 4s "it's"
  // that absorbed a pause) has its boundary REPAIRED — clamped to its real speech
  // core — so the silence cutter can trim the dead-air tail instead of it hiding
  // inside the word. Runs BEFORE final silence staging; feeds both stages.
  const artifacts: ArtifactResult = detectArtifacts(vt.words, baseCutSpans, vadSil)
  // Build the transcript from the REPAIRED words so a stretched word's shortened
  // span is what the UI shows AND what computeKeepRanges sees — its midpoint then
  // lands in the kept speech core (not the removed dead air), so the core survives
  // the residue-drop instead of being cleaned away with the pause.
  const transcript = toAppTranscript({ ...vt, words: artifacts.repairedWords })
  const cutSpans = [...baseCutSpans, ...artifacts.orphanCutSpans].sort((a, b) => a.start - b.start)
  const deleteWordIds = spansToWordIds(cutSpans, transcript)

  const lastWordEnd = vt.words.length ? vt.words[vt.words.length - 1].end : 0
  // Media duration (for trailing-edge silence): the audio extends to the last VAD
  // region or the last word, whichever is later.
  const mediaDurS = Math.max(lastWordEnd, ...(vadSil.length ? vadSil.map((r) => r.end) : [0]))
  // SILENCE ENGINE — toggle picks which one runs (word cuts above are unaffected):
  //  • vadHardCut OFF (default): the transcript-gap HYBRID. repairedWords have their
  //    stretched-word ends clamped so the dead air becomes a real gap it removes.
  //  • vadHardCut ON: an aggressive raw VAD pass removes EVERY silence ≥ mingap
  //    (threshold 0.6 / trim 0.08 / pad 0.02 / mingap 0.1). Time-only + still staged
  //    as reviewable chips; the hybrid is bypassed.
  let betaSilence: BetaSilenceResult | null = null
  let silenceRegions: SilenceRegion[]
  let vadHardCutDebug: { source: 'vad_hard_cut'; opts: ReturnType<typeof retakeBetaVadHardCutOpts>; regions_count: number; total_removed_s: number } | null = null
  if (silenceSettings.vadHardCut) {
    op(90, 'Retake β: hard-cutting pauses (aggressive VAD)…')
    let hard: { start: number; end: number }[] = []
    try {
      hard = (await detectSilence(audioPath, retakeBetaVadHardCutOpts())).map((r) => ({ start: r.start, end: r.end }))
    } catch (e) {
      warnings.push(`VAD hard-cut scan failed (${(e as Error).message}) — no silence removed this run.`)
    }
    silenceRegions = hard.filter((r) => r.end - r.start > 0.02).map((r, i) => ({ id: `betasil-hardvad-${i}`, start: r.start, end: r.end, action: 'remove' as const, protect: true }))
    const total = silenceRegions.reduce((n, r) => n + (r.end - r.start), 0)
    vadHardCutDebug = { source: 'vad_hard_cut', opts: retakeBetaVadHardCutOpts(), regions_count: silenceRegions.length, total_removed_s: Number(total.toFixed(3)) }
  } else {
    betaSilence = detectBetaSilencesHybrid(artifacts.repairedWords, cutSpans, vadSil, silenceSettings, mediaDurS)
    silenceRegions = betaSilence.regions
  }

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
    repeated_setups: repeatedSetups,
    orphan_connectors: orphanConnectors,
    attempt_scores: groups.flatMap((g) => g.attempts.map((a) => ({ attempt_id: `${g.retake_group_id}/${a.attempt_id}`, score: a.score, reasons: a.reasons }))),
    llm_decisions: decisions,
    final_cut_spans: cutSpans,
    retake_beta_silence: betaSilence?.debug ?? null,
    retake_beta_vad_hardcut: vadHardCutDebug,
    retake_beta_artifacts: artifacts.debug,
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
  if (silenceRegions.length) extras.push(`${silenceRegions.length} pause(s) trimmed`)
  return {
    cut_mode: 'retake_aware_beta',
    provider: vt.provider,
    verbatim: vt,
    transcript,
    deleteWordIds,
    cutSpans,
    silenceRegions,
    retakeGroups: groups,
    fillerDecisions,
    debugPath,
    warnings,
    summary: `Retake β (${vt.provider}${judge !== 'none' ? ` + ${judge}` : ''}): ${activeGroups.length} retake group(s), ${removed} failed attempt(s) removed whole${extras.length ? ', ' + extras.join(', ') : ''}`
  }
}
