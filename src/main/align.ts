/**
 * Word-sequence alignment for the "premium merge" transcription backend.
 *
 * gpt-4o-transcribe gives the cleanest TEXT but no word timestamps.
 * whisper-1 gives word-level TIMESTAMPS but is more prone to errors/hallucinations.
 *
 * We align gpt-4o's clean word stream onto whisper's timed word stream so the
 * final transcript has gpt-4o's words with whisper's timing:
 *   - matched word   -> gpt-4o text  + whisper timing
 *   - gpt-4o-only word (whisper missed it) -> interpolate timing from neighbours
 *   - whisper-only word (gpt-4o cleaned it out / whisper hallucinated) -> dropped
 *
 * Pure + dependency-free so it can be unit-tested without any API calls
 * (see scripts/verify-align.ts).
 */

export interface TimedTok {
  text: string
  start: number
  end: number
}

export interface AlignedWord {
  text: string
  start: number
  end: number
}

/** Lowercased, punctuation-stripped form used only for matching. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9']/g, '')
}

type Op =
  | { kind: 'match'; ci: number; ti: number }
  | { kind: 'ins'; ci: number } // clean word with no timed counterpart
  | { kind: 'del'; ti: number } // timed word with no clean counterpart

/**
 * Needleman-Wunsch global alignment of two token sequences (by normalized form).
 * Returns the edit operations in forward order.
 *
 * Chunks fed to this are <=10 min of audio (~2k words) so full DP is cheap.
 * For an unexpectedly huge pair we fall back to a positional zip.
 */
function nwAlign(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  if (n === 0) return b.map((_, ti) => ({ kind: 'del', ti }) as Op)
  if (m === 0) return a.map((_, ci) => ({ kind: 'ins', ci }) as Op)

  // Safety valve: avoid a pathological allocation if a chunk is somehow enormous.
  if (n * m > 40_000_000) return zipAlign(a, b)

  const MATCH = 2
  const MISMATCH = -1
  const GAP = -1

  const an = a.map(norm)
  const bn = b.map(norm)

  // dp[i][j] over (n+1) x (m+1); ptr stores the chosen move (0=diag,1=up(ins),2=left(del)).
  const width = m + 1
  const dp = new Float64Array((n + 1) * width)
  const ptr = new Int8Array((n + 1) * width)

  for (let j = 1; j <= m; j++) {
    dp[j] = j * GAP
    ptr[j] = 2
  }
  for (let i = 1; i <= n; i++) {
    dp[i * width] = i * GAP
    ptr[i * width] = 1
  }

  for (let i = 1; i <= n; i++) {
    const ai = an[i - 1]
    const rowBase = i * width
    const prevBase = (i - 1) * width
    for (let j = 1; j <= m; j++) {
      const same = ai !== '' && ai === bn[j - 1]
      const diag = dp[prevBase + j - 1] + (same ? MATCH : MISMATCH)
      const up = dp[prevBase + j] + GAP // consume a (clean) -> insertion
      const left = dp[rowBase + j - 1] + GAP // consume b (timed) -> deletion
      let best = diag
      let move: 0 | 1 | 2 = 0
      if (up > best) {
        best = up
        move = 1
      }
      if (left > best) {
        best = left
        move = 2
      }
      dp[rowBase + j] = best
      ptr[rowBase + j] = move
    }
  }

  // Backtrace.
  const ops: Op[] = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && ptr[i * width + j] === 0) {
      ops.push({ kind: 'match', ci: i - 1, ti: j - 1 })
      i--
      j--
    } else if (i > 0 && (j === 0 || ptr[i * width + j] === 1)) {
      ops.push({ kind: 'ins', ci: i - 1 })
      i--
    } else {
      ops.push({ kind: 'del', ti: j - 1 })
      j--
    }
  }
  ops.reverse()
  return ops
}

/** Degenerate fallback: pair words positionally; pad the shorter side with gaps. */
function zipAlign(a: string[], b: string[]): Op[] {
  const ops: Op[] = []
  const k = Math.min(a.length, b.length)
  for (let x = 0; x < k; x++) ops.push({ kind: 'match', ci: x, ti: x })
  for (let x = k; x < a.length; x++) ops.push({ kind: 'ins', ci: x })
  for (let x = k; x < b.length; x++) ops.push({ kind: 'del', ti: x })
  return ops
}

/**
 * Align clean (untimed) words onto timed words and produce timed clean words.
 * `offset` is added to every timestamp (used when a chunk starts mid-file).
 */
export function alignWords(clean: string[], timed: TimedTok[], offset = 0): AlignedWord[] {
  const ops = nwAlign(clean, timed.map((t) => t.text))
  const out: AlignedWord[] = []
  let pending: string[] = [] // clean words awaiting interpolated timing
  let lastEnd = offset

  const flush = (nextStart: number | null): void => {
    if (pending.length === 0) return
    const startT = lastEnd
    const endT =
      nextStart != null && nextStart > startT ? nextStart : startT + 0.2 * pending.length
    const span = (endT - startT) / pending.length
    pending.forEach((w, k) => {
      const s = startT + k * span
      out.push({ text: w, start: s, end: s + Math.max(span, 0.04) })
    })
    lastEnd = endT
    pending = []
  }

  for (const op of ops) {
    if (op.kind === 'match') {
      const t = timed[op.ti]
      const s = Math.max(0, t.start + offset)
      let e = t.end + offset
      if (!(e > s)) e = s + 0.12
      flush(s)
      out.push({ text: clean[op.ci], start: s, end: e })
      lastEnd = e
    } else if (op.kind === 'ins') {
      pending.push(clean[op.ci])
    } else {
      // timed-only: dropped, but advance the clock so later words interpolate right.
      const e = timed[op.ti].end + offset
      if (e > lastEnd) lastEnd = e
    }
  }
  flush(null)
  return out
}
