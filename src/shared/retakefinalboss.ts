// Retake Final Boss — isolated contracts and pure planning logic.
//
// This module deliberately does not import any previous Retake/VAD settings or
// silence planner. Gemma receives only indexed verbatim words. The Final Boss
// VAD pass turns raw non-speech regions into protected cuts with its own fields.

import type { SilenceRegion } from './types'

export interface RetakeFinalBossSettings {
  /** Audio protected before the next spoken word. */
  padBeforeS: number
  /** Audio protected after the previous spoken word. */
  padAfterS: number
  /** Tightens a cut by consuming the protected padding, then cutting past the
   *  VAD boundary once that padding is spent. */
  trimEdgesS: number
  /** Incoming audio overlap/crossfade used by preview and export. */
  audioOverlapMs: number
  /** Drop a dead-air tail off a clip ENDING — see TAIL_TRIM_DB below. Only the
   *  punchy presets (No Chill, Espresso Shot) turn this on; the relaxed ones
   *  would have their own padding eaten by it. */
  tailTrim: boolean
}

export const DEFAULT_RETAKE_FINAL_BOSS_SETTINGS: RetakeFinalBossSettings = {
  padBeforeS: 0.18,
  padAfterS: 0.12,
  trimEdgesS: 0.02,
  audioOverlapMs: 20,
  tailTrim: false
}

/** Silence presets. Non-editable presets apply fixed values (no sliders shown);
 *  the single editable one ("Mad Scientist") reveals the custom sliders. */
export interface SilencePreset {
  id: string
  label: string
  editable: boolean
  settings: RetakeFinalBossSettings
}

// `tailTrim` is ON for the two punchy presets only. The relaxed presets exist to
// KEEP breathing room, so trimming their dead-air tails would undo the setting
// the creator just picked.
export const FSMN_SILENCE_PRESETS: SilencePreset[] = [
  { id: 'chill-talker', label: 'Chill Talker', editable: false, settings: { padBeforeS: 0.4, padAfterS: 0.8, trimEdgesS: 0, audioOverlapMs: 50, tailTrim: false } },
  { id: 'just-right', label: 'Just Right', editable: false, settings: { padBeforeS: 0.1, padAfterS: 0.3, trimEdgesS: 0, audioOverlapMs: 50, tailTrim: false } },
  { id: 'no-chill', label: 'No Chill', editable: false, settings: { padBeforeS: 0.05, padAfterS: 0.1, trimEdgesS: 0, audioOverlapMs: 50, tailTrim: true } },
  { id: 'espresso-shot', label: 'Espresso Shot', editable: false, settings: { padBeforeS: 0, padAfterS: 0, trimEdgesS: 0.05, audioOverlapMs: 50, tailTrim: true } },
  { id: 'mad-scientist', label: 'Mad Scientist', editable: true, settings: { padBeforeS: 0.1, padAfterS: 0.3, trimEdgesS: 0, audioOverlapMs: 0, tailTrim: false } }
]

export const DEFAULT_FSMN_PRESET_ID = 'just-right'
export const CUSTOM_FSMN_PRESET_ID = 'mad-scientist'

export function getFsmnPreset(id: string | null | undefined): SilencePreset {
  return FSMN_SILENCE_PRESETS.find((p) => p.id === id) ?? FSMN_SILENCE_PRESETS.find((p) => p.id === DEFAULT_FSMN_PRESET_ID)!
}

// The fixed FunASR endpoint state machine intentionally widens every returned
// speech segment. With the published defaults used by fsmnVad.ts, its reported
// end sits 160 ms after the speech transition and its reported start sits
// 260 ms before it. Inverting those segments therefore produces silence gaps
// that are too narrow by exactly these timestamp cushions. These are not VAD
// tuning values: removing them restores the underlying speech transitions so
// the creator's padding controls start from a truthful zero.
export const FSMN_AFTER_SPEECH_CUSHION_S = 0.16
export const FSMN_BEFORE_SPEECH_CUSHION_S = 0.26

