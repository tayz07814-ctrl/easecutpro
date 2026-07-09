import type { Project, SequenceClip, Transcript, Word, Segment, SilenceRegion, Waveform } from './types'

export interface KeepRange {
  start: number
  end: number
}

/**
 * Build the KEEP ranges for the base track (in SOURCE time):
 * full timeline minus deleted-word ranges and removed/shortened silences.
 * Used by the renderer (skip-playback preview) and main (export stitching).
 */
/**
 * Slide a cut edge to the nearest ENERGY VALLEY within ±`win` seconds. Whisper
 * word timestamps are routinely 100–200ms off, so cutting exactly at them can
 * slice a word in half; the waveform knows where the actual air gap is. Pure;
 * no waveform -> returns t unchanged (classic behavior).
 */
export function snapToValley(t: number, wf: { peaksPerSec: number; peaks: number[] } | null | undefined, win = 0.12): number {
  if (!wf || !wf.peaks.length || wf.peaksPerSec <= 0) return t
  const i0 = Math.max(0, Math.floor((t - win) * wf.peaksPerSec))
  const i1 = Math.min(wf.peaks.length - 1, Math.ceil((t + win) * wf.peaksPerSec))
  if (i1 <= i0) return t
  const ti = Math.round(t * wf.peaksPerSec)
  let best = ti
  let bestVal = Number.POSITIVE_INFINITY
  for (let i = i0; i <= i1; i++) {
    const v = wf.peaks[i]
    // strictly better valley, or equally quiet but closer to the original spot
    if (v < bestVal - 1e-6 || (Math.abs(v - bestVal) <= 1e-6 && Math.abs(i - ti) < Math.abs(best - ti))) {
      bestVal = v
      best = i
    }
  }
  return best / wf.peaksPerSec
}

/**
 * Swallow orphaned stutter blips just outside cut edges. Whisper timestamps a
 * cut-off attempt ("Bu—") LATE, so a short burst of it can sit between real
 * silence and the cut boundary — beyond the valley-snap window — and survive
 * the cut ("Bu…But please"). Pattern matched per edge, using the waveform:
 *   start side: [ …kept | quiet >=120ms | blip 20–350ms | CUT… ]  -> cut the blip
 *   end side:   [ …CUT | blip 20–350ms | quiet >=120ms | kept… ]  -> cut the blip
 * A blip that covers >50% of a KEPT word's span is a real word — left alone.
 */
// Loudness-reference cache: computing the voiced median filters+sorts the WHOLE
// peaks array — fine once, but computeKeepRanges runs on every pointermove
// during a trim drag, and re-sorting ~100k peaks per frame made handles janky.
const voicedRefCache = new WeakMap<object, number>()

