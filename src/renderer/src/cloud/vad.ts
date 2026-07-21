// Cloud build — Silero VAD in the browser (replaces the native whisper-vad
// binary for the Retake β silence scans).
//
// @ricky0123/vad-web's NonRealTimeVAD runs the Silero "legacy" ONNX model over
// a Float32 buffer via onnxruntime-web (WASM) and yields SPEECH segments; we
// invert those to silence regions over [0, duration] with the SAME semantics
// the retake engine gets from src/main/ffmpeg.ts detectSilenceVad:
//   • vadThreshold  -> the model's positive speech-probability threshold
//                      (negative = threshold − 0.15, the Silero convention)
//   • speechPadMs   -> each speech segment extended by this on BOTH sides
//                      before inversion (whisper-vad's -vp), so silence
//                      shrinks away from speech and word edges never clip
//   • minDuration   -> only inverted gaps ≥ max(0.1, minDuration) count as
//                      silence (whisper-vad's -vsd / the Node post-filter)
//   • padBeforeMs / padAfterMs -> ASYMMETRIC guard: silence kept before a word's
//                      onset vs after its tail (each falls back to speechPadMs)
//   • edgeTrimMs    -> grow every silence region by this on both sides, clamp
//                      to the media and merge (eats into speech — tighter cuts)
//   • removeBreaths -> scan each speech segment's samples for runs quieter than
//                      breathDb (RMS energy gate — the browser twin of ffmpeg's
//                      breath scan) and remove them too. breathDb sets the gate.
// Output invariants match the Node path: regions sorted, non-overlapping,
// action 'remove', ≥ min gap. Min speech stays at whisper.cpp's 250ms default
// (the native binary never overrode it).

import { NonRealTimeVAD } from '@ricky0123/vad-web'
import type { SilenceRegion, SilenceDetectOptions } from '@shared/types'
import { vadSilenceToOpts, type VadSilenceSettings } from '@shared/vadsilence'
import { decodeAudioFloat32 } from './audio'

/** Where the VAD's static assets are served from (Vite public dir → site root). */
export const VAD_ASSET_BASE = '/vad/'

/** Files the build script must copy from node_modules into public/vad/ (kept
 *  flat — VAD_ASSET_BASE + basename). The .jsep pair is what the default
 *  onnxruntime-web bundle (`dist/ort.bundle.min.mjs`) actually fetches; the
 *  plain pair covers the extern-wasm resolution as a cheap safety net. */
export const VAD_ASSET_FILES = [
  '@ricky0123/vad-web/dist/silero_vad_legacy.onnx', // NonRealTimeVAD is hard-wired to the legacy model
  'onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs',
  'onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm',
  'onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
  'onnxruntime-web/dist/ort-wasm-simd-threaded.wasm'
] as const

// vad-web frames are 1536 samples at 16 kHz = 96ms. One redemption frame ends
// a speech segment on the first quiet frame; the reported end then overshoots
// real speech by that frame, which we subtract back out below.
const FRAME_MS = 96
const REDEMPTION_MS = FRAME_MS
const MIN_SPEECH_MS = 250 // whisper.cpp VAD default the native binary ran with

// The Silero model (~1.7MB) is fetched once per session, not once per scan
// (the retake engine runs the VAD up to twice per job: safety + hard-cut).
let modelPromise: Promise<ArrayBuffer> | null = null
function cachedModelFetcher(url: string): Promise<ArrayBuffer> {
  if (!modelPromise) {
    modelPromise = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`VAD model fetch failed: HTTP ${r.status} (${url})`)
      return r.arrayBuffer()
    })
    // a failed fetch must not poison every later scan
    modelPromise.catch(() => { modelPromise = null })
  }
  return modelPromise
}

