// FunASR FSMN-VAD browser runtime for Retake Final Boss.
//
// Model: funasr/fsmn-vad-onnx (quantized ONNX, Apache-2.0). The network does
// not consume PCM directly: it expects Kaldi-compatible 80-bin fbank features,
// five-frame LFR splicing, CMVN, and four FSMN caches. This file implements that
// contract locally with onnxruntime-web; no audio or features leave the browser.

import * as ort from 'onnxruntime-web'

const ASSET_BASE = '/vad/'
const MODEL_URL = ASSET_BASE + 'fsmn-vad-quant.onnx'
const CMVN_URL = ASSET_BASE + 'fsmn-vad.mvn'
const TARGET_RATE = 16_000
const FRAME_LENGTH = 400 // 25 ms
const FRAME_SHIFT = 160 // 10 ms
const FFT_SIZE = 512
const MEL_BINS = 80
const LFR_M = 5
const FEATURE_DIM = MEL_BINS * LFR_M
const CACHE_LAYERS = 4
const CACHE_PROJ = 128
const CACHE_ORDER = 19
const MAX_CHUNK_FRAMES = 6000

let runtimePromise: Promise<{ session: ort.InferenceSession; means: Float32Array; scales: Float32Array }> | null = null
let melBank: Float32Array[] | null = null

function parseCmvn(text: string): { means: Float32Array; scales: Float32Array } {
  const vectorAfter = (tag: string): Float32Array => {
    const at = text.indexOf(tag)
    const learn = text.indexOf('<LearnRateCoef>', at)
    const open = text.indexOf('[', learn)
    const close = text.indexOf(']', open)
    if (at < 0 || learn < 0 || open < 0 || close < 0) throw new Error(`FSMN CMVN is missing ${tag}`)
    return Float32Array.from(text.slice(open + 1, close).trim().split(/\s+/).map(Number))
  }
  const means = vectorAfter('<AddShift>')
  const scales = vectorAfter('<Rescale>')
  if (means.length < FEATURE_DIM || scales.length < FEATURE_DIM) throw new Error('FSMN CMVN has the wrong feature dimension')
  return { means: means.slice(0, FEATURE_DIM), scales: scales.slice(0, FEATURE_DIM) }
}

async function runtime(): Promise<{ session: ort.InferenceSession; means: Float32Array; scales: Float32Array }> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      if (typeof window !== 'undefined') ort.env.wasm.wasmPaths = ASSET_BASE
      const [modelResponse, cmvnResponse] = await Promise.all([fetch(MODEL_URL), fetch(CMVN_URL)])
      if (!modelResponse.ok) throw new Error(`FSMN model failed to load (${modelResponse.status})`)
      if (!cmvnResponse.ok) throw new Error(`FSMN CMVN failed to load (${cmvnResponse.status})`)
      const [model, cmvn] = await Promise.all([modelResponse.arrayBuffer(), cmvnResponse.text()])
      const session = await ort.InferenceSession.create(model, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      })
      return { session, ...parseCmvn(cmvn) }
    })()
    runtimePromise.catch(() => { runtimePromise = null })
  }
  return runtimePromise
}

function resampleMono(input: Float32Array, sourceRate: number): Float32Array {
  if (sourceRate === TARGET_RATE) return input
  const length = Math.max(1, Math.round(input.length * TARGET_RATE / sourceRate))
  const out = new Float32Array(length)
  const ratio = sourceRate / TARGET_RATE
  for (let i = 0; i < length; i++) {
    const position = i * ratio
    const left = Math.min(input.length - 1, Math.floor(position))
    const right = Math.min(input.length - 1, left + 1)
    const mix = position - left
    out[i] = input[left] * (1 - mix) + input[right] * mix
  }
  return out
}

