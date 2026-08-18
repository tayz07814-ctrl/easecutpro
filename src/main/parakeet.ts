/**
 * Offline transcription with NVIDIA Parakeet-TDT (via sherpa-onnx-node).
 *
 * Lower WER than whisper large-v3 on English/European audio and very fast, with
 * NO Python dependency — sherpa-onnx-node bundles a native ONNX runtime. Model
 * files (~630 MB) are NOT bundled; download them once with
 *   node scripts/setup-parakeet.mjs
 * into resources/models/parakeet/. Verbatim output (keeps repeats) with token
 * timestamps, which we merge into word-level timing for the editor.
 *
 * Runs on CPU (the prebuilt sherpa-onnx-win-x64 is CPU-only); Parakeet int8 is
 * efficient enough to be faster-than-realtime on a decent CPU.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { cpus } from 'os'
import { randomUUID } from 'crypto'
import { prepareAudioWav } from './ffmpeg'
import { resolveParakeetModel } from './binaries'
import type { Transcript, Segment, Word } from '../shared/types'

type ProgressFn = (pct: number, msg?: string) => void

interface SherpaResult {
  text?: string
  tokens?: string[]
  timestamps?: number[]
}

// The native recognizer is expensive to construct — cache it per model dir.
let recognizer: { createStream(): unknown; decode(s: unknown): void; getResult(s: unknown): SherpaResult } | null = null
let loadedDir: string | null = null
let sherpaMod: { default?: unknown } & Record<string, unknown> = {}

async function getSherpa(): Promise<Record<string, unknown>> {
  if (!sherpaMod.OfflineRecognizer) {
    const m = (await import('sherpa-onnx-node')) as { default?: Record<string, unknown> } & Record<string, unknown>
    sherpaMod = m.default ?? m
  }
  return sherpaMod as Record<string, unknown>
}

async function getRecognizer(modelDir: string): Promise<NonNullable<typeof recognizer>> {
  if (recognizer && loadedDir === modelDir) return recognizer
  const sherpa = await getSherpa()
  const Rec = sherpa.OfflineRecognizer as new (config: unknown) => NonNullable<typeof recognizer>
  recognizer = new Rec({
    modelConfig: {
      transducer: {
        encoder: join(modelDir, 'encoder.int8.onnx'),
        decoder: join(modelDir, 'decoder.int8.onnx'),
        joiner: join(modelDir, 'joiner.int8.onnx')
      },
      tokens: join(modelDir, 'tokens.txt'),
      modelType: 'nemo_transducer',
      numThreads: Math.min(8, Math.max(2, cpus().length - 2)),
      provider: 'cpu',
      debug: 0
    }
  })
  loadedDir = modelDir
  return recognizer
}

/** Transcribe a media file with Parakeet. Throws if the model isn't downloaded. */
export async function transcribeParakeet(
  mediaPath: string,
  onProgress?: ProgressFn
): Promise<Transcript> {
  const modelDir = resolveParakeetModel()
  if (!modelDir) {
    throw new Error('Parakeet model not found. Run: node scripts/setup-parakeet.mjs (downloads ~630 MB).')
  }

  onProgress?.(8, 'Loading Parakeet')
  const rec = await getRecognizer(modelDir)

  onProgress?.(18, 'Extracting audio')
  const wav = await prepareAudioWav(mediaPath)
  onProgress?.(35, 'Transcribing (Parakeet)')
  // Decode the WAV ourselves into a V8-owned Float32Array. sherpa's readWave
  // returns an EXTERNAL-memory buffer, which Electron's main process forbids
  // ("External buffers are not allowed"); this avoids that entirely.
  const wave = readWav16Mono(wav)
  const stream = rec.createStream()
  ;(stream as { acceptWaveform(o: { samples: Float32Array; sampleRate: number }): void }).acceptWaveform({
    samples: wave.samples,
    sampleRate: wave.sampleRate
  })
  rec.decode(stream)
  const result = rec.getResult(stream)
  onProgress?.(95, 'Building transcript')
  return buildTranscript(result)
}

/** Read a PCM WAV into a V8-owned Float32Array (extractAudioWav gives 16k mono s16le). */
function readWav16Mono(path: string): { samples: Float32Array; sampleRate: number } {
  const b = readFileSync(path)
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Parakeet: not a WAV file')
  }
  let sampleRate = 16000
  let channels = 1
  let bits = 16
  let dataOff = -1
  let dataLen = 0
  let off = 12
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4)
    const sz = b.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'fmt ') {
      channels = b.readUInt16LE(body + 2) || 1
      sampleRate = b.readUInt32LE(body + 4) || 16000
      bits = b.readUInt16LE(body + 14) || 16
    } else if (id === 'data') {
      dataOff = body
      dataLen = Math.min(sz, b.length - body)
      break
    }
    off = body + sz + (sz & 1)
  }
  if (dataOff < 0) throw new Error('Parakeet: WAV has no data chunk')
  const frame = Math.max(1, bits >> 3) * channels
  const n = Math.floor(dataLen / frame)
  const samples = new Float32Array(n) // V8-owned (NOT external)
  for (let i = 0; i < n; i++) {
    const p = dataOff + i * frame // channel 0 (mono)
    if (bits === 16) samples[i] = b.readInt16LE(p) / 32768
    else if (bits === 32) samples[i] = b.readFloatLE(p)
    else if (bits === 8) samples[i] = (b.readUInt8(p) - 128) / 128
  }
  return { samples, sampleRate }
}

/** Merge Parakeet's BPE tokens (▁ = word boundary) + token timestamps into words. */
function tokensToWords(tokens: string[], times: number[]): Word[] {
  const out: { text: string; start: number; end: number }[] = []
  let cur: { text: string; start: number; end: number } | null = null
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i] ?? ''
    const t: number = Number(times[i] ?? (cur ? cur.end : 0))
    // U+2581 (▁) or a leading space marks the start of a new word.
    const isStart = raw.startsWith('▁') || raw.startsWith(' ') || cur === null
    const piece = raw.replace(/▁/g, '').trim()
    if (isStart) {
      if (cur) out.push(cur)
      cur = { text: piece, start: t, end: t }
    } else if (cur) {
      cur.text += piece
      cur.end = t
    }
  }
  if (cur) out.push(cur)
  // A token timestamp is the token's START; a word ends where the next word starts.
  return out
    .filter((w) => w.text)
    .map((w, i, arr) => {
      const next = arr[i + 1]
      let end = next ? next.start : w.start + 0.3
      if (!(end > w.start)) end = w.start + 0.12
      return { id: randomUUID(), text: w.text, start: w.start, end }
    })
}

function buildTranscript(result: SherpaResult): Transcript {
  const all = tokensToWords(result.tokens ?? [], result.timestamps ?? [])
  const segments: Segment[] = []
  let cur: Word[] = []
  const flush = (): void => {
    if (cur.length) {
      segments.push({ id: randomUUID(), start: cur[0].start, end: cur[cur.length - 1].end, words: cur })
      cur = []
    }
  }
  for (const w of all) {
    cur.push(w)
    if (/[.!?]["')\]]?$/.test(w.text) || cur.length >= 40) flush()
  }
  flush()
  return { segments, words: all }
}