function uuid(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `sil-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  }
}

/** Sort + merge overlapping/touching intervals (the Node mergeRemoveRegions). */
function mergeIntervals(list: { start: number; end: number }[]): { start: number; end: number }[] {
  const sorted = [...list].sort((a, b) => a.start - b.start)
  const out: { start: number; end: number }[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else out.push({ ...r })
  }
  return out
}

/** Run the Silero VAD over decoded samples and translate the speech map to the
 *  app's silence regions (semantics documented in the header). `durationS` is
 *  the media duration the trailing region should extend to. */
export async function detectSilenceFloat32(
  float32: Float32Array,
  sampleRate: number,
  opts: SilenceDetectOptions,
  durationS: number
): Promise<SilenceRegion[]> {
  // NOTE: 'fast' mode (ffmpeg dB threshold) has no browser twin — the retake
  // engine only ever asks for 'vad', which this IS. Run the VAD regardless.
  const thr = opts?.vadThreshold ?? 0.5
  const vad = await NonRealTimeVAD.new({
    modelURL: VAD_ASSET_BASE + 'silero_vad_legacy.onnx',
    modelFetcher: cachedModelFetcher,
    ortConfig: (ort) => {
      ort.env.wasm.wasmPaths = VAD_ASSET_BASE
    },
    positiveSpeechThreshold: thr,
    negativeSpeechThreshold: Math.max(0.01, thr - 0.15),
    redemptionMs: REDEMPTION_MS,
    preSpeechPadMs: 0, // padding is applied below, on BOTH sides (-vp semantics)
    minSpeechMs: MIN_SPEECH_MS,
    submitUserSpeechOnPause: false
  })

  // 1. raw SPEECH segments (vad-web reports ms)
  const speech: { start: number; end: number }[] = []
  for await (const seg of vad.run(float32, sampleRate)) {
    speech.push({ start: seg.start / 1000, end: seg.end / 1000 })
  }

  // 2. undo the redemption-frame overshoot (a segment that runs to the end of
  //    the audio was closed by EOF, not redemption — leave that one alone),
  //    then pad both sides by speechPadMs and merge.
  // ASYMMETRIC padding: keep padBeforeMs of silence before a word's onset and
  // padAfterMs after its tail (falls back to the old symmetric speechPadMs).
  const fallbackPad = (opts?.speechPadMs ?? 40) / 1000
  const padBefore = Math.max(0, opts?.padBeforeMs != null ? opts.padBeforeMs / 1000 : fallbackPad)
  const padAfter = Math.max(0, opts?.padAfterMs != null ? opts.padAfterMs / 1000 : fallbackPad)
  const redemption = REDEMPTION_MS / 1000
  const padded = mergeIntervals(
    speech.map((s) => {
      const end = s.end >= durationS - 0.15 ? s.end : Math.max(s.start, s.end - redemption)
      return { start: Math.max(0, s.start - padBefore), end: Math.min(durationS, end + padAfter) }
    })
  )

  // 3. invert SPEECH -> non-speech gaps over [0, duration] (same 0.02s epsilon
  //    as detectSilenceVad), keeping only gaps ≥ the min silence duration.
  //    Floor 0.03 (was 0.1): the old floor silently kept every pause under 100ms,
  //    which made a true "zero pause" setting impossible no matter the sliders.
  const minDur = Math.max(0.03, opts?.minDuration ?? 0.4)
  let regions: { start: number; end: number }[] = []
  let cursor = 0
  for (const s of padded) {
    if (s.start > cursor + 0.02) regions.push({ start: cursor, end: s.start })
    cursor = Math.max(cursor, s.end)
  }
  if (durationS > cursor + 0.02) regions.push({ start: cursor, end: durationS })
  regions = regions.filter((r) => r.end - r.start >= minDur)

  // 3b. removeBreaths: the VAD keeps breaths / quiet fillers as "speech". Scan
  //     each speech segment's own samples for runs quieter than breathDb (an RMS
  //     energy gate — the browser twin of ffmpeg's breath scan) and add any run
  //     ≥ minDur to the silence set. Word-clamping downstream (in the engine)
  //     protects real quiet words, so this only sweeps genuine dead/breath audio.
  if (opts?.removeBreaths) {
    const breathDb = opts?.breathDb ?? opts?.noiseDb ?? -30
    const frame = Math.max(160, Math.round(sampleRate * 0.02)) // ~20ms
    const rmsDbAt = (i0: number): number => {
      const n = Math.min(frame, float32.length - i0)
      let sum = 0
      for (let k = 0; k < n; k++) sum += float32[i0 + k] * float32[i0 + k]
      return 20 * Math.log10(Math.sqrt(sum / Math.max(1, n)) + 1e-9)
    }
    const breaths: { start: number; end: number }[] = []
    for (const seg of speech) {
      const i0 = Math.max(0, Math.floor(seg.start * sampleRate))
      const i1 = Math.min(float32.length, Math.ceil(seg.end * sampleRate))
      let runStart = -1
      for (let i = i0; i < i1; i += frame) {
        const quiet = rmsDbAt(i) < breathDb
        if (quiet && runStart < 0) runStart = i
        else if (!quiet && runStart >= 0) {
          const a = runStart / sampleRate
          const b = i / sampleRate
          if (b - a >= minDur) breaths.push({ start: a, end: b })
          runStart = -1
        }
      }
      if (runStart >= 0) {
        const a = runStart / sampleRate
        const b = i1 / sampleRate
        if (b - a >= minDur) breaths.push({ start: a, end: b })
      }
    }
    if (breaths.length) regions = mergeIntervals([...regions, ...breaths]).filter((r) => r.end - r.start >= minDur)
  }

  // 4. optionally eat an extra edgeTrimMs into the speech on BOTH sides of
  //    every cut for tighter, snappier cuts. Clamped to the media; merged.
  const edge = Math.max(0, (opts?.edgeTrimMs ?? 0) / 1000)
  if (edge > 0) {
    regions = mergeIntervals(
      regions.map((r) => ({ start: Math.max(0, r.start - edge), end: Math.min(durationS, r.end + edge) }))
    )
  }

  return regions.map((r) => ({ id: uuid(), start: r.start, end: r.end, action: 'remove' as const }))
}

/** Standalone convenience: decode a `webmedia:` id's audio and scan it. The
 *  retake engine does NOT use this (it feeds the already-decoded STT samples
 *  to detectSilenceFloat32 so words and silence share one clock). */
export async function detectSilenceCloud(mediaId: string, opts: SilenceDetectOptions): Promise<SilenceRegion[]> {
  const { float32, sampleRate, durationS } = await decodeAudioFloat32(mediaId)
  return detectSilenceFloat32(float32, sampleRate, opts, durationS)
}

/** The unified silence pass shared by cloud ProCut AND Retake β: run the raw VAD
 *  with the user's VadSilenceSettings, then CLAMP every region ~30ms off the KEPT
 *  words so a word the VAD under-detected can never be clipped (the safety the
 *  hybrid used to provide). Regions are protect:true / action:'remove' — staged as
 *  review chips exactly like before. keptWords = the transcript words NOT already
 *  removed by word cuts (their midpoints outside every cut span). */
export function clampSilenceRegions(
  raw: { start: number; end: number }[],
  keptWords: { start: number; end: number }[],
  idPrefix = 'vadsil',
  durationS = 0,
  // Silence kept next to a word when a cut edge would reach into it. Tied to the
  // creator's padding sliders (was a fixed 30ms): at 0 the cut lands exactly on the
  // word boundary → crisp jump cut with NO residual gap; higher keeps that lead-in
  // / trailing air. guardBeforeS guards the cut END (before the next word),
  // guardAfterS the cut START (after the previous word).
  guardBeforeS = 0.03,
  guardAfterS = 0.03,
  // trimEdges: also remove the LEADING silence before the first word and the
  // TRAILING silence after the last word (dead air at the very start/end). The
  // first/last word stays protected by the padding above. Default off preserves
  // the old "keep head + tail" behavior for any other caller.
  trimEdges = false,
  // A carved piece must STILL satisfy the creator's "cut pauses longer than X".
  // Word-carving a big raw region (breath sweep across a soft-spoken phrase) can
  // leave 50-110ms slivers BETWEEN words of fluent speech — each one a video
  // splice that shreds the phrase. Those are coarticulation gaps, not pauses.
  minPieceS = 0.05,
  // edgeGrowS: tighten each SURVIVING cut by up to this on both sides for snappier
  // pacing. Applied HERE — AFTER the word-carve + minPiece filter, and clamped so
  // growth can never enter or cross a protected (guarded) word. It must NOT run in
  // the raw VAD pass: there it grows every sub-minGap breath dip and MERGES the
  // dips of a soft, fluent passage into one big region, which — where STT
  // under-covers that soft speech — carved into multi-second cuts of real words.
  // Post-carve + clamped, a dip below minGap is already gone and can't be revived.
  edgeGrowS = 0
): SilenceRegion[] {
  // TRUE interval subtraction: carve every guarded word span out of every region.
  // The old two-condition edge-nudge only handled PARTIAL overlaps — a region that
  // fully CONTAINED a quiet word (VAD scored the whole word below threshold, or the
  // breath sweep swallowed it) matched neither condition and deleted the word. This
  // handles every case uniformly: partial overlap → trimmed; word inside region →
  // region SPLITS around it; region inside a word → dropped; several quiet words →
  // split around each. Kept transcript words can no longer be cut by silence.
  //
  // NOTE: an earlier revision tried trimming STT word-end slop here ("tail trim")
  // — reverted: STT/repaired word times are not reliable enough to cut against,
  // and the trim clipped real speech. Words are protected at their FULL spans.
  const guarded = [...keptWords]
    .map((w) => ({ start: w.start - guardBeforeS, end: w.end + guardAfterS }))
    .sort((x, y) => x.start - y.start)
  const subtractWords = (a: number, b: number): { start: number; end: number }[] => {
    const out: { start: number; end: number }[] = []
    let cursor = a
    for (const w of guarded) {
      if (w.end <= cursor) continue
      if (w.start >= b) break
      if (w.start > cursor) out.push({ start: cursor, end: w.start })
      cursor = Math.max(cursor, w.end)
    }
    if (cursor < b) out.push({ start: cursor, end: b })
    return out
  }
  const clampMin = Math.max(0.02, minPieceS)
  let pieces = raw
    // Head/tail: trimEdges removes the leading intro + trailing outro silence too;
    // otherwise keep them and only trim silence BETWEEN speech.
    .filter((r) => trimEdges || (r.start > 0.15 && !(durationS > 0 && r.end >= durationS - 0.15)))
    .flatMap((r) => subtractWords(r.start, r.end))
    // Every surviving piece must be a REAL pause by the creator's own threshold
    // (floor 0.02 keeps the zero-pause profile honest at its minGap of 0.05).
    .filter((r) => r.end - r.start > clampMin)

  // Snappier cuts: grow each surviving pause up to edgeGrowS on each side, but
  // NEVER past the neighboring guarded word — the growth is bounded by the words
  // that already bracket the piece, so it can only consume dead air, never speech.
  // (Sub-minGap dips were dropped above, so growth cannot resurrect them.)
  if (edgeGrowS > 0 && pieces.length) {
    const hiCap = durationS > 0 ? durationS : Infinity
    pieces = pieces.map((r) => {
      let lo = 0
      let hi = hiCap
      for (const w of guarded) {
        if (w.end <= r.start) lo = Math.max(lo, w.end)
        if (w.start >= r.end) { hi = Math.min(hi, w.start); break }
      }
      return { start: Math.max(r.start - edgeGrowS, lo), end: Math.min(r.end + edgeGrowS, hi) }
    })
  }

  return pieces.map((r, i) => ({ id: `${idPrefix}-${i}`, start: r.start, end: r.end, action: 'remove' as const, protect: true }))
}

export async function vadSilenceRegions(
  float32: Float32Array,
  sampleRate: number,
  durationS: number,
  settings: VadSilenceSettings,
  keptWords: { start: number; end: number }[],
  idPrefix = 'vadsil'
): Promise<SilenceRegion[]> {
  // edgeTrim is NOT applied in the raw VAD pass — it would grow+merge sub-minGap
  // breath dips before word protection can drop them (the multi-second-cut bug).
  // It is applied post-carve, word-clamped, inside clampSilenceRegions below.
  const rawOpts = { ...vadSilenceToOpts(settings), edgeTrimMs: 0 }
  const raw = await detectSilenceFloat32(float32, sampleRate, rawOpts, durationS)

  // NOISE-ISLAND BRIDGING. Camera thuds / phone-handling noise inside a pause make
  // Silero score "speech", so the VAD splits the pause into silence-NOISE-silence
  // and the noise stays in the edit. But if the stretch between two detected
  // silences contains NO transcript word, nobody is speaking — bridge across it so
  // the whole pause (noise included) is one cuttable region. Boundaries stay pure
  // AUDIO (VAD onsets); STT times are never used to place a cut edge — an earlier
  // revision synthesized regions from transcript word gaps and clipped real speech
  // where the STT/repaired times were off (reverted).
  const MAX_ISLAND_S = 5 // a "speech" island longer than this is too risky to assume is noise
  const bridgeWordlessIslands = (list: { start: number; end: number }[]): { start: number; end: number }[] => {
    const out: { start: number; end: number }[] = []
    for (const r of mergeIntervals(list)) {
      const prev = out[out.length - 1]
      if (prev) {
        const a = prev.end
        const b = r.start
        const wordless = !keptWords.some((w) => w.start < b && w.end > a)
        if (wordless && b - a > 0 && b - a <= MAX_ISLAND_S) {
          prev.end = r.end // swallow the noise island + the following silence
          continue
        }
      }
      out.push({ ...r })
    }
    return out
  }
  let bridged = bridgeWordlessIslands(raw)

  // STUBBORN-NOISE SECOND OPINION. Sustained handling/camera noise can make the VAD
  // score an ENTIRE pause as "speech" — zero silence inside it, so island bridging
  // has nothing to bridge and the noise survives whole (found in a real clip: a
  // 2.3s pause fully classified as speech). For a wordless transcript gap that the
  // VAD left mostly uncovered, re-run the VAD on JUST that span at a STRICTER
  // threshold: real speech scores ~0.9+, transient noise ~0.5-0.8, so the strict
  // pass sees through the noise. Cut edges still come from AUDIO onsets — the
  // strict regions are clipped to the gap, and the word-carve + minGap filter
  // below still bound everything. STT times gate WHERE we look, never where we cut.
  const ws = [...keptWords].sort((a, b) => a.start - b.start)
  const extra: { start: number; end: number }[] = []
  for (let i = 1; i < ws.length; i++) {
    const g0 = ws[i - 1].end
    const g1 = ws[i].start
    const len = g1 - g0
    if (len < Math.max(0.5, settings.minGapS)) continue
    const covered = bridged.reduce((n, r) => n + Math.max(0, Math.min(r.end, g1) - Math.max(r.start, g0)), 0)
    if (covered / len >= 0.5) continue // the VAD already found this pause; nothing stubborn here
    const margin = 0.5 // context so the strict pass sees the neighboring speech onsets
    const i0 = Math.max(0, Math.floor((g0 - margin) * sampleRate))
    const i1 = Math.min(float32.length, Math.ceil((g1 + margin) * sampleRate))
    if (i1 - i0 < sampleRate * 0.2) continue
    try {
      const strictOpts = {
        ...vadSilenceToOpts(settings),
        edgeTrimMs: 0, // same reason as the main pass — no grow before word-carve
        vadThreshold: Math.min(0.95, settings.speechThreshold + 0.15)
      }
      const sliceDur = (i1 - i0) / sampleRate
      const sub = await detectSilenceFloat32(float32.subarray(i0, i1), sampleRate, strictOpts, sliceDur)
      for (const r of sub) {
        const s = Math.max(g0, r.start + i0 / sampleRate)
        const e = Math.min(g1, r.end + i0 / sampleRate)
        if (e - s >= Math.max(0.05, settings.minGapS)) extra.push({ start: s, end: e })
      }
    } catch {
      /* the strict pass is best-effort — a failure just leaves this gap as-is */
    }
  }
  if (extra.length) bridged = bridgeWordlessIslands([...bridged, ...extra])

  // Word-guard tied to the padding sliders (0 → crisp gapless cut), trim the
  // leading/trailing dead air of the whole clip, and require every carved piece to
  // still be a pause the creator asked to cut (>= their minGap).
  return clampSilenceRegions(bridged, keptWords, idPrefix, durationS, settings.padBeforeS, settings.padAfterS, true, settings.minGapS, settings.edgeTrimS)
}
