// EaseCutPro — Auto Zoom (cloud). Adds dynamic punch-in zooms to the important
// clips of an edit. WHICH moments matter is decided by Gemma (OpenRouter) via the
// `auto-zoom-judge` edge function; the zoom itself reuses the EXISTING per-clip Ken
// Burns machinery (clip.metadata.ovZoomStart/ovZoomEnd/ovScale), so it renders in
// the preview and bakes into every export path (mediabunny + WebCodecs worker) with
// zero new render code.
//
// TARGET: the MAIN-LANE clips of the mounted timeline document — i.e. the kept /
// cut speech segments. When the timeline is still ONE un-cut clip (auto-zoom on
// import without cutting), it is first split at sentence boundaries so there are
// individual segments to zoom. An edge/LLM failure degrades to a deterministic
// "zoom the longer, well-spaced segments" pass so the feature always does something.

import { getSharedEngine } from '../timelineEngine'
import * as C from '@shared/timeline/commands'
import type { Command } from '@shared/timeline/commands'
import { framesToSeconds, secondsToFrames } from '@shared/timeline/time'
import type { TimelineDocument } from '@shared/timeline/types'
import { docSourceToEdited } from '../docTime'
import { invokeEdge } from './supabase'
import type { AutoZoomJudgeReq, AutoZoomJudgeRes } from '@shared/cloud'

/** Gemma on OpenRouter — already whitelisted in the judge edge functions. */
const GEMMA_MODEL = 'google/gemma-4-31b-it'

// Zoom feel. 'in' ramps ovZoomStart→ovZoomEnd across the clip (a smooth push-in);
// 'hold' is a static punch (ovScale). Levels are CLAMPED so a stray model number
// can never blow the frame out.
const MIN_LEVEL = 1.04
const MAX_LEVEL = 1.2
const DEFAULT_LEVEL = 1.12
const MIN_CLIP_S = 0.9 // a clip shorter than this looks glitchy zoomed → never zoom it
const MAX_FRAC = 0.55 // never zoom more than this fraction of the eligible segments
const MAX_SEGMENTS = 80 // cap the split of one long clip (avoid shredding it)

/** A transcript word in SOURCE time (only the fields Auto Zoom needs). */
export interface AZWord {
  start: number
  end: number
  text: string
}

export interface AutoZoomResult {
  count: number
  message: string
}

type Style = 'in' | 'hold'
interface ZoomPick {
  i: number
  level: number
  style: Style
}

function clampLevel(v: unknown): number {
  const n = typeof v === 'number' && isFinite(v) ? v : DEFAULT_LEVEL
  // Some models emit a percentage (115) or a delta (0.15); normalise both.
  const asFactor = n > 3 ? n / 100 : n < 1 ? 1 + n : n
  return Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, asFactor))
}

