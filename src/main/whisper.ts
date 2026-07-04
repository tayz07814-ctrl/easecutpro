import { spawn } from 'child_process'
import { readFile, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { cpus } from 'os'
import { randomUUID } from 'crypto'
import { WHISPER_BIN, resolveWhisperModel, resolveWhisperModelByName } from './binaries'
import { extractAudioWav } from './ffmpeg'
import type { Transcript, Segment, Word } from '../shared/types'

/**
 * Transcribe a media file to a word-timestamped transcript using whisper.cpp.
 * Throws if whisper isn't installed (no placeholder/stub is produced).
 */
export async function transcribe(
  mediaPath: string,
  onProgress?: (pct: number, msg?: string) => void,
  modelName?: string
): Promise<Transcript> {
  // Use the explicitly-selected model if present, else the best available.
  const model = (modelName && resolveWhisperModelByName(modelName)) || resolveWhisperModel()
  if (!WHISPER_BIN || !model) {
    throw new Error(
      'Whisper is not installed. Run scripts/setup-whisper.ps1 (downloads whisper-cli + a model), then restart EaseCutPro.'
    )
  }

  onProgress?.(5, 'Extracting audio')
  const wav = await extractAudioWav(mediaPath)
  const jsonOut = wav.replace(/\.wav$/, '')

  try {
    onProgress?.(15, 'Transcribing with whisper.cpp')
    await runWhisper(WHISPER_BIN, model, wav, jsonOut, onProgress)
    const jsonPath = `${jsonOut}.json`
    if (!existsSync(jsonPath)) throw new Error('whisper produced no JSON output')
    const raw = JSON.parse(await readFile(jsonPath, 'utf8'))
    await safeUnlink(jsonPath)
    return parseWhisperJson(raw)
  } finally {
    await safeUnlink(wav)
  }
}

function runWhisper(
  bin: string,
  model: string,
  wav: string,
  outBase: string,
  onProgress?: (pct: number, msg?: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Use most cores for faster CPU inference (whisper scales well to ~8-16).
    const threads = Math.min(16, Math.max(4, cpus().length - 2))
    // Full JSON keeps whisper's natural sentence segmentation + punctuation AND
    // gives per-token timestamps we fold into word-level timing.
    const args = [
      '-m', model,
      '-f', wav,
      '-t', String(threads),
      '-fa', // flash attention — faster on CUDA GPUs (auto-uses the GPU when the
      //        CUDA build of whisper-cli is present in resources/bin)
      // ---- Anti-hallucination (whisper loves to invent/repeat text) ----
      '-ojf', // output json full (segments + tokens)
      '-of', outBase,
      '-pp' // print progress
    ]
    const proc = spawn(bin, args)
    let err = ''
    proc.stderr.on('data', (c: Buffer) => {
      err += c.toString()
      const m = c.toString().match(/progress\s*=\s*(\d+)%/)
      if (m && onProgress) onProgress(15 + Math.round(Number(m[1]) * 0.8), 'Transcribing')
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`whisper exited ${code}:\n${err.slice(-1500)}`))
    })
  })
}

/** A whisper special/control token like [_BEG_], [_TT_123], [_EOT_]. */
function isSpecialToken(text: string): boolean {
  return /^\[_.*\]$/.test(text.trim())
}

/** Build word-level Words from a segment's BPE tokens (merging subwords). */
function wordsFromTokens(tokens: any[]): Word[] {
  const words: Word[] = []
  let cur: { text: string; start: number; end: number } | null = null
  const flush = (): void => {
    if (cur && cur.text.trim()) {
      let end = cur.end
      if (!(end > cur.start)) end = cur.start + 0.12
      if (end - cur.start > 30) end = cur.start + 0.5
      words.push({ id: randomUUID(), text: cur.text.trim(), start: cur.start, end })
    }
    cur = null
  }
  for (const tok of tokens) {
    const raw: string = tok?.text ?? ''
    if (!raw || isSpecialToken(raw)) continue
    const [ts, te] = segTimes(tok)
    // A leading space marks a new word; otherwise it's a subword/punctuation continuation.
    if (raw.startsWith(' ') || cur === null) {
      flush()
      cur = { text: raw.trim(), start: ts, end: te }
    } else {
      cur.text += raw
      cur.end = te
    }
  }
  flush()
  return words
}

/** Convert whisper.cpp full JSON into our Transcript model (proper sentences). */
function parseWhisperJson(raw: any): Transcript {
  const segments: Segment[] = []
  const allWords: Word[] = []
  const rawSegs: any[] = raw.transcription ?? raw.segments ?? []

  for (const seg of rawSegs) {
    let words = Array.isArray(seg.tokens) ? wordsFromTokens(seg.tokens) : []
    if (words.length === 0) {
      // Fallback: no tokens — use the segment text as a single word.
      const text: string = (seg.text ?? '').trim()
      if (!text) continue
      let [s, e] = segTimes(seg)
      if (!(e > s)) e = s + 0.3
      words = [{ id: randomUUID(), text, start: s, end: e }]
    }
    allWords.push(...words)
    segments.push(makeSegment(words))
  }

  return { segments, words: allWords }
}

function makeSegment(words: Word[]): Segment {
  return {
    id: randomUUID(),
    start: words[0].start,
    end: words[words.length - 1].end,
    words
  }
}

/**
 * Returns [start, end] in SECONDS for a whisper segment.
 * whisper.cpp offsets.from/to are MILLISECONDS, t0/t1 are CENTISECONDS,
 * and start/end (if present) are already seconds.
 */
function segTimes(seg: any): [number, number] {
  if (seg?.offsets && seg.offsets.from != null) {
    const from = Number(seg.offsets.from)
    const to = Number(seg.offsets.to ?? seg.offsets.from)
    return [Math.max(0, from / 1000), Math.max(0, to / 1000)]
  }
  if (seg?.t0 != null) {
    const t0 = Number(seg.t0)
    const t1 = Number(seg.t1 ?? seg.t0)
    return [Math.max(0, t0 / 100), Math.max(0, t1 / 100)]
  }
  const s = Math.max(0, Number(seg?.start ?? 0))
  const e = Math.max(0, Number(seg?.end ?? s))
  return [s, e]
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await unlink(p)
  } catch {
    /* ignore */
  }
}