function fftPower(frame: Float32Array): Float32Array {
  const real = new Float32Array(FFT_SIZE)
  const imag = new Float32Array(FFT_SIZE)
  let mean = 0
  for (let i = 0; i < FRAME_LENGTH; i++) mean += frame[i]
  mean /= FRAME_LENGTH
  let previous = frame[0] - mean
  for (let i = 0; i < FRAME_LENGTH; i++) {
    const current = frame[i] - mean
    const emphasized = i === 0 ? current * 0.03 : current - 0.97 * previous
    previous = current
    const hamming = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (FRAME_LENGTH - 1))
    real[i] = emphasized * hamming * 32768
  }

  // In-place radix-2 Cooley-Tukey FFT.
  for (let i = 1, j = 0; i < FFT_SIZE; i++) {
    let bit = FFT_SIZE >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[real[i], real[j]] = [real[j], real[i]]
      ;[imag[i], imag[j]] = [imag[j], imag[i]]
    }
  }
  for (let length = 2; length <= FFT_SIZE; length <<= 1) {
    const angle = -2 * Math.PI / length
    const wLenR = Math.cos(angle)
    const wLenI = Math.sin(angle)
    for (let base = 0; base < FFT_SIZE; base += length) {
      let wr = 1
      let wi = 0
      for (let j = 0; j < length / 2; j++) {
        const even = base + j
        const odd = even + length / 2
        const tr = real[odd] * wr - imag[odd] * wi
        const ti = real[odd] * wi + imag[odd] * wr
        real[odd] = real[even] - tr
        imag[odd] = imag[even] - ti
        real[even] += tr
        imag[even] += ti
        const nextWr = wr * wLenR - wi * wLenI
        wi = wr * wLenI + wi * wLenR
        wr = nextWr
      }
    }
  }
  const power = new Float32Array(FFT_SIZE / 2 + 1)
  for (let i = 0; i < power.length; i++) power[i] = real[i] * real[i] + imag[i] * imag[i]
  return power
}

function melFilters(): Float32Array[] {
  if (melBank) return melBank
  const bins = FFT_SIZE / 2 + 1
  const hzToMel = (hz: number): number => 1127 * Math.log(1 + hz / 700)
  const melToHz = (mel: number): number => 700 * (Math.exp(mel / 1127) - 1)
  const lowMel = hzToMel(20)
  const highMel = hzToMel(TARGET_RATE / 2)
  const centers = Array.from({ length: MEL_BINS + 2 }, (_, i) =>
    melToHz(lowMel + (highMel - lowMel) * i / (MEL_BINS + 1))
  )
  melBank = Array.from({ length: MEL_BINS }, (_, m) => {
    const weights = new Float32Array(bins)
    const low = centers[m]
    const center = centers[m + 1]
    const high = centers[m + 2]
    for (let k = 0; k < bins; k++) {
      const hz = k * TARGET_RATE / FFT_SIZE
      if (hz > low && hz <= center) weights[k] = (hz - low) / (center - low)
      else if (hz > center && hz < high) weights[k] = (high - hz) / (high - center)
    }
    return weights
  })
  return melBank
}

function fbankLfrCmvn(samples: Float32Array, means: Float32Array, scales: Float32Array): { data: Float32Array; frames: number } {
  const frameCount = samples.length >= FRAME_LENGTH
    ? 1 + Math.floor((samples.length - FRAME_LENGTH) / FRAME_SHIFT)
    : 0
  if (!frameCount) return { data: new Float32Array(), frames: 0 }
  const filters = melFilters()
  const fbanks = new Float32Array(frameCount * MEL_BINS)
  for (let t = 0; t < frameCount; t++) {
    const power = fftPower(samples.subarray(t * FRAME_SHIFT, t * FRAME_SHIFT + FRAME_LENGTH))
    for (let m = 0; m < MEL_BINS; m++) {
      let energy = 0
      const filter = filters[m]
      for (let k = 0; k < power.length; k++) energy += power[k] * filter[k]
      fbanks[t * MEL_BINS + m] = Math.log(Math.max(Number.EPSILON, energy))
    }
  }

  const output = new Float32Array(frameCount * FEATURE_DIM)
  const leftContext = (LFR_M - 1) >> 1
  for (let t = 0; t < frameCount; t++) {
    for (let context = 0; context < LFR_M; context++) {
      const sourceFrame = Math.max(0, Math.min(frameCount - 1, t + context - leftContext))
      for (let m = 0; m < MEL_BINS; m++) {
        const d = context * MEL_BINS + m
        output[t * FEATURE_DIM + d] = (fbanks[sourceFrame * MEL_BINS + m] + means[d]) * scales[d]
      }
    }
  }
  return { data: output, frames: frameCount }
}