/** Group kept words into sentence-ish segments (break on . ! ? or ~12 words / 7s). */
function sentenceGroups(words: AZWord[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  let cur: AZWord[] = []
  const flush = (): void => {
    if (cur.length) out.push({ start: cur[0].start, end: cur[cur.length - 1].end })
    cur = []
  }
  for (const w of words) {
    cur.push(w)
    const long = cur.length >= 12 || w.end - cur[0].start >= 7
    if (/[.!?]$/.test(w.text.trim()) || long) flush()
  }
  flush()
  return out
}

/** Split a single un-cut main clip into sentence pieces so Auto Zoom has segments
 *  to work with. Returns true if it split anything. Splits DESCENDING on the same
 *  clip id — splitClipInDoc keeps the LEFT piece under the original id, so each
 *  later split still targets [start, prevCut]. */
function splitSingleClip(doc: TimelineDocument, clipId: string, words: AZWord[]): boolean {
  const groups = sentenceGroups(words)
  if (groups.length < 2) return false
  const main = doc.tracks.find((t) => t.isMain)
  const clip = main?.clips.find((c) => c.id === clipId)
  if (!clip) return false
  const tb = doc.timebase
  // Split at the START of every group after the first, in edited frames, strictly
  // inside the clip and no closer than MIN_CLIP_S apart.
  const minGap = secondsToFrames(MIN_CLIP_S, tb)
  const frames: number[] = []
  for (let g = 1; g < groups.length && frames.length < MAX_SEGMENTS - 1; g++) {
    const f = Math.round(secondsToFrames(docSourceToEdited(doc, groups[g].start), tb))
    if (f <= clip.start + minGap || f >= clip.end - minGap) continue
    if (frames.length && f - frames[frames.length - 1] < minGap) continue
    frames.push(f)
  }
  if (!frames.length) return false
  const engine = getSharedEngine()
  if (!engine) return false
  // descending so every split targets the original (left-kept) clip id
  engine.batch(
    'Auto zoom: segment',
    [...frames].sort((a, b) => b - a).map((f) => C.splitClip(clipId, f))
  )
  return true
}

/** Ask Gemma which segments deserve a zoom. Returns [] on any failure. */
async function judgeZooms(
  segments: { i: number; t: string; d: number }[]
): Promise<ZoomPick[]> {
  try {
    const res = await invokeEdge<AutoZoomJudgeRes>('auto-zoom-judge', {
      segments: JSON.stringify(segments),
      model: GEMMA_MODEL
    } satisfies AutoZoomJudgeReq)
    if (!res?.raw) return []
    const parsed = JSON.parse(res.raw) as { zooms?: { i?: number; level?: number; style?: string }[] }
    const zooms = Array.isArray(parsed?.zooms) ? parsed.zooms : []
    return zooms
      .filter((z) => typeof z?.i === 'number')
      .map((z) => ({
        i: z.i as number,
        level: clampLevel(z.level),
        style: z.style === 'hold' ? 'hold' : ('in' as Style)
      }))
  } catch {
    return []
  }
}

/** Deterministic fallback when the edge/LLM is unavailable: zoom the longest,
 *  non-adjacent segments up to MAX_FRAC of them, as gentle push-ins. */
function fallbackZooms(segments: { i: number; d: number }[]): ZoomPick[] {
  const budget = Math.max(1, Math.floor(segments.length * MAX_FRAC))
  const byLen = [...segments].sort((a, b) => b.d - a.d)
  const chosen = new Set<number>()
  for (const s of byLen) {
    if (chosen.size >= budget) break
    if (chosen.has(s.i - 1) || chosen.has(s.i + 1)) continue // keep them spaced out
    chosen.add(s.i)
  }
  return [...chosen].map((i, k) => ({ i, level: k % 2 ? 1.14 : 1.1, style: 'in' as Style }))
}

/**
 * Plan + apply Auto Zoom on the mounted timeline. `words` are the KEPT transcript
 * words (SOURCE time; deleted words already filtered out by the caller). Returns
 * how many zooms were applied and a user-facing message.
 */
export async function planAndApplyZooms(words: AZWord[]): Promise<AutoZoomResult> {
  const engine = getSharedEngine()
  if (!engine) return { count: 0, message: 'Open a project timeline first, then Auto Zoom.' }
  const kept = words.filter((w) => w.text && w.text.trim())

  // One un-cut clip → split into sentence segments first (best-effort; needs words).
  let main = engine.document.tracks.find((t) => t.isMain)
  if (main && main.clips.length === 1 && kept.length) {
    splitSingleClip(engine.document, main.clips[0].id, kept)
  }

  const doc = engine.document
  const tb = doc.timebase
  main = doc.tracks.find((t) => t.isMain)
  const clips = main ? [...main.clips].sort((a, b) => a.start - b.start) : []
  if (clips.length < 2) return { count: 0, message: 'Auto Zoom needs a few cut clips — run a cut first.' }

  // Bucket the kept words into the clip whose EDITED range contains them (works for
  // single-source cut edits; montage degrades gracefully to by-edited-time).
  const texts = clips.map(() => [] as string[])
  const bounds = clips.map((c) => ({
    lo: framesToSeconds(c.start, tb),
    hi: framesToSeconds(c.end, tb)
  }))
  for (const w of kept) {
    const e = docSourceToEdited(doc, w.start)
    let idx = bounds.findIndex((b) => e >= b.lo && e < b.hi)
    if (idx < 0) idx = e <= bounds[0].lo ? 0 : clips.length - 1
    texts[idx].push(w.text.trim())
  }

  // Eligible = long-enough clips that actually contain speech.
  const eligible: { i: number; clipIdx: number; t: string; d: number }[] = []
  clips.forEach((c, ci) => {
    const d = framesToSeconds(c.duration, tb)
    const t = texts[ci].join(' ').replace(/\s+([,.!?;:])/g, '$1').trim()
    if (d >= MIN_CLIP_S && t) eligible.push({ i: eligible.length, clipIdx: ci, t: t.slice(0, 180), d: Math.round(d * 10) / 10 })
  })
  if (!eligible.length) return { count: 0, message: 'No clips long enough to zoom.' }

  let picks = await judgeZooms(eligible.map(({ i, t, d }) => ({ i, t, d })))
  if (!picks.length) picks = fallbackZooms(eligible.map(({ i, d }) => ({ i, d })))

  // Enforce the cap + no two consecutive zoomed segments (keeps it lively, not busy).
  const budget = Math.max(1, Math.floor(eligible.length * MAX_FRAC))
  const applied = new Set<number>()
  const cmds: Command[] = []
  for (const p of picks.sort((a, b) => b.level - a.level)) {
    if (applied.size >= budget) break
    if (p.i < 0 || p.i >= eligible.length) continue
    if (applied.has(p.i) || applied.has(p.i - 1) || applied.has(p.i + 1)) continue
    const clip = clips[eligible[p.i].clipIdx]
    applied.add(p.i)
    cmds.push(
      p.style === 'hold'
        ? C.setOverlayPlacement(clip.id, { ovScale: p.level, ovZoomStart: 1, ovZoomEnd: 1 })
        : C.setOverlayPlacement(clip.id, { ovZoomStart: 1, ovZoomEnd: p.level })
    )
  }
  if (!cmds.length) return { count: 0, message: 'No zooms added.' }
  engine.batch('Auto zoom', cmds)
  return { count: cmds.length, message: `Added ${cmds.length} zoom${cmds.length === 1 ? '' : 's'} to the key moments.` }
}