export function absorbEdgeBlips(
  cuts: KeepRange[],
  wf: { peaksPerSec: number; peaks: number[] },
  dur: number,
  words: { start: number; end: number; deleted?: boolean }[]
): void {
  const pps = wf.peaksPerSec
  if (!pps || !wf.peaks.length) return
  // Loudness reference: median of clearly-voiced peaks (cached per waveform).
  let ref = voicedRefCache.get(wf)
  if (ref === undefined) {
    const voiced = wf.peaks.filter((p) => p > 0.05).sort((a, b) => a - b)
    ref = voiced.length ? voiced[Math.floor(voiced.length / 2)] : 0.3
    voicedRefCache.set(wf, ref)
  }
  const QUIET = Math.max(0.04, ref * 0.3)
  const quiet = (i: number): boolean => (wf.peaks[i] ?? 0) < QUIET
  const REACH = Math.round(0.45 * pps)
  const kept = words.filter((w) => !w.deleted)
  const isRealWord = (a: number, b: number): boolean =>
    kept.some((w) => {
      const ov = Math.min(b, w.end) - Math.max(a, w.start)
      return ov > 0 && ov > 0.5 * Math.max(0.05, w.end - w.start)
    })

  for (const c of cuts) {
    // ---- start side: blip immediately BEFORE the cut ----
    {
      const edge = Math.round(c.start * pps) - 1
      const lo = Math.max(0, edge - REACH)
      let j = edge
      while (j >= lo && !quiet(j)) j-- // walk back over the blip
      const blipLen = (edge - j) / pps
      if (j >= lo && blipLen >= 0.02 && blipLen <= 0.35) {
        let q = j
        while (q >= lo && quiet(q)) q-- // require real silence behind it
        const quietLen = (j - q) / pps
        const blipStart = (j + 1) / pps
        if (quietLen >= 0.12 && !isRealWord(blipStart, c.start)) {
          c.start = Math.max(0, blipStart)
        }
      }
    }
    // ---- end side: blip immediately AFTER the cut ----
    {
      const edge = Math.round(c.end * pps) + 1
      const hi = Math.min(wf.peaks.length - 1, edge + REACH)
      let j = edge
      while (j <= hi && !quiet(j)) j++ // walk forward over the blip
      const blipLen = (j - edge) / pps
      if (j <= hi && blipLen >= 0.02 && blipLen <= 0.35) {
        let q = j
        while (q <= hi && quiet(q)) q++
        const quietLen = (q - j) / pps
        const blipEnd = j / pps
        if (quietLen >= 0.12 && !isRealWord(c.end, blipEnd)) {
          c.end = Math.min(dur, blipEnd)
        }
      }
    }
  }
}