function speechToSilence(
  speechProbability: Float32Array,
  threshold: number,
  durationS: number,
  minimumSilenceS: number
): { start: number; end: number }[] {
  // FunASR's reference endpoint smoother: a 200 ms window with 150 ms needed
  // for either transition, plus conservative 200/100 ms speech extension.
  const window = 20
  const transition = 15
  const ring = new Uint8Array(window)
  const speech: { start: number; end: number }[] = []
  let sum = 0
  let position = 0
  let speaking = false
  let speechStart = 0
  for (let i = 0; i < speechProbability.length; i++) {
    const current = speechProbability[i] >= threshold ? 1 : 0
    sum -= ring[position]
    sum += current
    ring[position] = current
    position = (position + 1) % window
    if (!speaking && sum >= transition) {
      speaking = true
      speechStart = Math.max(0, (i - window - 20) * 0.01)
    } else if (speaking && sum <= transition) {
      speaking = false
      speech.push({ start: speechStart, end: Math.min(durationS, (i + 10) * 0.01) })
    }
  }
  if (speaking) speech.push({ start: speechStart, end: durationS })

  const merged: { start: number; end: number }[] = []
  for (const segment of speech) {
    const last = merged[merged.length - 1]
    if (last && segment.start <= last.end) last.end = Math.max(last.end, segment.end)
    else merged.push({ ...segment })
  }
  const silence: { start: number; end: number }[] = []
  let cursor = 0
  for (const segment of merged) {
    if (segment.start - cursor >= minimumSilenceS) silence.push({ start: cursor, end: segment.start })
    cursor = Math.max(cursor, segment.end)
  }
  if (durationS - cursor >= minimumSilenceS) silence.push({ start: cursor, end: durationS })
  return silence
}

export async function detectFsmnSilences(
  input: Float32Array,
  sourceRate: number,
  durationS: number,
  speechThreshold: number,
  minimumSilenceS: number
): Promise<{ start: number; end: number }[]> {
  const samples = resampleMono(input, sourceRate)
  const { session, means, scales } = await runtime()
  const features = fbankLfrCmvn(samples, means, scales)
  if (!features.frames) return []
  let caches: ort.Tensor[] = Array.from({ length: CACHE_LAYERS }, () =>
    new ort.Tensor('float32', new Float32Array(CACHE_PROJ * CACHE_ORDER), [1, CACHE_PROJ, CACHE_ORDER, 1])
  )
  const speechProbability = new Float32Array(features.frames)
  for (let offset = 0; offset < features.frames; offset += MAX_CHUNK_FRAMES) {
    const frames = Math.min(MAX_CHUNK_FRAMES, features.frames - offset)
    const slice = features.data.subarray(offset * FEATURE_DIM, (offset + frames) * FEATURE_DIM)
    const feeds: Record<string, ort.Tensor> = {
      speech: new ort.Tensor('float32', slice, [1, frames, FEATURE_DIM])
    }
    for (let i = 0; i < CACHE_LAYERS; i++) feeds[`in_cache${i}`] = caches[i]
    const result = await session.run(feeds)
    const logits = result.logits.data as Float32Array
    for (let i = 0; i < frames; i++) speechProbability[offset + i] = 1 - logits[i * 248]
    caches = Array.from({ length: CACHE_LAYERS }, (_, i) => result[`out_cache${i}`])
  }
  return speechToSilence(
    speechProbability,
    Math.max(0, Math.min(1, speechThreshold)),
    durationS,
    minimumSilenceS
  )
}
