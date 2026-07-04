/**
 * Cut Lord — settings + pure helpers for the ClutterCleaner tab.
 *
 * FastCut / ProCut both run their word engines AND a VAD silence pass; nothing
 * is applied until the user presses "Execute cuts" (words + silence chips are
 * only HIGHLIGHTED in the transcript for review). The ⚙ dropdown picks the VAD
 * profile:
 *   smooth (default) : VAD 50% · trim 0.10s · pad 0.04s · min gap 0.15s
 *   aggressive       : VAD 70% · trim 0.25s · pad 0.02s · min gap 0.10s
 *                      + fast dB pass (-28 dB · min gap 0.1s · pad 0.01s)
 *   manual switch ON : the user's sliders replace the preset entirely.
 *
 * PURE module — no IO — headless-testable.
 */
import type { SilenceDetectOptions, SilenceRegion, Word } from './types'

export type CutLordMode = 'smooth' | 'aggressive'

export interface VadSettings {
  /** speech-probability threshold 0..1 (higher = cuts more). */
  threshold: number
  /** extra trim into speech on both sides of every cut (seconds) — snappier. */
  trimCuts: number
  /** keep-back padding around speech (seconds) — protects word edges. */
  padding: number
  /** ignore silences shorter than this (seconds). */
  minGap: number
}

export interface DbSettings {
  noiseDb: number
  minGap: number
  padding: number
}

export interface CutLordSettings {
  mode: CutLordMode
  /** when true, the manual slider values below replace the preset. */
  manual: boolean
  vad: VadSettings
  db: DbSettings
  /** when manual: also run the fast dB pass? (presets: aggressive only) */
  useDb: boolean
  /** filler detection: when ON, FastCut & ProCut also flag filler words
   *  (like/actually/literally/… — user-editable list) for review. */
  fillers: boolean
}

export const CUTLORD_PRESETS: Record<CutLordMode, { vad: VadSettings; db: DbSettings; useDb: boolean }> = {
  smooth: {
    vad: { threshold: 0.5, trimCuts: 0.1, padding: 0.04, minGap: 0.15 },
    db: { noiseDb: -28, minGap: 0.1, padding: 0.01 },
    useDb: false
  },
  aggressive: {
    vad: { threshold: 0.7, trimCuts: 0.25, padding: 0.02, minGap: 0.1 },
    db: { noiseDb: -28, minGap: 0.1, padding: 0.01 },
    useDb: true
  }
}

export const DEFAULT_CUTLORD_SETTINGS: CutLordSettings = {
  mode: 'smooth',
  manual: false,
  vad: { ...CUTLORD_PRESETS.smooth.vad },
  db: { ...CUTLORD_PRESETS.smooth.db },
  useDb: false,
  fillers: true
}

/** The values actually in force (preset, or the user's manual overrides).
 *  INVARIANT: the Smooth modifier NEVER runs the fast dB pass — VAD only.
 *  Only Aggressive (or the user's explicit Manual choice) may enable it. */
export function effectiveSettings(s: CutLordSettings): { vad: VadSettings; db: DbSettings; useDb: boolean } {
  if (s.manual) return { vad: s.vad, db: s.db, useDb: s.useDb }
  const p = CUTLORD_PRESETS[s.mode] ?? CUTLORD_PRESETS.smooth
  return { vad: { ...p.vad }, db: { ...p.db }, useDb: s.mode === 'aggressive' && p.useDb }
}

/** SilenceDetectOptions for the VAD pass. */
export function vadDetectOpts(s: CutLordSettings): SilenceDetectOptions {
  const e = effectiveSettings(s)
  return {
    mode: 'vad',
    noiseDb: -30, // unused in vad mode (fallback only)
    minDuration: e.vad.minGap,
    vadThreshold: e.vad.threshold,
    speechPadMs: Math.round(e.vad.padding * 1000),
    edgeTrimMs: Math.round(e.vad.trimCuts * 1000)
  }
}

/** SilenceDetectOptions for the fast dB pass (aggressive / manual+useDb). */
export function dbDetectOpts(s: CutLordSettings): SilenceDetectOptions {
  const e = effectiveSettings(s)
  return { mode: 'fast', noiseDb: e.db.noiseDb, minDuration: e.db.minGap }
}

/** Post-process dB-pass regions: apply the pass's own edge padding. */
export function padDbRegions(regions: SilenceRegion[], s: CutLordSettings): SilenceRegion[] {
  const pad = effectiveSettings(s).db.padding
  return regions
    .map((r) => ({ ...r, start: r.start + pad, end: r.end - pad }))
    .filter((r) => r.end - r.start >= 0.05)
}

/** Word-cut splice trim (feeds computeKeepRanges' pad; "trim cuts" setting). */
export function wordCutPad(s: CutLordSettings): number {
  return effectiveSettings(s).vad.trimCuts
}

/** Merge + dedupe staged silence regions (VAD ∪ dB ∪ engine), skipping any that
 *  overlap regions the user already owns. */
export function mergeStagedSilences(
  batches: SilenceRegion[][],
  existing: SilenceRegion[]
): SilenceRegion[] {
  const all = batches
    .flat()
    .filter((r) => r.end - r.start >= 0.05)
    .filter((r) => !existing.some((x) => x.action !== 'keep' && r.start < x.end && x.start < r.end))
    .sort((a, b) => a.start - b.start)
  const out: SilenceRegion[] = []
  for (const r of all) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end + 0.02) {
      last.end = Math.max(last.end, r.end)
      if (r.action === 'remove') last.action = 'remove'
    } else {
      out.push({ ...r })
    }
  }
  return out
}

/** Inline transcript silence chips: the gap after each word (>= minShow s),
 *  matched against staged/applied regions so the UI can highlight them. */
export interface SilenceChip {
  afterWordId: string
  start: number
  end: number
  durS: number
  /** id of the staged region covering this gap (if any). */
  stagedId?: string
  /** true when an APPLIED (project) region already cuts this gap. */
  applied?: boolean
}

export function buildSilenceChips(
  words: Word[],
  staged: SilenceRegion[],
  applied: SilenceRegion[],
  minShow = 0.2
): SilenceChip[] {
  const alive = words.filter((w) => !w.deleted)
  const chips: SilenceChip[] = []
  for (let i = 0; i < alive.length - 1; i++) {
    const a = alive[i].end
    const b = alive[i + 1].start
    const st = staged.find((r) => r.start < b && a < r.end)
    // Show the chip when the gap is visible OR an engine staged a cut in it
    // (a staged cut must always be reviewable, even in a short gap).
    if (b - a < minShow && !st) continue
    const ap = applied.find((r) => r.action !== 'keep' && r.start < b && a < r.end)
    chips.push({
      afterWordId: alive[i].id,
      start: a,
      end: b,
      durS: Number((b - a).toFixed(1)),
      stagedId: st?.id,
      applied: !!ap
    })
  }
  return chips
}