export function computeKeepRanges(
  project: Project,
  /** optional waveform: when provided, cut edges snap to energy valleys and the
   *  result is what preview AND export should both use (pass the same peaks). */
  waveform?: { peaksPerSec: number; peaks: number[] } | null
): KeepRange[] {
  // Single-clip: media.duration (unchanged). Multi-clip base (no media): the
  // VIRTUAL montage duration, so project.transcript/silences/cuts (which live in
  // montage time) collapse the montage exactly like a single continuous video.
  const dur = project.media?.duration ?? baseTimelineDuration(project)
  if (dur <= 0) return []

  const cuts: KeepRange[] = []

  // Merge runs of consecutive deleted words into one span (first.start →
  // last.end) so the tiny silences BETWEEN deleted words are cut too. Only
  // bridge words that are actually CONTIGUOUS IN TIME: whisper's per-token
  // timestamps on repeated/hallucinated speech are often non-monotonic, and
  // blindly taking the last word's end could balloon a single cut across the
  // whole video (deleting a few repeats then wiped the entire timeline).
  const BRIDGE_GAP = 1.0 // max forward gap (s) to absorb between deleted words
  // Eat an extra 100ms into each side of every word-cut (the splice point) so the
  // breath / trailing vowel / lip-smack at the boundary goes too — snappier cuts.
  // Applies to all transcript-word cuts (Fast Cut, Smart Cut, Remove fillers/repeats,
  // manual word delete); silence + manual segment cuts have their own padding.
  // CLAMPED to half the gap to the neighbouring KEPT word: whisper timestamps on
  // tight speech ("and and and") leave almost no gap, and an unconditional 100ms
  // pad was eating the neighbours' audio (kept words played back clipped — "…d"
  // instead of "and", "chi…" instead of "chipotle"). Half-gap = the midpoint,
  // the neutral splice point under timestamp error; full 100ms still applies
  // wherever there is real room.
  const WORD_CUT_PAD = project.wordCutPad ?? 0.1
  const words = project.transcript?.words ?? []
  for (let i = 0; i < words.length; ) {
    if (words[i].deleted) {
      const start = words[i].start
      let end = words[i].end
      let j = i + 1
      while (j < words.length && words[j].deleted) {
        const w = words[j]
        // Stop on a backward jump or an implausibly large forward gap.
        if (w.end < start || w.start - end > BRIDGE_GAP) break
        end = Math.max(end, w.end)
        j++
      }
      const prevEnd = i > 0 ? words[i - 1].end : Number.NEGATIVE_INFINITY
      const nextStart = j < words.length ? words[j].start : Number.POSITIVE_INFINITY
      const padL = Math.min(WORD_CUT_PAD, Math.max(0, (start - prevEnd) / 2))
      const padR = Math.min(WORD_CUT_PAD, Math.max(0, (nextStart - end) / 2))
      cuts.push({ start: start - padL, end: end + padR })
      i = Math.max(j, i + 1)
    } else {
      i++
    }
  }

  const pad = Math.max(0, project.silencePadding ?? 0)
  // Retake β word-clamped silence carries protect:true — its [start,end] is
  // already safe (guarded off the transcript words), so it is applied VERBATIM
  // at the very end (after snap/absorb/bridge), never here. Normal silence
  // (FastCut/ProCut) is unaffected: it has no protect flag and flows as before.
  const protectedSilences = project.silences.filter((s) => s.protect && s.action === 'remove' && s.end - s.start > 0.02)
  for (const s of project.silences) {
    if (s.protect) continue
    if (s.action === 'remove') {
      const a = s.start + pad
      const b = s.end - pad
      if (b - a > 0.02) cuts.push({ start: a, end: b })
    } else if (s.action === 'shorten') {
      const keep = s.shortenTo ?? 0
      const excess = s.end - s.start - keep
      if (excess > 0.02) {
        const a = s.start + pad
        cuts.push({ start: a, end: a + excess })
      }
    }
  }

  // Snap ENGINE cut edges (word cuts + silence regions) to the nearest energy
  // valley (±120ms) and swallow orphaned stutter blips: the seam lands where
  // the audio is actually quiet instead of at an imprecise whisper timestamp.
  // MANUAL cuts (trim handles / split+delete) are added AFTER this block and
  // are never snapped — a user-dragged edge must follow the pointer exactly,
  // not fight it (snapping mid-drag made trim handles feel sticky/magnetic).
  if (waveform && cuts.length) {
    cuts.sort((a, b) => a.start - b.start)
    const auto: KeepRange[] = []
    for (const c of cuts) {
      const last = auto[auto.length - 1]
      if (last && c.start <= last.end) last.end = Math.max(last.end, c.end)
      else auto.push({ ...c })
    }
    for (const c of auto) {
      if (c.start > 0.05) c.start = Math.max(0, snapToValley(c.start, waveform))
      if (c.end < dur - 0.05) c.end = Math.min(dur, snapToValley(c.end, waveform))
      if (c.end <= c.start + 0.02) c.end = c.start + 0.02
    }
    // "Bu…But please": whisper often timestamps a cut-off attempt LATE, so a
    // short burst of it sits between real silence and the cut — outside the
    // snap window. A <=350ms burst backed by >=120ms of genuine silence just
    // outside a cut edge belongs to the cut — swallow it.
    absorbEdgeBlips(auto, waveform, dur, words)
    cuts.length = 0
    cuts.push(...auto)
  }

  // Manually deleted base ranges (split + delete segment / trim handles) — added
  // verbatim, never snapped: the user's edge is exactly where they dragged it.
  for (const c of project.manualCuts ?? []) cuts.push({ start: c.start, end: c.end })

  // Clamp every cut to [0, dur] and drop degenerate/out-of-range ones, so a
  // single bad timestamp can never wipe the whole timeline.
  const clamped = cuts
    .map((c) => ({ start: Math.max(0, Math.min(c.start, dur)), end: Math.max(0, Math.min(c.end, dur)) }))
    .filter((c) => c.end - c.start > 0.01)

  if (clamped.length === 0) return [{ start: 0, end: dur }]

  clamped.sort((a, b) => a.start - b.start)
  const merged: KeepRange[] = []
  for (const c of clamped) {
    const last = merged[merged.length - 1]
    if (last && c.start <= last.end) last.end = Math.max(last.end, c.end)
    else merged.push({ ...c })
  }

  const keeps: KeepRange[] = []
  let cursor = 0
  for (const c of merged) {
    if (c.start > cursor) keeps.push({ start: cursor, end: Math.min(c.start, dur) })
    cursor = Math.max(cursor, c.end)
  }
  if (cursor < dur) keeps.push({ start: cursor, end: dur })

  // Force-kept overrides win over cuts: union them into the keep set.
  const overrides = (project.keepOverrides ?? [])
    .map((o) => ({ start: Math.max(0, Math.min(o.start, dur)), end: Math.max(0, Math.min(o.end, dur)) }))
    .filter((o) => o.end - o.start > 0.01)
  const all = [...keeps, ...overrides].sort((a, b) => a.start - b.start)
  const out: KeepRange[] = []
  for (const k of all) {
    const last = out[out.length - 1]
    if (last && k.start <= last.end + 0.001) last.end = Math.max(last.end, k.end)
    else out.push({ ...k })
  }

  // Clean micro-fragments so cuts read smoothly: bridge cuts too short to be worth
  // making, then drop sub-word kept slivers left between adjacent cuts.
  const MIN_CUT = 0.12 // a gap (cut) shorter than this isn't worth cutting -> bridge it
  const MIN_KEEP = 0.2 // a kept sliver shorter than this is an artifact -> drop it
  // A kept ISLAND — kept audio with a cut on BOTH sides — under this length plays
  // as a stutter/jitter (a word cut + a nearby silence cut leaving a 0.3s scrap).
  // Absorb it into the surrounding cut. Edge keeps (clip start/end) are exempt.
  const MIN_ISLAND = 0.4
  const cleaned: KeepRange[] = []
  for (const k of out) {
    const last = cleaned[cleaned.length - 1]
    if (last && k.start - last.end < MIN_CUT) last.end = Math.max(last.end, k.end)
    else cleaned.push({ ...k })
  }
  const finalKeeps = cleaned.filter((k) => {
    const len = k.end - k.start
    if (len < MIN_KEEP) return false
    const island = k.start > 0.001 && k.end < dur - 0.001 // cut on BOTH sides
    // Never drop the only kept range (that would empty the timeline).
    if (island && len < MIN_ISLAND && cleaned.length > 1) return false
    return true
  })
  if (!protectedSilences.length) return finalKeeps
  // Retake β protected silence: subtract its EXACT [start,end] from the cleaned
  // keeps, last of all — never snapped, absorbed, bridged, or island-cleaned, so
  // the transcript-word guards on both sides are preserved to the frame.
  let protKeeps = finalKeeps
  for (const s of protectedSilences.sort((a, b) => a.start - b.start)) {
    const next: KeepRange[] = []
    for (const k of protKeeps) {
      if (s.end <= k.start || s.start >= k.end) { next.push(k); continue } // no overlap
      if (s.start > k.start) next.push({ start: k.start, end: s.start }) // left remainder
      if (s.end < k.end) next.push({ start: s.end, end: k.end }) // right remainder
    }
    protKeeps = next
  }
  return protKeeps.filter((k) => k.end - k.start > 0.001)
}

