// Pure helpers for AI-controlled overlay placement. No Node / DOM deps so these
// can be unit-tested headlessly and reused by both the main process and the
// renderer. The LLM call lives in src/main/overlay-rules.ts; everything here is
// deterministic.

import type {
  OverlayAnimation,
  OverlayEvent,
  OverlayPosition,
  OverlayRule,
  Transcript
} from './types'

export interface Sentence {
  index: number
  text: string
  start: number
  end: number
}

export interface CleanOpts {
  /** source media duration (seconds) — clamp target. */
  duration: number
  /** cut-out ranges (deleted/silence) to keep overlays out of. */
  cuts: { start: number; end: number }[]
  maxEvents?: number
  maxPerOverlay?: number
  minDur?: number
  maxDur?: number
  minGap?: number
}

const DEFAULTS = { maxEvents: 30, maxPerOverlay: 3, minDur: 2.5, maxDur: 4, minGap: 0.3 }

/** Map a named position to a normalized box on the frame (x,y = top-left fraction). */
export function positionToBox(position: OverlayPosition): { x: number; y: number; scale: number } {
  switch (position) {
    case 'top_center': return { x: 0.29, y: 0.06, scale: 0.42 }
    case 'center': return { x: 0.29, y: 0.40, scale: 0.42 }
    case 'bottom_center': return { x: 0.29, y: 0.78, scale: 0.42 }
    case 'top_left': return { x: 0.05, y: 0.06, scale: 0.40 }
    case 'top_right': return { x: 0.55, y: 0.06, scale: 0.40 }
    case 'bottom_left': return { x: 0.05, y: 0.78, scale: 0.40 }
    case 'bottom_right': return { x: 0.55, y: 0.78, scale: 0.40 }
    default: return { x: 0.29, y: 0.06, scale: 0.42 }
  }
}

/** Break the transcript into timestamped sentences from its segments (skips cut words). */
export function chunkTranscript(transcript: Transcript): Sentence[] {
  const out: Sentence[] = []
  const segs = transcript.segments ?? []
  for (let i = 0; i < segs.length; i++) {
    const live = segs[i].words.filter((w) => !w.deleted)
    if (live.length === 0) continue
    const text = live.map((w) => w.text).join(' ').trim()
    if (!text) continue
    out.push({ index: out.length, text, start: live[0].start, end: live[live.length - 1].end })
  }
  return out
}

const STOPWORDS = new Set([
  'show', 'this', 'that', 'when', 'i', 'me', 'my', 'the', 'a', 'an', 'or', 'and', 'of', 'to',
  'about', 'talk', 'talking', 'mention', 'mentions', 'mentioning', 'say', 'saying', 'said',
  'feel', 'feeling', 'feels', 'overlay', 'card', 'whenever', 'while', 'during', 'is', 'it',
  'for', 'on', 'in', 'with', 'not', 'no', 'are', 'be', 'being', 'them', 'they', 'we', 'you'
])

/** Pull candidate trigger keywords/phrases out of a free-text instruction. */
export function extractKeywords(instruction: string): string[] {
  const lower = (instruction || '').toLowerCase()
  const out = new Set<string>()
  // multiword phrases between commas / "or" lists are strong signals
  for (const phrase of lower.split(/,|\bor\b|\band\b|;|\./)) {
    const p = phrase.replace(/[^a-z0-9%\s]/g, ' ').trim()
    const words = p.split(/\s+/).filter((w) => w && (w.length >= 3 || /\d/.test(w)) && !STOPWORDS.has(w))
    if (words.length >= 2) out.add(words.slice(0, 4).join(' ')) // keep a short phrase
    for (const w of words) out.add(w)                            // and the individual words
  }
  return [...out].filter(Boolean)
}

function midInCuts(start: number, end: number, cuts: { start: number; end: number }[]): boolean {
  const mid = (start + end) / 2
  return cuts.some((c) => mid >= c.start && mid < c.end)
}

/** No-LLM fallback: place an overlay on sentences whose text contains a rule keyword. */
export function keywordFallback(rules: OverlayRule[], sentences: Sentence[]): OverlayEvent[] {
  const events: OverlayEvent[] = []
  for (const rule of rules) {
    const keys = extractKeywords(rule.instruction)
    if (keys.length === 0) continue
    for (const s of sentences) {
      // Normalize punctuation to spaces so padded lookup is a true WORD match —
      // a bare substring fallback made "art" hit "start" and "tea" hit "instead".
      const hay = ' ' + s.text.toLowerCase().replace(/[^a-z0-9%]+/g, ' ') + ' '
      const hit = keys.find((k) => hay.includes(' ' + k + ' '))
      if (hit) {
        events.push({
          overlayId: rule.overlayId,
          start: s.start,
          end: s.end,
          position: rule.position,
          animation: rule.animation,
          reason: `keyword "${hit}" in: ${s.text.slice(0, 60)}`,
          source: 'keyword'
        })
      }
    }
  }
  return events
}

/**
 * Validate + clean raw events (from LLM or fallback) into safe, non-overlapping
 * placements. position/animation/duration come from the RULE (authoritative);
 * the matcher only chooses WHERE in time. Returns kept events + rejection notes.
 */
export function validateAndCleanEvents(
  raw: Array<Partial<OverlayEvent>>,
  rules: OverlayRule[],
  opts: CleanOpts
): { events: OverlayEvent[]; rejected: string[] } {
  const o = { ...DEFAULTS, ...opts }
  const rulesById = new Map(rules.map((r) => [r.overlayId, r]))
  const rejected: string[] = []

  // 1) normalize each candidate against its rule + the video bounds.
  const normalized: OverlayEvent[] = []
  for (const e of raw) {
    const rule = rulesById.get(String(e.overlayId))
    if (!rule) { rejected.push(`unknown overlayId ${e.overlayId}`); continue }
    let start = Number(e.start)
    if (!Number.isFinite(start)) { rejected.push(`bad start for ${rule.name}`); continue }
    const dur = Math.min(o.maxDur, Math.max(o.minDur, rule.durationSeconds || 3))
    start = Math.max(0, Math.min(start, Math.max(0, o.duration - dur)))
    const end = Math.min(o.duration, start + dur)
    if (end - start < 0.5) { rejected.push(`zero-length for ${rule.name}`); continue }
    if (midInCuts(start, end, o.cuts)) { rejected.push(`${rule.name} lands in a cut-out section`); continue }
    normalized.push({
      overlayId: rule.overlayId,
      start, end,
      position: rule.position,
      animation: rule.animation,
      reason: String(e.reason ?? '').slice(0, 160),
      source: e.source === 'keyword' ? 'keyword' : 'llm'
    })
  }

  // 2) sort, then greedily drop time-overlaps + enforce per-overlay and global caps.
  normalized.sort((a, b) => a.start - b.start)
  const perOverlay = new Map<string, number>()
  const kept: OverlayEvent[] = []
  let lastEnd = -Infinity
  for (const e of normalized) {
    if (kept.length >= o.maxEvents) { rejected.push('hit max overlay events'); break }
    if (e.start < lastEnd + o.minGap) { rejected.push(`${e.overlayId} overlaps a kept overlay`); continue }
    const n = perOverlay.get(e.overlayId) ?? 0
    if (n >= o.maxPerOverlay) { rejected.push(`${e.overlayId} over per-overlay cap`); continue }
    kept.push(e)
    perOverlay.set(e.overlayId, n + 1)
    lastEnd = e.end
  }
  return { events: kept, rejected }
}
