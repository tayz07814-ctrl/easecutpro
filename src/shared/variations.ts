// Variations — cut a source video into segments and rejoin them in a creator-
// supplied order.
//
// The creator hands the editor a JSON file listing ranges of the SOURCE video.
// Each entry is one clip; the ARRAY ORDER is the edit order, which is the whole
// point: ranges may be out of order, may repeat, and may overlap. A 60s source
// with [[5,8],[1,3],[15,25],[55,60]] becomes a 21s edit whose second clip is
// earlier in the source than its first.
//
// This module is pure parsing/validation — no timeline types, no DOM — so the
// same contract can be reused by an importer, a test, or a CLI later.

/** One segment of the source, in SECONDS. */
export interface VariationClip {
  start: number
  end: number
  /** Optional creator label, shown in the panel and used as the clip name. */
  name?: string
}

export interface Variation {
  /** Optional name for the whole arrangement (falls back to the file name). */
  name?: string
  clips: VariationClip[]
}

export interface VariationParseResult {
  variation: Variation | null
  /** Fatal problem — nothing can be applied. */
  error?: string
  /** Non-fatal notes (dropped/clamped entries). Always safe to show. */
  warnings: string[]
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Accept the shapes a creator (or an LLM asked for one) would plausibly write:
 *
 *   [[5, 8], [1, 3]]
 *   [{ "start": 5, "end": 8 }, ...]
 *   { "clips": [...] }                 // also "segments" / "variations"
 *
 * Field aliases: start|from|in|s, end|to|out|e. A `duration`/`length` may stand
 * in for `end`. Times may be numbers or numeric strings ("5", "5.5").
 */
function readTime(row: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = row[k]
    if (isNum(v)) return v
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  }
  return undefined
}

function coerceClip(raw: unknown, index: number, warnings: string[]): VariationClip | null {
  // [start, end] tuple
  if (Array.isArray(raw)) {
    const [a, b] = raw
    const start = isNum(a) ? a : Number(a)
    const end = isNum(b) ? b : Number(b)
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      warnings.push(`clip ${index + 1}: expected [start, end] numbers — skipped`)
      return null
    }
    return { start, end }
  }
  if (!raw || typeof raw !== 'object') {
    warnings.push(`clip ${index + 1}: not an object or [start, end] pair — skipped`)
    return null
  }
  const row = raw as Record<string, unknown>
  const start = readTime(row, ['start', 'from', 'in', 's', 'startS', 'start_s'])
  let end = readTime(row, ['end', 'to', 'out', 'e', 'endS', 'end_s'])
  if (end === undefined) {
    const dur = readTime(row, ['duration', 'length', 'dur'])
    if (start !== undefined && dur !== undefined) end = start + dur
  }
  if (start === undefined || end === undefined) {
    warnings.push(`clip ${index + 1}: missing start/end — skipped`)
    return null
  }
  const name = typeof row.name === 'string' ? row.name : typeof row.label === 'string' ? row.label : undefined
  return { start, end, name }
}

/** Parse + validate a variation file against the source duration.
 *
 *  `durationS` is the SOURCE length: ranges past the end are clamped (not
 *  dropped) so a creator writing `[55, 60]` against a 59.8s file still gets the
 *  tail. Reversed pairs are swapped rather than rejected — the intent is
 *  unambiguous. Zero-length ranges are dropped, since they would produce a clip
 *  nothing can show. Order, repeats and overlaps are all preserved verbatim. */
export function parseVariation(text: string, durationS: number, fallbackName?: string): VariationParseResult {
  const warnings: string[] = []
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    return { variation: null, error: `That file isn’t valid JSON (${(e as Error).message})`, warnings }
  }

  let rows: unknown[] | null = null
  let name: string | undefined
  if (Array.isArray(data)) rows = data
  else if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>
    const list = o.clips ?? o.segments ?? o.variations ?? o.ranges
    if (Array.isArray(list)) rows = list
    if (typeof o.name === 'string') name = o.name
  }
  if (!rows) {
    return {
      variation: null,
      error: 'Expected a list of clips — either a top-level array, or an object with a "clips" array.',
      warnings
    }
  }
  if (!rows.length) return { variation: null, error: 'That file has no clips in it.', warnings }

  const clips: VariationClip[] = []
  for (const [i, raw] of rows.entries()) {
    const c = coerceClip(raw, i, warnings)
    if (!c) continue
    let { start, end } = c
    if (start > end) {
      warnings.push(`clip ${i + 1}: start was after end — swapped`)
      ;[start, end] = [end, start]
    }
    if (start < 0) {
      warnings.push(`clip ${i + 1}: started before 0 — clamped`)
      start = 0
    }
    if (durationS > 0 && end > durationS) {
      warnings.push(`clip ${i + 1}: ran past the end of the video — clamped to ${durationS.toFixed(2)}s`)
      end = durationS
    }
    if (durationS > 0 && start >= durationS) {
      warnings.push(`clip ${i + 1}: starts past the end of the video — skipped`)
      continue
    }
    if (end - start < 0.01) {
      warnings.push(`clip ${i + 1}: shorter than 10ms — skipped`)
      continue
    }
    clips.push({ start, end, name: c.name })
  }

  if (!clips.length) return { variation: null, error: 'None of the clips in that file were usable.', warnings }
  return { variation: { name: name ?? fallbackName, clips }, warnings }
}

/** Total runtime of the arrangement, in seconds. */
export function variationDuration(v: Variation): number {
  return v.clips.reduce((n, c) => n + Math.max(0, c.end - c.start), 0)
}

/** The example shown in the panel's empty state and copied by "Copy example". */
export const VARIATION_EXAMPLE = `{
  "name": "Hook first",
  "clips": [
    { "start": 5,  "end": 8,  "name": "Hook" },
    { "start": 1,  "end": 3,  "name": "Intro" },
    { "start": 15, "end": 25, "name": "Main point" },
    { "start": 55, "end": 60, "name": "CTA" }
  ]
}`