/** Total edited duration (sum of kept ranges). */
export function editedDuration(project: Project): number {
  return computeKeepRanges(project).reduce((s, k) => s + (k.end - k.start), 0)
}

// ---------------------------------------------------------------------------
// Multi-clip base (montage) — shared layout + keep-range helpers. Single source
// of truth for both the renderer and the ffmpeg export path. Single-clip mode
// (project.media, no baseSequence) is unaffected: computeBaseKeepRanges /
// baseTimelineDuration delegate to the frozen single-clip functions.
// ---------------------------------------------------------------------------

/** Keep-ranges (SOURCE seconds) for one sequence clip, within its trim, honoring
 *  its per-clip cleaning edits. MOVED VERBATIM from ffmpeg.ts (kept identical so
 *  montage export cut points do not shift). */
export function clipKeepRanges(c: SequenceClip): { start: number; end: number }[] {
  const inS = Math.max(0, c.sourceIn)
  const outS = Math.max(inS + 0.05, c.sourceOut)
  const hasEdits = !!(c.transcript || (c.silences && c.silences.length) || (c.manualCuts && c.manualCuts.length))
  if (!hasEdits) return [{ start: inS, end: outS }]
  const mini = {
    media: { path: c.sourcePath, duration: c.sourceDuration || outS, width: c.srcW, height: c.srcH, fps: c.fps, hasAudio: c.hasAudio, hasVideo: true },
    transcript: c.transcript,
    silences: c.silences ?? [],
    manualCuts: c.manualCuts ?? [],
    keepOverrides: c.keepOverrides ?? [],
    baseZooms: [],
    silencePadding: c.silencePadding ?? 0.08,
    tracks: []
  } as unknown as Project
  return computeKeepRanges(mini)
    .map((k) => ({ start: Math.max(k.start, inS), end: Math.min(k.end, outS) }))
    .filter((k) => k.end - k.start > 0.05)
}

