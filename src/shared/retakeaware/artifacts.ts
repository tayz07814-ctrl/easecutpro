// Retake β — ASR ARTIFACT cleanup (Retake β ONLY). Transcript words are usually
// protected speech, but NOT blindly: an isolated short "fake word" (a record-button
// click AssemblyAI heard as "Do") and an impossibly-stretched short word (a 4s
// "it's" that absorbed a pause) must not protect dead audio. Two detectors feed the
// existing stages — orphans become word cuts, stretched words get their boundary
// repaired (clamped to the real speech core) so the silence cutter can trim the
// dead-air tail. Never touches FastCut/ProCut (nothing here is imported by them).
import type { VerbatimWord, CutSpan } from './types'

export interface VadInterval { start: number; end: number }

// Short / connector / starter words that, when ISOLATED, are likely a click / false
// start / noise rather than useful speech.
const ORPHAN_WORDS = new Set(['do', 'and', 'so', 'but', 'it', "it's", 'i', 'a', 'an', 'the', 'uh', 'um', 'you', 'oh', 'ah'])
// Impossible max duration per short function word (s) — longer than this and the
// word is stretched to absorb a pause, not real speech.
const STRETCH_MAX: Record<string, number> = { "it's": 1.0, and: 1.0, so: 1.0, but: 1.0, it: 1.0, do: 0.8, my: 0.8, the: 0.8, a: 0.6, to: 0.6, i: 0.5, you: 0.7 }
const STRETCH_ANY_SHORT_S = 1.2 // any <=4-char word longer than this is impossible
const ORPHAN_ISOLATION_S = 1.0 // real word must be > this before AND after
const ORPHAN_LOW_CONF = 0.8
const ORPHAN_MAX_KEEP_S = 2.0 // a lone artifact makes a standalone keep under ~this
const MAX_SPEECH_CORE_S = 0.8 // a real short word's speech is at most ~this
const CORE_PAD_S = 0.08 // keep a hair past the speech core so it isn't clipped
const MIN_EXPOSED_DEAD_AIR_S = 0.4 // only repair if it exposes at least this much dead air
const norm = (w: string): string => w.toLowerCase().replace(/[^a-z']/g, '')

/** Non-silence (speech/noise) blobs within [a,b] — complement of the VAD silence
 *  intervals, edges included. The first blob near a word's start is its speech core. */
function nonSilenceBlobs(a: number, b: number, vad: VadInterval[]): VadInterval[] {
  if (vad.length === 0 || b - a <= 0.02) return []
  const sils = vad.filter((s) => s.end > a && s.start < b).map((s) => ({ start: Math.max(a, s.start), end: Math.min(b, s.end) })).sort((x, y) => x.start - y.start)
  const blobs: VadInterval[] = []
  let cursor = a
  for (const s of sils) { if (s.start - cursor > 0.02) blobs.push({ start: cursor, end: s.start }); cursor = Math.max(cursor, s.end) }
  if (b - cursor > 0.02) blobs.push({ start: cursor, end: b })
  return blobs
}

export interface OrphanArtifactDebug {
  word: string
  start: number
  end: number
  duration: number
  confidence: number | null
  previous_word: string
  next_word: string
  gap_before: number
  gap_after: number
  is_inside_or_adjacent_to_word_cut: boolean
  vad_speech_core_start: number | null
  vad_speech_core_end: number | null
  decision: 'remove'
  reason: string
}
export interface StretchedArtifactDebug {
  word: string
  start: number
  end: number
  duration: number
  confidence: number | null
  previous_word: string
  next_word: string
  gap_before: number
  gap_after: number
  is_inside_or_adjacent_to_word_cut: boolean
  vad_speech_core_start: number | null
  vad_speech_core_end: number | null
  repaired_end: number
  exposed_dead_air_s: number
  decision: 'repair_boundary' | 'remove' | 'keep'
  reason: string
}
export interface ArtifactKeepAuditRow {
  start: number
  end: number
  duration: number
  transcript_word_count: number
  only_orphan_artifact: boolean
  decision: 'keep' | 'remove'
  reason: string
}
export interface ArtifactResult {
  /** Orphan artifacts to ADD to the delete set (they become word cuts). */
  orphanCutSpans: CutSpan[]
  /** The words array with every stretched word's END clamped to its speech core —
   *  pass THIS to detectBetaSilencesHybrid so the dead-air tail becomes a real gap. */
  repairedWords: VerbatimWord[]
  debug: {
    orphan_word_artifacts: OrphanArtifactDebug[]
    stretched_word_artifacts: StretchedArtifactDebug[]
    repaired_word_boundaries: { word: string; word_index: number; orig_end: number; new_end: number }[]
    removed_artifact_ranges: { start: number; end: number; word: string }[]
    artifact_keep_range_audit: ArtifactKeepAuditRow[]
  }
}

/** Detect + repair ASR artifacts. Pure: no I/O, deterministic. `vad` is the safety
 *  scan (silence intervals); works transcript-only if empty (uses a default core). */
export function detectArtifacts(words: VerbatimWord[], wordCutSpans: CutSpan[], vad: VadInterval[] = []): ArtifactResult {
  const inCut = (a: number, b: number): boolean => wordCutSpans.some((c) => a < c.end && c.start < b)
  const midInCut = (w: VerbatimWord): boolean => { const m = (w.start + w.end) / 2; return wordCutSpans.some((c) => m >= c.start && m <= c.end) }
  const kept = words.map((w) => !midInCut(w))
  const prevKept = (i: number): VerbatimWord | null => { for (let j = i - 1; j >= 0; j--) if (kept[j]) return words[j]; return null }
  const nextKept = (i: number): VerbatimWord | null => { for (let j = i + 1; j < words.length; j++) if (kept[j]) return words[j]; return null }

  const orphanCutSpans: CutSpan[] = []
  const repairedWords: VerbatimWord[] = words.map((w) => ({ ...w }))
  const orphan_word_artifacts: OrphanArtifactDebug[] = []
  const stretched_word_artifacts: StretchedArtifactDebug[] = []
  const repaired_word_boundaries: { word: string; word_index: number; orig_end: number; new_end: number }[] = []
  const removed_artifact_ranges: { start: number; end: number; word: string }[] = []

  for (let i = 0; i < words.length; i++) {
    if (!kept[i]) continue // already a word cut — leave it
    const w = words[i]
    const t = norm(w.word)
    const dur = w.end - w.start
    const prev = prevKept(i), next = nextKept(i)
    const gapBefore = prev ? w.start - prev.end : w.start
    const gapAfter = next ? next.start - w.end : Number.POSITIVE_INFINITY
    // a removed take sitting in the pause on either side of this word
    const adjCut = midInCut(w) || wordCutSpans.some((c) => (c.end > (prev?.end ?? -1) && c.end <= w.start + 0.15) || (c.start >= w.end - 0.15 && c.start < (next?.start ?? Number.POSITIVE_INFINITY)))
    const core = nonSilenceBlobs(w.start, w.end, vad)[0] ?? null
    const conf = w.confidence ?? null

    // ---- STRETCHED short word (impossible duration → repair the boundary) ----
    const stretchMax = STRETCH_MAX[t] ?? (t.replace(/'/g, '').length <= 4 ? STRETCH_ANY_SHORT_S : Number.POSITIVE_INFINITY)
    const wordInside = words.some((o, j) => j !== i && o.start > w.start + 0.01 && o.start < w.end - 0.01)
    if (dur > stretchMax && !wordInside) {
      // real speech core = first VAD non-silence blob near the word start; without a
      // short core (no VAD, or the "core" is itself impossibly long) clamp to a
      // minimal function-word length so the dead-air tail is still exposed.
      const coreEnd = core && core.end - w.start <= MAX_SPEECH_CORE_S ? Math.min(w.end, core.end + CORE_PAD_S) : Math.min(w.end, w.start + 0.5)
      const exposed = w.end - coreEnd
      if (exposed > MIN_EXPOSED_DEAD_AIR_S) {
        repairedWords[i] = { ...w, end: coreEnd }
        repaired_word_boundaries.push({ word: w.word, word_index: i, orig_end: Number(w.end.toFixed(3)), new_end: Number(coreEnd.toFixed(3)) })
        stretched_word_artifacts.push({
          word: w.word, start: Number(w.start.toFixed(3)), end: Number(w.end.toFixed(3)), duration: Number(dur.toFixed(3)), confidence: conf,
          previous_word: prev?.word ?? '(start)', next_word: next?.word ?? '(end)', gap_before: Number(gapBefore.toFixed(3)), gap_after: Number(gapAfter.toFixed(3)),
          is_inside_or_adjacent_to_word_cut: adjCut, vad_speech_core_start: core ? Number(core.start.toFixed(3)) : null, vad_speech_core_end: core ? Number(core.end.toFixed(3)) : null,
          repaired_end: Number(coreEnd.toFixed(3)), exposed_dead_air_s: Number(exposed.toFixed(3)), decision: 'repair_boundary',
          reason: `stretched "${w.word}" ${dur.toFixed(2)}s > ${stretchMax}s max — clamp to speech core, expose ${exposed.toFixed(2)}s dead air for silence removal`
        })
        continue // a repaired stretched word is not also an orphan
      }
    }

    // ---- ORPHAN single-word artifact (isolated fake word → remove) ----
    if (ORPHAN_WORDS.has(t) && dur < ORPHAN_MAX_KEEP_S) {
      const isolated = gapBefore > ORPHAN_ISOLATION_S && gapAfter > ORPHAN_ISOLATION_S
      const lowConf = conf != null && conf < ORPHAN_LOW_CONF
      // Isolated short word is a leftover artifact ONLY with corroborating evidence:
      // it sits by a removed take (adjCut — spec's "leftover keep range created by
      // cuts") OR it is low-confidence (a click/noise mis-heard as a word). A
      // high-confidence isolated word with no cut nearby is real speech — keep it.
      if (isolated && (adjCut || lowConf)) {
        const reason = `isolated "${w.word}" (${dur.toFixed(2)}s, conf ${conf != null ? conf.toFixed(2) : '?'}, gaps ${gapBefore.toFixed(1)}s/${gapAfter === Number.POSITIVE_INFINITY ? '∞' : gapAfter.toFixed(1)}s${adjCut ? ', adjacent to a removed take' : ''}${lowConf ? ', low confidence' : ''}) — record-click / false-start artifact, not useful speech`
        orphanCutSpans.push({ start: Number((w.start - 0.02).toFixed(3)), end: Number((w.end + 0.02).toFixed(3)), type: 'orphan_word_artifact', source: 'retake_aware_beta', reason })
        removed_artifact_ranges.push({ start: Number(w.start.toFixed(3)), end: Number(w.end.toFixed(3)), word: w.word })
        orphan_word_artifacts.push({
          word: w.word, start: Number(w.start.toFixed(3)), end: Number(w.end.toFixed(3)), duration: Number(dur.toFixed(3)), confidence: conf,
          previous_word: prev?.word ?? '(start)', next_word: next?.word ?? '(end)', gap_before: Number(gapBefore.toFixed(3)), gap_after: Number(gapAfter.toFixed(3)),
          is_inside_or_adjacent_to_word_cut: adjCut, vad_speech_core_start: core ? Number(core.start.toFixed(3)) : null, vad_speech_core_end: core ? Number(core.end.toFixed(3)) : null,
          decision: 'remove', reason
        })
      }
    }
  }

  return {
    orphanCutSpans, repairedWords,
    debug: { orphan_word_artifacts, stretched_word_artifacts, repaired_word_boundaries, removed_artifact_ranges, artifact_keep_range_audit: [] }
  }
}

/** POST-CUT audit: after word cuts + silence cuts are combined into keep ranges,
 *  flag any keep that is dead audio — no transcript word, or only a lone orphan
 *  artifact, and short. Pure reporting (the removals already happened via the
 *  detectors + silence cutter); this surfaces anything that slipped through. */
export function auditArtifactKeeps(keeps: { start: number; end: number }[], words: VerbatimWord[], deletedWordIds: Set<string>, wordIdOf: (w: VerbatimWord, i: number) => string): ArtifactKeepAuditRow[] {
  const rows: ArtifactKeepAuditRow[] = []
  keeps.forEach((k, i) => {
    const inside = words.filter((w, j) => { const m = (w.start + w.end) / 2; return m > k.start + 0.001 && m < k.end - 0.001 && !deletedWordIds.has(wordIdOf(w, j)) })
    const len = k.end - k.start
    const interior = i > 0 && i < keeps.length - 1
    const onlyOrphan = inside.length === 1 && ORPHAN_WORDS.has(norm(inside[0].word))
    let decision: 'keep' | 'remove' = 'keep'
    let reason = 'contains real speech'
    if (inside.length === 0 && (interior || len < ORPHAN_MAX_KEEP_S)) { decision = 'remove'; reason = 'no transcript words — dead audio' }
    else if (onlyOrphan && len < ORPHAN_MAX_KEEP_S) { decision = 'remove'; reason = `only a lone "${inside[0].word}" artifact in a <${ORPHAN_MAX_KEEP_S}s clip` }
    if (decision === 'remove') rows.push({ start: Number(k.start.toFixed(3)), end: Number(k.end.toFixed(3)), duration: Number(len.toFixed(3)), transcript_word_count: inside.length, only_orphan_artifact: onlyOrphan, decision, reason })
  })
  return rows
}
