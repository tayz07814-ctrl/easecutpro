/**
 * Optional cloud transcription backend (opt-in) using OpenAI **whisper-1**.
 *
 * IMPORTANT: this is deliberately a VERBATIM transcriber. For a tool whose job
 * is cutting repeats/retakes out of video, the transcript MUST keep every
 * stutter, false start, and repeated take so we can locate and remove them.
 * whisper-1 transcribes verbatim and is the only OpenAI model that returns
 * word-level timestamps (`verbose_json` + `timestamp_granularities:["word"]`).
 *
 * We do NOT use gpt-4o-transcribe here: it returns a *cleaned* transcript that
 * silently drops disfluencies and repeats — which erases the very thing this
 * editor exists to cut. (The local whisper.cpp backend in ./whisper.ts is also
 * verbatim, free, and offline — it remains the default.)
 *
 * Audio is split into <=10-minute mono mp3 chunks (well under OpenAI's 25 MB
 * upload cap) so arbitrarily long videos work and each call stays fast.
 */
import { spawn } from 'child_process'
import { createReadStream } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { FFMPEG } from './binaries'
import { probe } from './ffmpeg'
import { getOpenAI } from './openai'
import type { Transcript, Segment, Word } from '../shared/types'

const CHUNK_SECONDS = 600 // 10 min/chunk -> ~4.8 MB mp3, under the 25 MB cap

type ProgressFn = (pct: number, msg?: string) => void

/** Whisper-1 verbose_json word shape. */
interface WhisperWord {
  word: string
  start: number
  end: number
}

interface TimedWord {
  text: string
  start: number
  end: number
}

/**
 * Transcribe a media file with OpenAI whisper-1 (verbatim, word-timestamped).
 * Throws (with a clear message) if no OPENAI_API_KEY is configured.
 */
export async function transcribeOpenAI(
  mediaPath: string,
  onProgress?: ProgressFn
): Promise<Transcript> {
  const openai = getOpenAI() // throws NO_KEY_MESSAGE if unset

  onProgress?.(4, 'Reading media')
  const info = await probe(mediaPath)
  const duration = Math.max(0, info.duration || 0)
  const nChunks = Math.max(1, Math.ceil(duration / CHUNK_SECONDS) || 1)

  const dir = await mkdtemp(join(tmpdir(), 'ecoai-'))
  const words: TimedWord[] = []
  try {
    for (let i = 0; i < nChunks; i++) {
      const start = i * CHUNK_SECONDS
      const len = duration ? Math.min(CHUNK_SECONDS, duration - start) : CHUNK_SECONDS
      const base = 8 + Math.round((i / nChunks) * 86)
      onProgress?.(base, `Transcribing ${nChunks > 1 ? `part ${i + 1}/${nChunks}` : ''}`.trim())

      const chunkPath = join(dir, `c${i}.mp3`)
      await extractAudioChunk(mediaPath, start, len, chunkPath)

      const timed = await transcribeTimed(openai, chunkPath)
      for (const w of timed) words.push({ text: w.text, start: w.start + start, end: w.end + start })
    }

    onProgress?.(98, 'Building transcript')
    return buildTranscript(words)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** whisper-1 -> verbatim word-level timed tokens (keeps repeats/stutters). */
async function transcribeTimed(
  openai: ReturnType<typeof getOpenAI>,
  file: string
): Promise<TimedWord[]> {
  const res = await openai.audio.transcriptions.create({
    file: createReadStream(file),
    model: 'whisper-1',
    response_format: 'verbose_json',
    timestamp_granularities: ['word']
  })
  const words = (res as { words?: WhisperWord[] }).words ?? []
  return words.map((w) => ({ text: w.word, start: w.start, end: w.end }))
}

/** Extract a mono 16 kHz mp3 slice [start, start+len) — small + ASR-native rate. */
function extractAudioChunk(input: string, start: number, len: number, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-ss', String(start),
      '-t', String(len),
      '-i', input,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-b:a', '64k',
      '-y',
      out
    ]
    const proc = spawn(FFMPEG, args)
    let err = ''
    proc.stderr.on('data', (c: Buffer) => {
      err += c.toString()
    })
    proc.on('error', reject)
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg chunk exited ${code}:\n${err.slice(-800)}`))
    )
  })
}

/** Group timed words into sentence-ish segments (split on . ! ? or long runs). */
function buildTranscript(timed: TimedWord[]): Transcript {
  const all: Word[] = timed.map((w) => ({
    id: randomUUID(),
    text: w.text.trim(),
    start: w.start,
    end: w.end > w.start ? w.end : w.start + 0.12
  }))

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
    // End a segment on sentence punctuation, or to avoid a runaway block.
    if (/[.!?]["')\]]?$/.test(w.text) || cur.length >= 40) flush()
  }
  flush()

  return { segments, words: all }
}