export interface SeqLayoutItem {
  clip: SequenceClip
  /** timeline position (edited seconds) of this clip's start. */
  offset: number
  /** edited length of this clip (sum of its keep ranges) — matches export. */
  len: number
}

/** Lay the base sequence out on the timeline. Magnet ON => clips glued
 *  back-to-back by edited length. Magnet OFF => positioned by `laneStart`
 *  (overlaps resolved left-to-right). Order returned == export/preview order. */
export function sequenceLayout(project: Project): { items: SeqLayoutItem[]; total: number } {
  const clips = project.baseSequence ?? []
  const withLen = clips.map((clip) => ({
    clip,
    len: Math.max(0, clipKeepRanges(clip).reduce((s, k) => s + (k.end - k.start), 0))
  }))
  let items: SeqLayoutItem[]
  if (project.magnet) {
    let acc = 0
    items = withLen.map(({ clip, len }) => {
      const it = { clip, offset: acc, len }
      acc += len
      return it
    })
  } else {
    let acc = 0
    const seeded = withLen.map(({ clip, len }) => {
      const off = clip.laneStart ?? acc
      acc = Math.max(acc, off + len)
      return { clip, len, off: Math.max(0, off) }
    })
    seeded.sort((a, b) => a.off - b.off)
    items = seeded.map(({ clip, len, off }) => ({ clip, offset: off, len }))
  }
  const total = items.reduce((m, it) => Math.max(m, it.offset + it.len), 0)
  return { items, total }
}

/** Keep-ranges in TIMELINE seconds for the base. Single-clip => the frozen
 *  computeKeepRanges. Multi-clip => each clip's keeps collapsed (cuts removed)
 *  and laid at its timeline offset. */
export function computeBaseKeepRanges(project: Project): KeepRange[] {
  if (project.media && !(project.baseSequence?.length ?? 0)) return computeKeepRanges(project)
  const out: KeepRange[] = []
  for (const it of sequenceLayout(project).items) {
    let local = it.offset
    for (const k of clipKeepRanges(it.clip)) {
      const l = k.end - k.start
      if (l > 0.0005) out.push({ start: local, end: local + l })
      local += l
    }
  }
  return mergeRanges(out)
}

/** A base clip's span on the montage/virtual timeline (cumulative FULL lengths —
 *  the time domain the montage transcript/silences live in). */
export interface VirtualClipSpan {
  clip: SequenceClip
  vStart: number
  vEnd: number
}

/** Clips laid at cumulative FULL-length offsets (montage/virtual time). */
export function baseClipSpans(project: Project): VirtualClipSpan[] {
  const out: VirtualClipSpan[] = []
  let acc = 0
  for (const c of project.baseSequence ?? []) {
    const dur = Math.max(0.05, c.sourceOut - c.sourceIn)
    out.push({ clip: c, vStart: acc, vEnd: acc + dur })
    acc += dur
  }
  return out
}

