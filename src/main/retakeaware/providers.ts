// Retake-Aware Cut Beta — verbatim transcription providers.
//
// Provider order (first configured wins): AssemblyAI -> Deepgram -> the app's
// existing whisper-1 verbatim transcriber (with a logged warning) -> clean
// error. Keys come from ASSEMBLYAI_API_KEY / DEEPGRAM_API_KEY in any *.env
// file in the app folder (same convention as the OpenAI/Anthropic keys) or
// from process.env. Nothing here is imported by the standard engines.

import { readFileSync, readdirSync, existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import type { VerbatimTranscript, VerbatimWord, VerbatimUtterance, VerbatimProvider } from '../../shared/retakeaware/types'
import { transcribeOpenAI } from '../openai-transcribe'
import { openaiAvailable } from '../openai'

type ProgressFn = (pct: number, msg?: string) => void

export interface TranscriptionProvider {
  name: VerbatimProvider
  transcribeVerbatim(audioFilePath: string, onProgress?: ProgressFn): Promise<VerbatimTranscript>
}

// ---- key resolution (project *.env files beat process.env, like openai.ts) ----
function resolveKey(envName: string): string | null {
  for (const dir of [process.cwd(), join(process.cwd(), '..')]) {
    if (!existsSync(dir)) continue
    let files: string[] = []
    try {
      files = readdirSync(dir).filter((f) => /\.env(\.|$)/i.test(f))
    } catch {
      continue
    }
    for (const f of files) {
      try {
        for (const line of readFileSync(join(dir, f), 'utf8').split(/\r?\n/)) {
          const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/)
          if (m && m[1].toUpperCase() === envName) return m[2].replace(/^["']|["']$/g, '')
        }
      } catch {
        /* unreadable candidate */
      }
    }
  }
  return process.env[envName]?.trim() || null
}

function finish(vt: Omit<VerbatimTranscript, 'raw_text' | 'clean_text'>): VerbatimTranscript {
  const raw = vt.words.map((w) => w.word).join(' ')
  return {
    ...vt,
    raw_text: raw,
    // clean text is DISPLAY ONLY — decisions always read raw words.
    clean_text: raw.replace(/\b(uh|um|er|ah|erm|hmm)\b[,.]?\s*/gi, '').replace(/\s+/g, ' ').trim()
  }
}

// ---- AssemblyAI (primary): universal model, disfluencies preserved ----
class AssemblyAIProvider implements TranscriptionProvider {
  name = 'assemblyai' as const
  constructor(private key: string) {}
  async transcribeVerbatim(audioFilePath: string, onProgress?: ProgressFn): Promise<VerbatimTranscript> {
    const base = 'https://api.assemblyai.com/v2'
    const headers = { authorization: this.key }
    onProgress?.(8, 'Uploading audio to AssemblyAI…')
    const audio = await readFile(audioFilePath)
    const up = await fetch(`${base}/upload`, { method: 'POST', headers, body: audio })
    if (!up.ok) throw new Error(`AssemblyAI upload failed: HTTP ${up.status} ${(await up.text()).slice(0, 200)}`)
    const { upload_url } = (await up.json()) as { upload_url: string }
    onProgress?.(15, 'AssemblyAI is transcribing (verbatim)…')
    const start = await fetch(`${base}/transcript`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        audio_url: upload_url,
        // verbatim/disfluency-preserving: keep uh/um/false starts in the words
        disfluencies: true,
        format_text: false,
        punctuate: true,
        // Universal-3 Pro first, Universal-2 fallback. NOTE: the singular
        // `speech_model` param is deprecated and 400s — it must be the
        // `speech_models` ARRAY (verified against the live API 2026-07-08).
        speech_models: ['universal-3-5-pro', 'universal-2']
      })
    })
    if (!start.ok) throw new Error(`AssemblyAI transcript request failed: HTTP ${start.status} ${(await start.text()).slice(0, 200)}`)
    const { id } = (await start.json()) as { id: string }
    for (;;) {
      await new Promise((r) => setTimeout(r, 2500))
      const res = await fetch(`${base}/transcript/${id}`, { headers })
      if (!res.ok) throw new Error(`AssemblyAI poll failed: HTTP ${res.status}`)
      const t = (await res.json()) as {
        status: string
        error?: string
        words?: { text: string; start: number; end: number; confidence?: number }[]
        utterances?: { start: number; end: number; text: string }[]
      }
      if (t.status === 'error') throw new Error(`AssemblyAI: ${t.error}`)
      if (t.status === 'completed') {
        const words: VerbatimWord[] = (t.words ?? []).map((w) => ({
          word: w.text,
          start: w.start / 1000,
          end: w.end / 1000,
          confidence: w.confidence
        }))
        const utterances: VerbatimUtterance[] = (t.utterances ?? []).map((u) => ({
          start: u.start / 1000,
          end: u.end / 1000,
          text: u.text
        }))
        return finish({ provider: 'assemblyai', mode: 'verbatim', words, segments: utterances, utterances })
      }
      onProgress?.(20, 'AssemblyAI is transcribing (verbatim)…')
    }
  }
}

