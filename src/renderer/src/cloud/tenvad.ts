// ten-vad (sherpa-onnx WASM) speech-segment engine — an OPT-IN alternate to the
// default Silero VAD (see vad.ts `vadEngine`). Everything downstream in vad.ts
// (padding / inversion / breath sweep / edge-trim / word-clamp) is engine-
// agnostic, so this only has to return the raw SPEECH segments in SECONDS.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ NEEDS BROWSER VERIFICATION before it replaces Silero as the default.
// The audio math below (16k resample → windowed acceptWaveform → drain) is
// straightforward and unit-reasoned, but the sherpa-onnx WASM *module loading*
// and the exact `createVad` / drain method names come from sherpa's prebuilt
// glue and can shift between sherpa-onnx releases. Load a real clip in the
// browser with `localStorage.ec:vadEngine = 'tenvad'`, watch the console, and
// adjust the marked spots if the glue's API differs from this build's.
// ─────────────────────────────────────────────────────────────────────────────
//
// ASSETS (place under public/vad/sherpa/ — served at VAD_ASSET_BASE + 'sherpa/'):
//   • sherpa-onnx-wasm-main-vad.js    ← Emscripten glue (defines Module factory)
//   • sherpa-onnx-wasm-main-vad.wasm
//   • sherpa-onnx-wasm-main-vad.data  (if the build ships one)
//   • sherpa-onnx-vad.js              ← JS wrapper that defines createVad()/Vad
//   • ten-vad.onnx                    ← the ten-vad model
// Grab them from a sherpa-onnx release's `wasm/vad` build (k2-fsa/sherpa-onnx),
// and the model from the ten-vad export sherpa hosts. Then add them to a copy
// step (mirror how VAD_ASSET_FILES is copied for Silero) — do NOT commit the
// multi-MB binaries into git.

import { VAD_ASSET_BASE } from './vad'

const SHERPA_BASE = VAD_ASSET_BASE + 'sherpa/'
const TEN_VAD_MODEL = SHERPA_BASE + 'ten-vad.onnx'
const WINDOW = 256 // ten-vad window size (samples @ 16 kHz)
const TARGET_SR = 16000

// sherpa's Emscripten glue is not an ES module — it attaches a Module factory +
// the createVad()/Vad wrapper to the global scope. We load it once via a <script>
// tag and read those globals. Types are intentionally loose (the glue is untyped).
/* eslint-disable @typescript-eslint/no-explicit-any */
type SherpaModule = any
type SherpaVad = any

let modulePromise: Promise<SherpaModule> | null = null

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-sherpa="${src}"]`)
    if (existing) return resolve()
    const el = document.createElement('script')
    el.src = src
    el.async = true
    el.dataset.sherpa = src
    el.onload = () => resolve()
    el.onerror = () => reject(new Error(`ten-vad: failed to load ${src}`))
    document.head.appendChild(el)
  })
}

/** Load the sherpa-onnx WASM runtime once and resolve when it's initialised. */
async function loadSherpa(): Promise<SherpaModule> {
  if (modulePromise) return modulePromise
  modulePromise = (async () => {
    const g = globalThis as any
    // The wrapper (createVad/Vad) must be present before the glue calls it.
    await injectScript(SHERPA_BASE + 'sherpa-onnx-vad.js')
    // Point the Emscripten runtime at our asset dir so it fetches the .wasm/.data
    // from public/vad/sherpa/ rather than the document root.
    g.Module = g.Module || {}
    g.Module.locateFile = (path: string) => SHERPA_BASE + path
    await injectScript(SHERPA_BASE + 'sherpa-onnx-wasm-main-vad.js')
    const Module: SherpaModule = g.Module
    if (typeof Module.then === 'function') return await Module // some builds export a Promise
    if (Module.calledRun) return Module
    await new Promise<void>((resolve) => {
      const prev = Module.onRuntimeInitialized
      Module.onRuntimeInitialized = () => {
        prev?.()
        resolve()
      }
    })
    return Module
  })()
  modulePromise.catch(() => {
    modulePromise = null
  }) // a failed load must not poison later scans
  return modulePromise
}

/** Downmix/keep mono and linear-resample to 16 kHz (ten-vad requires 16k). */
function toMono16k(float32: Float32Array, sampleRate: number): Float32Array {
  if (sampleRate === TARGET_SR) return float32
  const ratio = TARGET_SR / sampleRate
  const outLen = Math.max(1, Math.round(float32.length * ratio))
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio
    const i0 = Math.floor(srcPos)
    const i1 = Math.min(float32.length - 1, i0 + 1)
    const frac = srcPos - i0
    out[i] = float32[i0] * (1 - frac) + float32[i1] * frac
  }
  return out
}

/**
 * Raw SPEECH segments (seconds) from ten-vad. Same output contract as
 * vad.ts `sileroSpeechSegments`: [{ start, end }] in seconds, on the ORIGINAL
 * clip's clock (we resample internally but map times back).
 */
export async function tenVadSpeechSegments(
  float32: Float32Array,
  sampleRate: number,
  thr: number
): Promise<{ start: number; end: number }[]> {
  const Module = await loadSherpa()
  const g = globalThis as any
  if (typeof g.createVad !== 'function') {
    throw new Error('ten-vad: sherpa createVad() not found — check sherpa-onnx-vad.js loaded')
  }

  const samples16k = toMono16k(float32, sampleRate)
  const vad: SherpaVad = g.createVad(Module, {
    tenVad: {
      model: TEN_VAD_MODEL,
      threshold: thr,
      minSilenceDuration: 0.1, // pad/merge is done downstream — keep the raw VAD tight
      minSpeechDuration: 0.25,
      windowSize: WINDOW,
      maxSpeechDuration: 60
    },
    sampleRate: TARGET_SR,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
    bufferSizeInSeconds: 60
  })

  const out: { start: number; end: number }[] = []
  const push = (startSample: number, lenSamples: number): void => {
    const s = startSample / TARGET_SR
    const e = (startSample + lenSamples) / TARGET_SR
    if (e > s) out.push({ start: s, end: e })
  }

  try {
    // Feed the whole clip window-by-window, draining completed segments as they
    // appear so long clips don't blow the WASM buffer.
    for (let i = 0; i < samples16k.length; i += WINDOW) {
      vad.acceptWaveform(samples16k.subarray(i, Math.min(samples16k.length, i + WINDOW)))
      while (!vad.isEmpty()) {
        const seg = vad.front() // { samples: Float32Array, start: int32 (sample offset) }
        push(seg.start, seg.samples.length)
        vad.pop()
      }
    }
    vad.flush?.()
    while (!vad.isEmpty()) {
      const seg = vad.front()
      push(seg.start, seg.samples.length)
      vad.pop()
    }
  } finally {
    vad.free?.()
  }
  return out.sort((a, b) => a.start - b.start)
}