/** Real base length: single-clip => media.duration; multi-clip => virtual total. */
export function baseTimelineDuration(project: Project): number {
  if (project.media && !(project.baseSequence?.length ?? 0)) return project.media.duration
  const spans = baseClipSpans(project)
  return spans.length ? spans[spans.length - 1].vEnd : 0
}

/** Montage/virtual time -> the owning clip + its source time. */
export function virtualToClip(project: Project, vt: number): { clip: SequenceClip; sourceTime: number } | null {
  const spans = baseClipSpans(project)
  if (!spans.length) return null
  const s = spans.find((x) => vt >= x.vStart && vt < x.vEnd) ?? spans[spans.length - 1]
  return { clip: s.clip, sourceTime: vt - s.vStart + s.clip.sourceIn }
}

/** Map montage keep ranges to concrete clip SOURCE segments (split at clip
 *  boundaries) for export/preview concatenation. */
export function virtualKeepsToClipSegments(
  project: Project,
  keeps: { start: number; end: number }[]
): { clipId: string; sourcePath: string; in: number; out: number; hasAudio: boolean; isImage?: boolean; srcW?: number; srcH?: number; vStart: number }[] {
  const spans = baseClipSpans(project)
  const segs: { clipId: string; sourcePath: string; in: number; out: number; hasAudio: boolean; isImage?: boolean; srcW?: number; srcH?: number; vStart: number }[] = []
  for (const k of keeps) {
    for (const s of spans) {
      const a = Math.max(k.start, s.vStart)
      const b = Math.min(k.end, s.vEnd)
      if (b - a > 0.02) {
        segs.push({
          // owning base clip id — lets the exporter map a kept segment back to its
          // SequenceClip for per-clip transform/speed/gain (a clip split by a cut
          // yields several segments that all share this id).
          clipId: s.clip.id,
          sourcePath: s.clip.sourcePath,
          in: a - s.vStart + s.clip.sourceIn,
          out: b - s.vStart + s.clip.sourceIn,
          hasAudio: s.clip.hasAudio,
          isImage: s.clip.isImage,
          srcW: s.clip.srcW,
          srcH: s.clip.srcH,
          // virtual-timeline position of this kept segment's start — the preview
          // keeps the playhead in VIRTUAL time so the transcript's word marker,
          // the Timeline playhead line and the video can never drift apart.
          vStart: a
        })
      }
    }
  }
  return segs
}

/**
 * Build ONE montage waveform in virtual (montage) time by stitching each clip's
 * source waveform slice ([sourceIn, sourceOut]) end-to-end at the cumulative
 * full-length offsets. Domain matches baseTimelineDuration + the montage cuts, so
 * the Timeline's WaveformCanvas ripples it against computeKeepRanges exactly like
 * the single-clip base. `sources` maps sourcePath -> that file's full waveform;
 * clips whose source hasn't loaded yet contribute flat (silent) peaks and fill in
 * on the next rebuild. Returns null until at least one source waveform is known.
 */
export function stitchMontageWaveform(
  project: Project,
  sources: Record<string, Waveform | undefined>
): Waveform | null {
  const spans = baseClipSpans(project)
  if (!spans.length) return null
  // Target resolution = the first available source's peaksPerSec (all files use
  // the same extractor, so this is uniform in practice); default 20 as a floor.
  let pps = 0
  for (const s of spans) {
    const w = sources[s.clip.sourcePath]
    if (w && w.peaksPerSec > 0) { pps = w.peaksPerSec; break }
  }
  if (!pps) return null
  const peaks: number[] = []
  for (const s of spans) {
    const n = Math.max(1, Math.round((s.vEnd - s.vStart) * pps))
    const w = sources[s.clip.sourcePath]
    for (let i = 0; i < n; i++) {
      if (w && w.peaks.length) {
        const srcT = s.clip.sourceIn + i / pps
        const idx = Math.min(w.peaks.length - 1, Math.max(0, Math.round(srcT * w.peaksPerSec)))
        peaks.push(w.peaks[idx] ?? 0)
      } else {
        peaks.push(0)
      }
    }
  }
  return { peaksPerSec: pps, peaks }
}

