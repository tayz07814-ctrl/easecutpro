// Retake Final Boss — isolated contracts and pure planning logic.
//
// This module deliberately does not import any previous Retake/VAD settings or
// silence planner. Gemma receives only indexed verbatim words. The Final Boss
// VAD pass turns raw non-speech regions into protected cuts with its own fields.

import type { SilenceRegion } from './types'

export interface RetakeFinalBossSettings {
  /** Silero positive-speech probability threshold, normalized to 0..1. */
  speechThreshold: number
  /** Audio protected before the next spoken word. */
  padBeforeS: number
  /** Audio protected after the previous spoken word. */
  padAfterS: number
  /** Tightens a cut by consuming some of the protected padding, never a word. */
  trimEdgesS: number
  /** Incoming audio overlap/crossfade used by preview and export. */
  audioOverlapMs: number
}

export const DEFAULT_RETAKE_FINAL_BOSS_SETTINGS: RetakeFinalBossSettings = {
  speechThreshold: 0.72,
  padBeforeS: 0.18,
  padAfterS: 0.12,
  trimEdgesS: 0.02,
  audioOverlapMs: 20
}

export function normalizeRetakeFinalBossSettings(
  value: Partial<RetakeFinalBossSettings> | null | undefined
): RetakeFinalBossSettings {
  const d = DEFAULT_RETAKE_FINAL_BOSS_SETTINGS
  const number = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return {
    speechThreshold: Math.max(0, Math.min(1, number(value?.speechThreshold, d.speechThreshold))),
    padBeforeS: Math.max(0, Math.min(0.5, number(value?.padBeforeS, d.padBeforeS))),
    padAfterS: Math.max(0, Math.min(0.5, number(value?.padAfterS, d.padAfterS))),
    trimEdgesS: Math.max(0, Math.min(0.2, number(value?.trimEdgesS, d.trimEdgesS))),
    audioOverlapMs: Math.max(0, Math.min(60, number(value?.audioOverlapMs, d.audioOverlapMs)))
  }
}

export interface FinalBossWord {
  word: string
  start: number
  end: number
}

/** The complete LLM user message. No pauses, VAD, confidence, utterances,
 * incomplete-sentence guesses, filler tags, or timing metadata are included. */
export function buildFinalBossVerbatimPayload(words: FinalBossWord[]): string {
  return `VERBATIM TRANSCRIPT (immutable index|word):\n${words.map((w, index) => `${index}|${w.word}`).join('\n')}`
}

export interface FinalBossWordCut {
  from: number
  to: number
  reason: string
}

function extractJsonObject(raw: string): string {
  const key = raw.indexOf('"word_cuts"')
  const start = key >= 0 ? raw.lastIndexOf('{', key) : raw.indexOf('{')
  if (start < 0) return raw.trim()
  let depth = 0
  let quoted = false
  let escaped = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (escaped) { escaped = false; continue }
    if (ch === '\\') { escaped = true; continue }
    if (ch === '"') quoted = !quoted
    if (quoted) continue
    if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return raw.slice(start, i + 1)
  }
  return raw.slice(start).trim()
}

/** Validate Gemma's word-only EDL. Pause decisions are never accepted. */
export function validateFinalBossWordCuts(raw: string, wordCount: number): FinalBossWordCut[] | null {
  if (wordCount <= 0) return []
  try {
    const parsed = JSON.parse(extractJsonObject(raw)) as { word_cuts?: unknown[] }
    const candidates = Array.isArray(parsed.word_cuts) ? parsed.word_cuts : []
    const cuts: FinalBossWordCut[] = []
    for (const candidate of candidates) {
      const c = candidate as { from?: unknown; to?: unknown; reason?: unknown }
      let from = Math.round(Number(c.from))
      let to = Math.round(Number(c.to))
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue
      if (from > to) [from, to] = [to, from]
      from = Math.max(0, Math.min(wordCount - 1, from))
      to = Math.max(0, Math.min(wordCount - 1, to))
      cuts.push({ from, to, reason: String(c.reason ?? '') })
    }
    cuts.sort((a, b) => a.from - b.from)
    const merged: FinalBossWordCut[] = []
    for (const cut of cuts) {
      const last = merged[merged.length - 1]
      if (last && cut.from <= last.to + 1) {
        last.to = Math.max(last.to, cut.to)
        if (cut.reason && !last.reason.includes(cut.reason)) last.reason = `${last.reason}; ${cut.reason}`.slice(0, 300)
      } else merged.push({ ...cut })
    }
    const removed = new Set<number>()
    for (const cut of merged) for (let i = cut.from; i <= cut.to; i++) removed.add(i)
    if (wordCount >= 20 && removed.size > wordCount * 0.9) return null
    return merged
  } catch {
    return null
  }
}

export interface FinalBossSpeechWord {
  start: number
  end: number
}

/** Convert raw Final Boss VAD gaps to exact protected cuts. If AssemblyAI says
 * a surviving word occupies any part of a candidate, the whole candidate is
 * rejected. Edge trim only consumes configured padding; it cannot enter speech. */
export function planFinalBossSilenceCuts(
  rawGaps: { start: number; end: number }[],
  survivingWords: FinalBossSpeechWord[],
  settings: RetakeFinalBossSettings,
  durationS: number
): SilenceRegion[] {
  const words = [...survivingWords].sort((a, b) => a.start - b.start)
  const output: SilenceRegion[] = []
  const epsilon = 0.002

  for (const [index, source] of rawGaps.entries()) {
    const start = Math.max(0, Math.min(durationS, source.start))
    const end = Math.max(0, Math.min(durationS, source.end))
    if (end - start < 0.04) continue
    if (words.some((word) => word.start < end - epsilon && word.end > start + epsilon)) continue

    const hasPrevious = words.some((word) => word.end <= start + epsilon)
    const hasNext = words.some((word) => word.start >= end - epsilon)
    if (!hasPrevious && !hasNext) continue

    const keepAfter = hasPrevious ? Math.max(0, settings.padAfterS - settings.trimEdgesS) : 0
    const keepBefore = hasNext ? Math.max(0, settings.padBeforeS - settings.trimEdgesS) : 0
    const cutStart = start + keepAfter
    const cutEnd = end - keepBefore
    if (cutEnd - cutStart < 0.04) continue

    output.push({
      id: `finalboss-sil-${index}`,
      start: cutStart,
      end: cutEnd,
      action: 'remove',
      protect: true
    })
  }
  return output
}