// ---- Deepgram (alternative): filler_words on, smart_format OFF ----
class DeepgramProvider implements TranscriptionProvider {
  name = 'deepgram' as const
  constructor(private key: string) {}
  async transcribeVerbatim(audioFilePath: string, onProgress?: ProgressFn): Promise<VerbatimTranscript> {
    onProgress?.(10, 'Deepgram is transcribing (verbatim)…')
    const audio = await readFile(audioFilePath)
    // smart_format stays OFF: it can normalize away the disfluencies we need.
    const qs = 'model=nova-3&punctuate=true&filler_words=true&utterances=true&smart_format=false'
    const res = await fetch(`https://api.deepgram.com/v1/listen?${qs}`, {
      method: 'POST',
      headers: { Authorization: `Token ${this.key}`, 'content-type': 'audio/wav' },
      body: audio
    })
    if (!res.ok) throw new Error(`Deepgram failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
    const j = (await res.json()) as {
      results?: {
        channels?: { alternatives?: { words?: { word: string; punctuated_word?: string; start: number; end: number; confidence?: number }[] }[] }[]
        utterances?: { start: number; end: number; transcript: string }[]
      }
    }
    const dgWords = j.results?.channels?.[0]?.alternatives?.[0]?.words ?? []
    const words: VerbatimWord[] = dgWords.map((w) => ({
      word: w.punctuated_word || w.word,
      start: w.start,
      end: w.end,
      confidence: w.confidence
    }))
    const utterances: VerbatimUtterance[] = (j.results?.utterances ?? []).map((u) => ({
      start: u.start,
      end: u.end,
      text: u.transcript
    }))
    return finish({ provider: 'deepgram', mode: 'verbatim', words, segments: utterances, utterances })
  }
}

// ---- Existing (fallback): the app's whisper-1 verbatim transcriber ----
class ExistingProvider implements TranscriptionProvider {
  name = 'existing' as const
  async transcribeVerbatim(audioFilePath: string, onProgress?: ProgressFn): Promise<VerbatimTranscript> {
    const t = await transcribeOpenAI(audioFilePath, (pct, msg) => onProgress?.(Math.min(40, pct), msg))
    const words: VerbatimWord[] = t.words.map((w) => ({ word: w.text, start: w.start, end: w.end, confidence: w.conf ?? w.confidence }))
    const utterances: VerbatimUtterance[] = t.segments.map((s) => ({
      start: s.start,
      end: s.end,
      text: s.words.map((w) => w.text).join(' ')
    }))
    return finish({ provider: 'existing', mode: 'verbatim', words, segments: utterances, utterances })
  }
}

/** Configured providers, best first. */
export function availableProviders(): TranscriptionProvider[] {
  const out: TranscriptionProvider[] = []
  const aai = resolveKey('ASSEMBLYAI_API_KEY')
  if (aai) out.push(new AssemblyAIProvider(aai))
  const dg = resolveKey('DEEPGRAM_API_KEY')
  if (dg) out.push(new DeepgramProvider(dg))
  if (openaiAvailable()) out.push(new ExistingProvider())
  return out
}

/** Transcribe with the best configured provider; on failure fall through to
 *  the next one. Throws a clean error only when NOTHING is configured/works. */
export async function transcribeVerbatim(
  audioFilePath: string,
  onProgress?: ProgressFn
): Promise<{ vt: VerbatimTranscript; warnings: string[] }> {
  const provs = availableProviders()
  const warnings: string[] = []
  if (!provs.length) {
    throw new Error(
      'Retake-Aware Cut Beta needs a transcription provider. Set ASSEMBLYAI_API_KEY or DEEPGRAM_API_KEY (or an OpenAI key for fallback) in a *.env file in the EaseCutPro folder.'
    )
  }
  if (provs[0].name === 'existing') {
    warnings.push('Beta engine is using FALLBACK transcription (existing whisper-1) — set ASSEMBLYAI_API_KEY or DEEPGRAM_API_KEY for disfluency-native results.')
    console.warn('[retake-aware-beta] using fallback transcription (existing whisper-1)')
  }
  let lastErr: Error | null = null
  for (const p of provs) {
    try {
      console.log(`[retake-aware-beta] transcribing with provider: ${p.name}`)
      const vt = await p.transcribeVerbatim(audioFilePath, onProgress)
      if (!vt.words.length) throw new Error(`${p.name} returned no words`)
      return { vt, warnings }
    } catch (e) {
      lastErr = e as Error
      warnings.push(`Provider ${p.name} failed: ${lastErr.message}`)
      console.warn(`[retake-aware-beta] provider ${p.name} failed: ${lastErr.message}`)
    }
  }
  throw new Error(`All transcription providers failed. Last error: ${lastErr?.message}`)
}