/** True when the base is a multi-clip sequence (not a single flattened video).
 *  The `&& !media` clause is load-bearing: editSequenceClip sets project.media
 *  while baseSequence stays non-empty, and that per-clip edit MUST route to the
 *  single-clip UI/pipeline. */
export function isMultiBase(project: Project): boolean {
  return (project.baseSequence?.length ?? 0) > 0 && !project.media
}

// ---------------------------------------------------------------------------
// Re-segmentation: after transcribing/silence-detecting the COMBINED montage
// audio, split the results back per clip so the clips stay separate. Clips are
// in COMBINE ORDER (baseSequence array order); each clip occupies a combined-time
// window [offset, offset+dur) where dur = sourceOut - sourceIn (trim produces an
// exact-length segment, so nominal == emitted). Words/regions are assigned to a
// clip by their MIDPOINT and rebased to clip-local SOURCE time.
// ---------------------------------------------------------------------------

interface ClipBound { id: string; sourceIn: number; sourceOut: number; cStart: number; cEnd: number }

function combineBounds(clips: SequenceClip[]): ClipBound[] {
  const out: ClipBound[] = []
  let acc = 0
  for (const c of clips) {
    const dur = Math.max(0.05, c.sourceOut - c.sourceIn)
    out.push({ id: c.id, sourceIn: c.sourceIn, sourceOut: c.sourceOut, cStart: acc, cEnd: acc + dur })
    acc += dur
  }
  return out
}

function ownerOf(bounds: ClipBound[], combinedMid: number): ClipBound | undefined {
  return bounds.find((b) => combinedMid >= b.cStart && combinedMid < b.cEnd) ?? bounds[bounds.length - 1]
}

/** Rebase a combined-time [s,e] to the owner clip's local SOURCE time, clamped. */
function rebase(b: ClipBound, s: number, e: number): { start: number; end: number } {
  const ls = Math.max(b.sourceIn, Math.min(b.sourceOut, s - b.cStart + b.sourceIn))
  const le = Math.max(b.sourceIn, Math.min(b.sourceOut, e - b.cStart + b.sourceIn))
  return { start: Math.min(ls, le), end: Math.max(ls, le) }
}

/** Split a whole-montage transcript back into a per-clip transcript map. */
export function splitTranscriptBySequence(transcript: Transcript, clips: SequenceClip[]): Map<string, Transcript> {
  const bounds = combineBounds(clips)
  const perWords = new Map<string, Word[]>()
  const perSegs = new Map<string, Segment[]>()
  for (const c of clips) { perWords.set(c.id, []); perSegs.set(c.id, []) }

  const place = (w: Word): { b: ClipBound; rw: Word } | null => {
    const b = ownerOf(bounds, (w.start + w.end) / 2)
    if (!b) return null
    const r = rebase(b, w.start, w.end)
    return { b, rw: { ...w, start: r.start, end: r.end } }
  }

  const segs = transcript.segments ?? []
  if (segs.length) {
    for (const seg of segs) {
      const groups = new Map<string, Word[]>()
      for (const w of seg.words) {
        const p = place(w)
        if (!p) continue
        perWords.get(p.b.id)!.push(p.rw)
        ;(groups.get(p.b.id) ?? groups.set(p.b.id, []).get(p.b.id)!).push(p.rw)
      }
      for (const [cid, ws] of groups) {
        if (ws.length) perSegs.get(cid)!.push({ id: `${seg.id}:${cid}`, start: ws[0].start, end: ws[ws.length - 1].end, words: ws })
      }
    }
  } else {
    // No segments (some backends): assign flat words, one segment per clip.
    for (const w of transcript.words ?? []) {
      const p = place(w)
      if (p) perWords.get(p.b.id)!.push(p.rw)
    }
    for (const c of clips) {
      const ws = perWords.get(c.id)!
      if (ws.length) perSegs.get(c.id)!.push({ id: `${c.id}-seg`, start: ws[0].start, end: ws[ws.length - 1].end, words: ws })
    }
  }

  const out = new Map<string, Transcript>()
  for (const c of clips) out.set(c.id, { segments: perSegs.get(c.id)!, words: perWords.get(c.id)! })
  return out
}

