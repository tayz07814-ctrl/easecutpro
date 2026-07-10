// Retake-Aware Cut Beta — PURE dependency-injected core (cut_mode: "retake_aware_beta").
//
// Pipeline: verbatim transcription (injected provider chain) -> pure rule
// analysis (chunks, fillers, retake groups, scores) -> optional LLM review of
// the structured candidates (injected judge) -> whole-attempt cut spans ->
// review flags + per-run debug JSON (persisted by the injected saveDebug).
//
// This module holds ALL the beta engine's orchestration but NO platform code:
// audio extraction, provider transport, VAD binaries and fs live behind
// RetakeEngineDeps, bound by the thin wrappers (src/main/retakeaware/engine.ts
// for Electron/server, src/renderer/src/cloud/retakeEngine.ts for the cloud
// build). It imports only from src/shared/** so it compiles under both
// tsconfig.node.json and tsconfig.web.json. It is not imported by (and does
// not import) FastCut / ProCut / Smart Smooth Cut internals.

import type { Transcript, Segment, SilenceRegion, SilenceDetectOptions } from '../types'
import type { RetakeAwareResult, RetakeAwareDebug, VerbatimTranscript, LlmDecisions, ReviewPayload } from './types'
import {
  buildChunks,
  detectFillers,
  findRetakeGroups,
  extendProgressiveRetakes,
  detectFalseStarts,
  detectShortRestarts,
  detectSelfCorrections,
  detectRepeatedSetups,
  detectOrphanConnectors,
  applyLlmDecisions,
  buildCutSpans,
  spansToWordIds,
  findMissedCutoffs
} from './analyze'
import { detectBetaSilencesHybrid, retakeBetaVadSafetyOpts, retakeBetaVadHardCutOpts, DEFAULT_RETAKE_BETA_SILENCE_SETTINGS, type BetaSilenceResult, type RetakeBetaSilenceSettings } from './silence'
import { detectArtifacts, type ArtifactResult } from './artifacts'

export type ProgressFn = (pct: number, msg?: string) => void

/** Platform services the core needs. Every dep is already BOUND to the run's
 *  audio: transcribeVerbatim and detectSilence must read the SAME audio (the
 *  VAD safety scan guards the transcript's word timings — a mismatched source
 *  would mis-clamp every silence cut). */
export interface RetakeEngineDeps {
  /** Verbatim transcription via the platform's provider chain (AssemblyAI ->
   *  Deepgram -> …). Returns provider warnings to surface in the result. */
  transcribeVerbatim(onProgress?: ProgressFn): Promise<{ vt: VerbatimTranscript; warnings: string[] }>
  /** Silero VAD (or equivalent) over the SAME audio the transcription used. */
  detectSilence(opts: SilenceDetectOptions): Promise<SilenceRegion[]>
  /** Optional LLM review; never throws — degrade to rules with judge 'none'. */
  reviewRetakeGroups(payload: ReviewPayload, warnings: string[]): Promise<{ decisions: LlmDecisions | null; judge: string }>
  /** Persist the debug JSON; returns its path, or null when the platform can't
   *  persist it (browser). A throw fails the run (matches the old fs write). */
  saveDebug(json: string): Promise<string | null>
}

