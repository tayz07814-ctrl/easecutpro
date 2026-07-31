// AI Variations — cast a transcript into short-form section arrangements.
//
// The model receives the verbatim transcript with immutable word indices and
// returns SECTIONS (hook / intro / problem / selling / cta) as index ranges. It
// never sees or invents timestamps: indices are converted to seconds here, from
// the transcript's own word timings. That removes the single biggest failure mode
// of asking an LLM to edit video — hallucinated times that point at nothing.
//
// The result is an ordinary `Variation`, so it flows through exactly the same
// preview + apply path as a hand-written JSON file.

import type { Variation, VariationClip } from './variations'

export const VARIATION_ROLES = ['hook', 'intro', 'problem', 'selling', 'cta'] as const
export type VariationRole = (typeof VARIATION_ROLES)[number]

/** Human label for a role, used as the clip name in the timeline + panel. */
export const ROLE_LABEL: Record<string, string> = {
  hook: 'Hook',
  intro: 'Intro',
  problem: 'Problem',
  selling: 'Selling point',
  cta: 'CTA'
}

export interface AiVariationWord {
  text: string
  start: number
  end: number
}

/** The complete user message: index-anchored words, nothing else. No timings, so
 *  the model cannot anchor on (or fabricate) them. */
export function buildVariationPayload(words: AiVariationWord[], durationS: number, count: number): string {
  const lines = words.map((w, i) => `${i}|${w.text}`).join('\n')
  return (
    `SOURCE: ${durationS.toFixed(1)}s, ${words.length} words.\n` +
    `PRODUCE: ${count} distinct variation${count === 1 ? '' : 's'}.\n\n` +
    `VERBATIM TRANSCRIPT (immutable index|word):\n${lines}`
  )
}

/** Sentence-ending punctuation on the word itself — the transcript carries it
 *  inline, so a boundary is detectable without a separate segment list. */
function endsSentence(text: string): boolean {
  return /[.!?…]["')\]]*\s*$/.test(text.trim())
}

/** Snap a range out to whole sentences.
 *
 *  A section that begins mid-clause reads as a clipped-off fragment, which is the
 *  most common way an otherwise-good arrangement sounds broken. `from` walks back
 *  to just after the previous sentence end; `to` walks forward to the next one.
 *  Both walks are bounded so a transcript with no punctuation at all (some ASR
 *  output) degrades to the model's original range instead of swallowing
 *  everything. */
function snapToSentence(
  words: AiVariationWord[],
  from: number,
  to: number,
  maxWalk = 25
): { from: number; to: number } {
  let a = from
  for (let n = 0; n < maxWalk && a > 0; n++) {
    if (endsSentence(words[a - 1].text)) break
    a--
  }
  let b = to
  for (let n = 0; n < maxWalk && b < words.length - 1; n++) {
    if (endsSentence(words[b].text)) break
    b++
  }
  return { from: a, to: b }
}

export interface AiVariationResult {
  variations: Variation[]
  warnings: string[]
}

function extractJson(raw: string): string {
  let t = raw.replace(/<think>[\s\S]*?<\/think>/gi, '')
  t = t.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
  const m = t.match(/\{[\s\S]*\}/)
  return (m ? m[0] : t).trim()
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v))

/** Validate the model's reply and convert word indices to source seconds.
 *
 *  Deliberately UNLIKE the retake EDL validator: sections are never sorted and
 *  never merged. Array order IS the edit, and repeated or overlapping ranges are
 *  legitimate (a hook may reuse a line the body also contains). Sorting or
 *  merging here would quietly destroy the feature. */
export function validateAiVariations(
  raw: string,
  words: AiVariationWord[],
  snap = true
): AiVariationResult {
  const warnings: string[] = []
  if (!words.length) return { variations: [], warnings: ['The transcript is empty.'] }

  let parsed: { variations?: unknown[] }
  try {
    parsed = JSON.parse(extractJson(raw)) as { variations?: unknown[] }
  } catch {
    return { variations: [], warnings: ['The AI reply wasn’t valid JSON.'] }
  }

  const rows = Array.isArray(parsed.variations) ? parsed.variations : []
  if (!rows.length) return { variations: [], warnings: ['The AI returned no variations.'] }

  const out: Variation[] = []
  for (const [vi, rawVar] of rows.entries()) {
    const v = (rawVar ?? {}) as { name?: unknown; sections?: unknown[] }
    const sections = Array.isArray(v.sections) ? v.sections : []
    const clips: VariationClip[] = []

    for (const [si, rawSec] of sections.entries()) {
      const s = (rawSec ?? {}) as { role?: unknown; from?: unknown; to?: unknown }
      let from = Math.round(num(s.from))
      let to = Math.round(num(s.to))
      if (!Number.isFinite(from) || !Number.isFinite(to)) {
        warnings.push(`variation ${vi + 1}, section ${si + 1}: no usable word range — skipped`)
        continue
      }
      if (from > to) [from, to] = [to, from]
      from = Math.max(0, Math.min(words.length - 1, from))
      to = Math.max(0, Math.min(words.length - 1, to))
      if (snap) ({ from, to } = snapToSentence(words, from, to))

      const start = words[from].start
      const end = words[to].end
      if (!(end > start)) {
        warnings.push(`variation ${vi + 1}, section ${si + 1}: zero-length after snapping — skipped`)
        continue
      }
      const role = typeof s.role === 'string' ? s.role.toLowerCase() : ''
      clips.push({ start, end, name: ROLE_LABEL[role] ?? (role ? role : `Section ${si + 1}`) })
    }

    if (!clips.length) {
      warnings.push(`variation ${vi + 1}: no usable sections — dropped`)
      continue
    }
    const name = typeof v.name === 'string' && v.name.trim() ? v.name.trim() : `Variation ${out.length + 1}`
    out.push({ name, clips })
  }

  if (!out.length) warnings.push('None of the AI’s variations were usable.')
  return { variations: out, warnings }
}