/** Split whole-montage silence regions back into a per-clip silences map. */
export function splitSilencesBySequence(regions: SilenceRegion[], clips: SequenceClip[]): Map<string, SilenceRegion[]> {
  const bounds = combineBounds(clips)
  const out = new Map<string, SilenceRegion[]>()
  for (const c of clips) out.set(c.id, [])
  for (const r of regions) {
    const b = ownerOf(bounds, (r.start + r.end) / 2)
    if (!b) continue
    const { start, end } = rebase(b, r.start, r.end)
    if (end - start > 0.02) out.get(b.id)!.push({ ...r, start, end })
  }
  return out
}

// ---- Ripple (magnet) layout: collapse a SUBSET of cuts (e.g. final-deletes) so
// the timeline lays kept footage out contiguously, CapCut-style. Pure + testable.

/** Merge overlapping/adjacent ranges, sorted by start. */
export function mergeRanges(ranges: { start: number; end: number }[]): KeepRange[] {
  const sorted = ranges.filter((r) => r.end - r.start > 0.0005).map((r) => ({ ...r })).sort((a, b) => a.start - b.start)
  const out: KeepRange[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end + 1e-6) last.end = Math.max(last.end, r.end)
    else out.push({ start: r.start, end: r.end })
  }
  return out
}

/** `base` ranges with `holes` removed (range subtraction). Both get merged. */
export function subtractRanges(
  base: { start: number; end: number }[],
  holes: { start: number; end: number }[]
): KeepRange[] {
  let segs = mergeRanges(base)
  for (const h of mergeRanges(holes)) {
    const next: KeepRange[] = []
    for (const s of segs) {
      if (h.end <= s.start || h.start >= s.end) {
        next.push(s)
        continue
      }
      if (h.start > s.start) next.push({ start: s.start, end: h.start })
      if (h.end < s.end) next.push({ start: h.end, end: s.end })
    }
    segs = next
  }
  return segs.filter((s) => s.end - s.start > 0.0005)
}

/** Source time → collapsed (ripple) time, removing `cuts` (will be merged). */
export function collapseTime(t: number, cuts: { start: number; end: number }[]): number {
  let removed = 0
  for (const c of mergeRanges(cuts)) {
    if (c.start >= t) break
    removed += Math.min(t, c.end) - c.start
  }
  return t - removed
}

/** Collapsed (ripple) time → source time. Inverse of collapseTime. */
export function expandTime(rt: number, cuts: { start: number; end: number }[], dur: number): number {
  let prev = 0
  let acc = 0
  for (const c of mergeRanges(cuts)) {
    const keptLen = c.start - prev
    if (rt <= acc + keptLen + 1e-9) return Math.max(0, Math.min(dur, prev + (rt - acc)))
    acc += keptLen
    prev = c.end
  }
  return Math.max(0, Math.min(dur, prev + (rt - acc)))
}

/** Map an edited-timeline time back to a source time (for preview seeking). */
export function editedToSource(project: Project, edited: number): number {
  let acc = 0
  for (const k of computeKeepRanges(project)) {
    const len = k.end - k.start
    if (edited <= acc + len) return k.start + (edited - acc)
    acc += len
  }
  return project.media?.duration ?? 0
}

/** Given a source time, is it inside a kept range? If not, return next kept source time. */
export function nextKeptSource(project: Project, source: number): number | null {
  for (const k of computeKeepRanges(project)) {
    if (source < k.start) return k.start
    if (source >= k.start && source < k.end) return source
  }
  return null
}