// Quiet-tail trim — gated by `tailTrim`, on for No Chill + Espresso Shot.
//
// FSMN marks where speech stops, but a take rarely stops cleanly there: the clip
// hangs on a breath, room tone, or a mic settling. That tail is inaudible as
// speech yet audible as a lag before the cut. So we look at the last
// TAIL_TRIM_WINDOW_S of every CLIP ENDING (never an opening) and, when it is
// quieter than TAIL_TRIM_DB, pull the cut that much earlier — there is no speech
// left in that window to protect.
//
// -22 dBFS sits below conversational speech but above a noise floor, so a real
// trailing word keeps the clip and only dead air is caught.
export const TAIL_TRIM_DB = -22
export const TAIL_TRIM_WINDOW_S = 0.2

export function alignFinalBossFsmnGaps(
  rawGaps: { start: number; end: number }[],
  durationS: number
): { start: number; end: number }[] {
  const edgeEpsilon = 0.002
  return rawGaps.map((raw) => {
    const start = Math.max(0, Math.min(durationS, raw.start))
    const end = Math.max(start, Math.min(durationS, raw.end))
    return {
      // Leading/trailing media edges have no neighbouring speech cushion.
      start: start <= edgeEpsilon ? start : Math.max(0, start - FSMN_AFTER_SPEECH_CUSHION_S),
      end: end >= durationS - edgeEpsilon ? end : Math.min(durationS, end + FSMN_BEFORE_SPEECH_CUSHION_S)
    }
  })
}

export function normalizeRetakeFinalBossSettings(
  value: Partial<RetakeFinalBossSettings> | null | undefined
): RetakeFinalBossSettings {
  const d = DEFAULT_RETAKE_FINAL_BOSS_SETTINGS
  const number = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return {
    padBeforeS: Math.max(0, Math.min(0.5, number(value?.padBeforeS, d.padBeforeS))),
    padAfterS: Math.max(0, Math.min(0.5, number(value?.padAfterS, d.padAfterS))),
    trimEdgesS: Math.max(0, Math.min(0.2, number(value?.trimEdgesS, d.trimEdgesS))),
    audioOverlapMs: Math.max(0, Math.min(60, number(value?.audioOverlapMs, d.audioOverlapMs))),
    tailTrim: typeof value?.tailTrim === 'boolean' ? value.tailTrim : d.tailTrim
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

/** Convert raw Final Boss VAD gaps to exact protected cuts.
 *
 * FSMN-VAD owns speech/non-speech classification and endpoint decisions. The
 * caller first removes FSMN's fixed timestamp cushion; this function then
 * applies only the requested cut-edge padding. */
export function planFinalBossSilenceCuts(
  rawGaps: { start: number; end: number }[],
  settings: RetakeFinalBossSettings,
  durationS: number
): SilenceRegion[] {
  const output: SilenceRegion[] = []

  for (const [index, source] of rawGaps.entries()) {
    const start = Math.max(0, Math.min(durationS, source.start))
    const end = Math.max(0, Math.min(durationS, source.end))
    // `trimEdgesS` first consumes the protected padding, then keeps cutting PAST
    // the VAD-defined boundary. That second half is the point of the control: a
    // zero-padding preset (Espresso Shot is 0/0/50ms) had nothing left to eat, so
    // the old `Math.max(0, pad - trim)` floor pinned both edges to the gap and the
    // setting did nothing. The bite past the boundary is bounded by the slider —
    // normalizeRetakeFinalBossSettings caps trimEdgesS at 0.2s.
    const cutStart = Math.max(0, start + settings.padAfterS - settings.trimEdgesS)
    const cutEnd = Math.min(durationS, end - settings.padBeforeS + settings.trimEdgesS)
    if (cutEnd - cutStart < 0.04) continue
    output.push({
      id: `finalboss-sil-${index}`,
      start: cutStart,
      end: cutEnd,
      action: 'remove',
      protect: true
    })
  }

  // Trim can push a cut past its own gap, so two close pauses can end up on
  // overlapping spans. Collapse them — protected regions are applied verbatim
  // downstream, and overlapping verbatim spans would double-cut.
  const merged: SilenceRegion[] = []
  for (const region of output.sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1]
    if (last && region.start <= last.end) last.end = Math.max(last.end, region.end)
    else merged.push({ ...region })
  }
  return merged.map((region, i) => ({ ...region, id: `finalboss-sil-${i}` }))
}
