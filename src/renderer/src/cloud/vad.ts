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
  const minDur = Math.max(0.1, opts?.minDuration ?? 0.4)
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
  idPrefix = 'vadsil'
): SilenceRegion[] {
  const clamp = (a: number, b: number): { start: number; end: number } => {
    let cs = a
    let ce = b
    for (const w of keptWords) {
      if (cs <= w.start && ce > w.start + 0.002 && ce < w.end) ce = Math.max(cs, w.start - 0.03) // cut end reaches into a word → stop before it
      if (ce >= w.end && cs < w.end - 0.002 && cs > w.start) cs = Math.min(ce, w.end + 0.03) // cut start reaches into a word → start after it
    }
    return { start: cs, end: ce }
  }
  return raw
    .map((r) => clamp(r.start, r.end))
    .filter((r) => r.end - r.start > 0.05)
    .map((r, i) => ({ id: `${idPrefix}-${i}`, start: r.start, end: r.end, action: 'remove' as const, protect: true }))
}

export async function vadSilenceRegions(
  float32: Float32Array,
  sampleRate: number,
  durationS: number,
  settings: VadSilenceSettings,
  keptWords: { start: number; end: number }[],
  idPrefix = 'vadsil'
): Promise<SilenceRegion[]> {
  const raw = await detectSilenceFloat32(float32, sampleRate, vadSilenceToOpts(settings), durationS)
  return clampSilenceRegions(raw, keptWords, idPrefix)
}
