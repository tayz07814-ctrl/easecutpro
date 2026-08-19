// Silero VAD for Silence Mastery — STAGE 1 of the hybrid cleaner.
//
// The neural VAD listens to the actual audio and reports SPEECH segments; we
// invert those to non-speech regions. It runs FIRST: whatever it hears as
// silence is cut, and the transcript-gap pass then sweeps only what Silero
// left behind. The regions come out RAW at Silero's own speech edges — the
// Silence settings' pads/trims (padTrimRegions) shape them afterwards, so the
// presets fully control how flush or aggressive the cuts land.
//
// Slimmed from the pre-teardown cloud/vad.ts: same model, same asset layout
// (prepare-cloud-assets stages /vad/ — the Silero ONNX + onnxruntime WASM),
// same redemption-frame correction; the old settings machinery is gone.

import { IS_WEB } from '../platform'

// vad-web pulls the whole onnxruntime-web JS in with it. Imported statically it
// landed in the STARTUP chunk, so every launch parsed and evaluated a neural VAD
// that only runs when someone asks to clean silence — pure cost on a weak CPU,
// paid before the first frame. Loaded on demand instead, once per session.
type VadModule = typeof import('@ricky0123/vad-web')
let vadModule: Promise<VadModule> | null = null
function loadVad(): Promise<VadModule> {
  if (!vadModule) {
    vadModule = import('@ricky0123/vad-web').catch((e) => {
      vadModule = null // a failed fetch must not poison later attempts
      throw e
    })
  }
  return vadModule
}

// Web builds serve the staged assets same-origin at /vad/. The Electron
// desktop hybrid loads via file://, where fetch() of sibling files is blocked
// — its copy of the same assets is served by the ecvad:// protocol (main
// process, src/main/index.ts).
const VAD_ASSET_BASE = IS_WEB ? '/vad/' : 'ecvad://assets/'
// vad-web frames are 1536 samples at 16 kHz = 96ms. One redemption frame ends
// a speech segment on the first quiet frame; the reported end overshoots real
// speech by that frame, which we subtract back out below.
const FRAME_MS = 96
const REDEMPTION_S = FRAME_MS / 1000
const MIN_SPEECH_MS = 250
// 0.55: raised from 0.5 because breaths right after a sentence scored ~0.5-0.65
// and were counted as SPEECH (leaving breath tails at every cut edge) — but the
// first attempt at 0.7 OVERCUT, clipping soft real speech. 0.55 keeps quiet
// speech in while the RMS edge-refinement pass (refineRegionEdgesByRms, on the
// Flash/Cut Throat presets) adaptively swallows the breath tails the VAD keeps.
const SPEECH_THRESHOLD = 0.55
/** No built-in padding: the Silence settings' pad/trim values own the cut
 *  edges (padTrimRegions shapes the raw regions after detection). */
const SPEECH_PAD_S = 0

// The Silero model (~1.7MB) is fetched once per session, not once per scan.
let modelPromise: Promise<ArrayBuffer> | null = null
function cachedModelFetcher(url: string): Promise<ArrayBuffer> {
  if (!modelPromise) {
    modelPromise = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`VAD model fetch failed: HTTP ${r.status} (${url})`)
      return r.arrayBuffer()
    })
    modelPromise.catch(() => {
      modelPromise = null // a failed fetch must not poison every later scan
    })
  }
  return modelPromise
}

/** Run Silero over decoded samples; return its non-speech regions ≥ minSilenceS
 *  (sorted, non-overlapping, padded 100ms away from every detected speech
 *  segment). Throws when the model/WASM can't load — the caller degrades to
 *  the transcript pass alone. */
export async function detectSileroSilences(
  float32: Float32Array,
  sampleRate: number,
  durationS: number,
  minSilenceS: number
): Promise<{ start: number; end: number }[]> {
  const { NonRealTimeVAD } = await loadVad()
  const vad = await NonRealTimeVAD.new({
    modelURL: VAD_ASSET_BASE + 'silero_vad_legacy.onnx',
    modelFetcher: cachedModelFetcher,
    ortConfig: (ort) => {
      ort.env.wasm.wasmPaths = VAD_ASSET_BASE
    },
    positiveSpeechThreshold: SPEECH_THRESHOLD,
    negativeSpeechThreshold: SPEECH_THRESHOLD - 0.15,
    redemptionMs: FRAME_MS,
    preSpeechPadMs: 0, // padding applied below, on both sides
    minSpeechMs: MIN_SPEECH_MS,
    submitUserSpeechOnPause: false
  })

  // 1. raw SPEECH segments (vad-web reports ms)
  // +20 dB gain preprocessing (matches Android native pipeline)
  const gain = Math.pow(10, 20 / 20)
  const boosted = new Float32Array(float32.length)
  for (let i = 0; i < float32.length; i++) {
    boosted[i] = Math.max(-1, Math.min(1, float32[i] * gain))
  }
  const speech: { start: number; end: number }[] = []
  for await (const seg of vad.run(boosted, sampleRate)) {
    speech.push({ start: seg.start / 1000, end: seg.end / 1000 })
  }

  // 2. undo the redemption-frame overshoot (a segment that runs to the end of
  //    the audio was closed by EOF, not redemption — leave that one alone),
  //    pad both sides, merge overlaps.
  const padded: { start: number; end: number }[] = []
  for (const s of [...speech].sort((a, b) => a.start - b.start)) {
    const end = s.end >= durationS - 0.15 ? s.end : Math.max(s.start, s.end - REDEMPTION_S)
    const seg = { start: Math.max(0, s.start - SPEECH_PAD_S), end: Math.min(durationS, end + SPEECH_PAD_S) }
    const last = padded[padded.length - 1]
    if (last && seg.start <= last.end) last.end = Math.max(last.end, seg.end)
    else padded.push(seg)
  }

  // 3. invert SPEECH -> non-speech over [0, duration]; keep runs ≥ minSilenceS.
  const minDur = Math.max(0.03, minSilenceS)
  const regions: { start: number; end: number }[] = []
  let cursor = 0
  for (const s of padded) {
    if (s.start > cursor + 0.02) regions.push({ start: cursor, end: s.start })
    cursor = Math.max(cursor, s.end)
  }
  if (durationS > cursor + 0.02) regions.push({ start: cursor, end: durationS })
  return regions.filter((r) => r.end - r.start >= minDur)
}
