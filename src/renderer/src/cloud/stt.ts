// Cloud build — verbatim transcription via the Supabase `stt` edge function.
//
// Browser twin of src/main/retakeaware/providers.ts transcribeVerbatim. Same
// provider order and semantics (AssemblyAI -> Deepgram -> clean error), same
// word mapping and finish() text rules — but the keys live as Supabase Edge
// Function secrets and the audio goes up ONCE to the private stt-audio bucket
// (signed upload), from which both providers transcribe. There is NO whisper-1
// tier here: the cloud build has no OpenAI transcriber, so when neither key is
// configured (or both fail) the run stops with a clean error instead.
// Retries/backoff for the raw provider HTTP live in the edge function; this
// side mirrors the Node poll cadence (2.5s) and its tolerance of 8 consecutive
// failed polls (the AssemblyAI job keeps running server-side through a blip).

import type { VerbatimTranscript, VerbatimWord, VerbatimUtterance, VerbatimProvider } from '@shared/retakeaware/types'
import type {
  SttReq,
  SttStatusRes,
  SttSignUploadRes,
  SttAaiStartRes,
  SttAaiPollRes,
  SttDeepgramRes
} from '@shared/cloud'
import { getSupabase, invokeEdge } from './supabase'
import { openAccountPanel } from './subscription'
import { isTrialLimit, TrialLimitError } from '../safeError'

type ProgressFn = (pct: number, msg?: string) => void

const POLL_MS = 2500
const POLL_TOLERATED_FAILURES = 8

// Friendly, backend-agnostic lines shown while transcribing (the long, opaque
// phase). The STT provider is NEVER named in the UI.
const TRANSCRIBE_MSGS = [
  'Listening to your video…',
  'Transcribing every word…',
  'Finding pauses…',
  'Spotting retakes…',
  'Mapping the silences…'
]

function sttEdge<T>(body: SttReq): Promise<T> {
  return invokeEdge<T>('stt', body)
}

// Mirrors providers.ts finish() exactly — raw text from the words, clean text
// display-only (decisions always read raw words).
function finish(vt: Omit<VerbatimTranscript, 'raw_text' | 'clean_text'>): VerbatimTranscript {
  const raw = vt.words.map((w) => w.word).join(' ')
  return {
    ...vt,
    raw_text: raw,
    // clean text is DISPLAY ONLY — decisions always read raw words.
    clean_text: raw.replace(/\b(uh|um|er|ah|erm|hmm)\b[,.]?\s*/gi, '').replace(/\s+/g, ' ').trim()
  }
}

// ---- AssemblyAI (primary): started + polled through the edge function ----
async function assemblyAiTranscribe(path: string, onProgress?: ProgressFn): Promise<VerbatimTranscript> {
  onProgress?.(14, TRANSCRIBE_MSGS[0])
  const { id } = await sttEdge<SttAaiStartRes>({ action: 'aai-start', path })
  let pollFailures = 0
  let polls = 0
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    let t: SttAaiPollRes
    try {
      t = await sttEdge<SttAaiPollRes>({ action: 'aai-poll', id })
    } catch (e) {
      // The transcription job keeps running server-side regardless of a
      // local network blip — tolerate a run of failed polls before giving
      // up, instead of aborting the whole job on the first one.
      if (++pollFailures >= POLL_TOLERATED_FAILURES) throw e
      continue
    }
    pollFailures = 0
    if (t.status === 'error') throw new Error(t.error ? `Transcription error: ${t.error}` : 'Transcription failed — please try again.')
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
    polls++
    // Transcription owns the 0–50 band; climb gently so the bar keeps moving
    // through the long, opaque STT phase instead of stalling at one number.
    onProgress?.(Math.min(49, 16 + polls * 2.5), TRANSCRIBE_MSGS[polls % TRANSCRIBE_MSGS.length])
  }
}

// ---- Deepgram (alternative): one edge call, seconds already ----
async function deepgramTranscribe(path: string, onProgress?: ProgressFn): Promise<VerbatimTranscript> {
  onProgress?.(16, TRANSCRIBE_MSGS[0])
  const j = await sttEdge<SttDeepgramRes>({ action: 'deepgram', path })
  const words: VerbatimWord[] = (j.words ?? []).map((w) => ({
    word: w.punctuated_word || w.word,
    start: w.start,
    end: w.end,
    confidence: w.confidence
  }))
  const utterances: VerbatimUtterance[] = (j.utterances ?? []).map((u) => ({
    start: u.start,
    end: u.end,
    text: u.transcript
  }))
  return finish({ provider: 'deepgram', mode: 'verbatim', words, segments: utterances, utterances })
}

/** Transcribe the extracted STT audio with the best configured provider; on
 *  failure fall through to the next one. Throws a clean error only when
 *  NOTHING is configured/works. The temp audio object is ALWAYS cleaned up
 *  (fire-and-forget), success or failure. */
export async function transcribeVerbatimCloud(
  audio: { blob: Blob; ext: string },
  onProgress?: ProgressFn
): Promise<{ vt: VerbatimTranscript; warnings: string[] }> {
  const warnings: string[] = []
  const status = await sttEdge<SttStatusRes>({ action: 'status' })
  const chain: Exclude<VerbatimProvider, 'existing' | 'mock'>[] = []
  if (status.assemblyai) chain.push('assemblyai')
  if (status.deepgram) chain.push('deepgram')
  if (!chain.length) {
    throw new Error('Cut Lord can’t transcribe yet — no transcription provider is configured on the server.')
  }
  // ONE upload feeds both providers (they transcribe from a signed download URL).
  onProgress?.(8, 'Preparing your video…')
  let signed: SttSignUploadRes
  try {
    signed = await sttEdge<SttSignUploadRes>({ action: 'sign-upload', ext: audio.ext })
  } catch (e) {
    // Free-trial limit hit (server-enforced in the stt fn): open the upgrade
    // panel and stop with a typed, creator-safe error (never a raw string).
    if (isTrialLimit(e)) {
      openAccountPanel('trial')
      throw new TrialLimitError()
    }
    throw e
  }
  const { path, token } = signed
  try {
    const up = await getSupabase().storage.from('stt-audio').uploadToSignedUrl(path, token, audio.blob)
    if (up.error) throw new Error(`Audio upload failed: ${up.error.message}`)
    let lastErr: Error | null = null
    for (const name of chain) {
      try {
        console.log(`[retake-aware-beta] transcribing with provider: ${name}`)
        const vt = name === 'assemblyai' ? await assemblyAiTranscribe(path, onProgress) : await deepgramTranscribe(path, onProgress)
        if (!vt.words.length) throw new Error(`${name} returned no words`)
        return { vt, warnings }
      } catch (e) {
        lastErr = e as Error
        warnings.push(`Provider ${name} failed: ${lastErr.message}`)
        console.warn(`[retake-aware-beta] provider ${name} failed: ${lastErr.message}`)
      }
    }
    throw new Error(`All transcription providers failed. Last error: ${lastErr?.message}`)
  } finally {
    // fire-and-forget: the run never waits on (or fails from) the temp delete.
    void sttEdge({ action: 'cleanup', path }).catch(() => undefined)
  }
}