/** App-format transcript from the verbatim words (ids rw0..rwN, segments = chunks). */
export function toAppTranscript(vt: VerbatimTranscript): Transcript {
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

/** Extract + validate the model's JSON; null on ANY problem (rules stand). */
export function parseLlmDecisions(raw: string, warnings: string[]): LlmDecisions | null {
  try {
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('no JSON object in reply')
    const j = JSON.parse(m[0]) as LlmDecisions
    if (!Array.isArray(j.retake_group_decisions ?? []) || !Array.isArray(j.filler_decisions ?? [])) {
      throw new Error('wrong shape')
    }
    return { retake_group_decisions: j.retake_group_decisions ?? [], filler_decisions: j.filler_decisions ?? [] }
  } catch (e) {
    warnings.push(`LLM returned unusable JSON — using rule-based decisions (${(e as Error).message})`)
    console.warn('[retake-aware-beta] LLM JSON invalid, rules stand:', (e as Error).message)
    return null
  }
}

export async function runRetakeAwareCut(
  deps: RetakeEngineDeps,
  onProgress?: ProgressFn,
  silenceSettings: RetakeBetaSilenceSettings = DEFAULT_RETAKE_BETA_SILENCE_SETTINGS,
  initialWarnings: string[] = []
): Promise<RetakeAwareResult> {
  const warnings: string[] = [...initialWarnings]
  const errors: string[] = []
  const op: ProgressFn = (pct, msg) => onProgress?.(pct, msg)

  // 2. verbatim transcription (platform provider chain)
  const { vt, warnings: provWarnings } = await deps.transcribeVerbatim(op)
  warnings.push(...provWarnings)
  op(52, `Reading ${vt.words.length} words…`)

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
  op(70, 'Trimming retakes…')
  const context = chunks.map((c) => `[${c.id}] ${c.text}`).join('\n').slice(0, 12000)
  const ambiguousFillers = fillerDecisions.filter((f) => f.classification === 'keep' || f.classification === 'shorten')
  const provisionalCount = groups.filter((g) => g.provisional).length
  const { decisions, judge } = await deps.reviewRetakeGroups(
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
  // Cross-chunk short abandoned openers ("I'm," → "I'm glad…", "this is—" →
  // "this is…") — same cut family as false starts.
  const allFalseStarts = [...falseStarts, ...detectShortRestarts(chunks, vt.words, activeGroups)]
  const selfCorrections = detectSelfCorrections(chunks, vt.words)
  const repeatedSetups = detectRepeatedSetups(chunks, vt.words)
  const orphanConnectors = detectOrphanConnectors(chunks, vt.words)

  // 11. cut spans (whole failed attempts + tails + corrections + fillers)
  op(86, 'Cleaning silence…')
  const baseCutSpans = buildCutSpans(vt, groups, fillerDecisions, allFalseStarts, selfCorrections, repeatedSetups, orphanConnectors)

  // 12. Retake β HYBRID silence: the pause SPAN comes from the TRANSCRIPT word
  // gaps (the full perceived pause), guarded off both words; VAD is only a safety
  // check (drops a cut if real speech sits inside the centre), never the span —
  // so VAD under-detection can't leave 1–3s of silence. Regions are protect:true
  // so computeKeepRanges applies them verbatim. If the VAD scan fails we still
  // trim from the transcript gaps (VAD safety is optional).
  op(92, 'Reducing noise…')
  let vadSil: { start: number; end: number }[] = []
  try {
    vadSil = (await deps.detectSilence(retakeBetaVadSafetyOpts())).map((r) => ({ start: r.start, end: r.end }))
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
    op(92, 'Cleaning silence…')
    let hard: { start: number; end: number }[] = []
    try {
      hard = (await deps.detectSilence(retakeBetaVadHardCutOpts())).map((r) => ({ start: r.start, end: r.end }))
    } catch (e) {
      warnings.push(`VAD hard-cut scan failed (${(e as Error).message}) — no silence removed this run.`)
    }
    // WORD-ONSET GUARD: the raw VAD doesn't know where transcript words are, so it
    // clips a word's low-energy onset/offset (the soft "m" of "My"). Clamp every
    // region off the KEPT words (deleted/retake words aren't protected) so no word is
    // eaten — keep a ~30ms lead-in. Regions are protect:true, so this is their only
    // guard (computeKeepRanges applies protect regions verbatim).
    const keptHardWords = artifacts.repairedWords.filter((w) => { const m = (w.start + w.end) / 2; return !cutSpans.some((s) => m >= s.start && m <= s.end) })
    const clampOffWords = (a: number, b: number): { start: number; end: number } => {
      let cs = a, ce = b
      for (const w of keptHardWords) {
        if (cs <= w.start && ce > w.start + 0.002 && ce < w.end) ce = Math.max(cs, w.start - 0.03) // end clipped the onset
        if (ce >= w.end && cs < w.end - 0.002 && cs > w.start) cs = Math.min(ce, w.end + 0.03) // start clipped the tail
      }
      return { start: cs, end: ce }
    }
    silenceRegions = hard.map((r) => clampOffWords(r.start, r.end)).filter((r) => r.end - r.start > 0.05).map((r, i) => ({ id: `betasil-hardvad-${i}`, start: r.start, end: r.end, action: 'remove' as const, protect: true }))
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
    false_starts: allFalseStarts,
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
  const debugPath = await deps.saveDebug(JSON.stringify(debug, null, 2))
  console.log(`[retake-aware-beta] done: ${groups.length} retake group(s), ${cutSpans.length} span(s), debug: ${debugPath ?? '(not persisted)'}`)

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
