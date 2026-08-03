// EaseCutPro - Premium Cut cloud engine (Gemini 3.5 Flash, multimodal).
//
// A THIRD experimental engine beside Retake Beta (procut-judge, Opus) and Ultracut
// (ultracut-judge, DeepSeek). Unlike those, it runs NEITHER STT NOR the ONNX VAD:
// it uploads the raw 16 kHz WAV and lets Gemini 3.5 Flash LISTEN - Gemini produces
// the verbatim transcript AND all the cuts (retakes + silence) in one pass. We map
// Gemini's TIME-based cuts into the SAME RetakeAwareResult the other two engines
// return, so the review-first transcript + "Execute cuts" UX is byte-identical.
//
// Flow: extract audio (shared with STT) -> upload to the stt-audio bucket (reuse
// the STT sign-upload flow) -> premium-cut edge fn reads it, base64s it, and hands
// it to Gemini -> parse Gemini's { transcript, cuts, clean_transcript } -> build the
// result. Cloud-only (easecut0.01); nothing here touches the other two engines.

import type {
  RetakeAwareResult,
  CutSpan,
  VerbatimTranscript,
  VerbatimWord,
  VerbatimUtterance
} from '@shared/retakeaware/types'
import type { SilenceRegion } from '@shared/types'
import type { PremiumCutReq, ProcutJudgeRes, SttSignUploadRes } from '@shared/cloud'
import { toAppTranscript, type ProgressFn } from '@shared/retakeaware/engine'
import { spansToWordIds } from '@shared/retakeaware/analyze'
import { DEFAULT_VAD_SILENCE_SETTINGS, type VadSilenceSettings } from '@shared/vadsilence'
import { getSupabase, invokeEdge } from './supabase'
import { extractSttAudio } from './audio'

// Gemini's JSON contract (the creator's Premium prompt).
interface GeminiSeg {
  start: number
  end: number
  text: string
}
interface GeminiCut {
  start: number
  end: number
  reason?: string
  confidence?: number
}
interface GeminiOut {
  transcript?: GeminiSeg[]
  cuts?: GeminiCut[]
  clean_transcript?: string
}

// Gemini gives SEGMENT-level timing; the review UI is word-addressable. Split each
// segment's text into words with proportional timing inside [start,end]. Not
// frame-accurate - it's a review aid (the user reviews before Execute), and the
// cuts themselves ride Gemini's own timestamps, not these.
function segmentsToVerbatim(segs: GeminiSeg[], cleanText: string): VerbatimTranscript {
  const words: VerbatimWord[] = []
  const utterances: VerbatimUtterance[] = []
  for (const s of segs) {
    const start = Number(s.start) || 0
    const end = Math.max(start, Number(s.end) || start)
    const text = (s.text ?? '').trim()
    if (!text) continue
    utterances.push({ start, end, text })
    const toks = text.split(/\s+/).filter(Boolean)
    const step = toks.length ? (end - start) / toks.length : 0
    toks.forEach((tok, i) => {
      words.push({ word: tok, start: start + i * step, end: start + (i + 1) * step })
    })
  }
  return {
    provider: 'gemini',
    mode: 'verbatim',
    words,
    segments: utterances,
    utterances,
    raw_text: utterances.map((u) => u.text).join(' '),
    clean_text: cleanText || ''
  }
}

function parseGemini(raw: string): GeminiOut | null {
  try {
    const t = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
    const m = t.match(/\{[\s\S]*\}/)
    return JSON.parse(m ? m[0] : t) as GeminiOut
  } catch {
    return null
  }
}

// Smooth-seam margins for Premium's PAUSE cuts: a trimmed pause never slices flush
// against speech. Anchored to the kept words below so the margin is exact even
// though Gemini's audio timestamps aren't millisecond-precise.
const LEAD_IN_S = 0.1 // keep 100 ms before the following kept sentence/word begins
const TAIL_S = 0.3 // keep 300 ms after the preceding kept sentence/word ends

export async function premiumCutCloud(
  mediaId: string,
  onProgress?: (pct: number, msg?: string) => void,
  // Premium Cut has NO VAD pass - Gemini proposes silence itself. Kept for the
  // shared window.api.retakeAwareCut signature; unused here.
  _vadSettings: VadSilenceSettings = DEFAULT_VAD_SILENCE_SETTINGS
): Promise<RetakeAwareResult> {
  const warnings: string[] = []
  const op: ProgressFn = (pct, msg) => onProgress?.(pct, msg)
  console.log('[premium] cloud job start (Gemini 3.5 Flash multimodal):', mediaId)

  // 1. audio - the SAME 16 kHz mono WAV extraction STT uses. We only need the
  //    encoded blob (no VAD/float32 pass in this engine).
  op(4, 'Getting your audio ready…')
  const audio = await extractSttAudio(mediaId, (p) => op(4 + Math.round(p * 0.16)))

  // 2. upload the WAV to the stt-audio bucket (reuse the STT sign-upload flow) so
  //    the edge fn can read it server-side and hand it to Gemini as base64 audio.
  op(24, 'Uploading your audio…')
  const { path, token } = await invokeEdge<SttSignUploadRes>('stt', { action: 'sign-upload' })
  const up = await getSupabase().storage.from('stt-audio').uploadToSignedUrl(path, token, audio.blob)
  if (up.error) throw new Error(`Audio upload failed: ${up.error.message}`)

  // 3. Gemini LISTENS - one multimodal pass returns the transcript + all cuts.
  let out: GeminiOut | null = null
  try {
    op(42, 'Premium is listening to your recording…')
    const res = await invokeEdge<ProcutJudgeRes>('premium-cut', { path } satisfies PremiumCutReq)
    if (res.judge === 'none') {
      warnings.push('Premium Cut needs the OpenRouter API key configured on the server — no cuts.')
    } else if (res.raw == null) {
      warnings.push('Premium Cut couldn’t analyze this clip — no cuts.')
    } else {
      out = parseGemini(res.raw)
      if (!out) warnings.push('Premium Cut couldn’t read Gemini’s result — no cuts.')
    }
  } catch (e) {
    warnings.push(`Premium Cut couldn’t finish (${(e as Error).message}).`)
  } finally {
    void invokeEdge('stt', { action: 'cleanup', path }).catch(() => undefined)
  }

  // 4. map Gemini's TIME-based output into the standard RetakeAwareResult.
  op(88, 'Mapping the cuts…')
  const segs = (out?.transcript ?? []).filter(
    (s) => s && Number.isFinite(Number(s.start)) && Number.isFinite(Number(s.end))
  )
  const verbatim = segmentsToVerbatim(segs, out?.clean_transcript ?? '')
  const transcript = toAppTranscript(verbatim)

  // A cut that covers words -> WORD cuts (highlighted in the transcript for review).
  // A cut with no words under it (pure silence/pause) -> a protected silence region
  // (removed verbatim on Execute). This replaces the ONNX VAD entirely.
  const rawCuts = (out?.cuts ?? []).filter((c) => c && Number(c.end) > Number(c.start))
  const hasWord = (c: GeminiCut): boolean =>
    verbatim.words.some((w) => {
      const mid = (w.start + w.end) / 2
      return mid >= c.start && mid <= c.end
    })
  const toSpan = (c: GeminiCut): CutSpan => ({
    start: Number(c.start),
    end: Number(c.end),
    type: 'failed_retake',
    source: 'retake_aware_beta',
    reason: (c.reason || 'gemini cut').slice(0, 200)
  })
  const cutSpans: CutSpan[] = rawCuts.map(toSpan)
  const deleteWordIds = spansToWordIds(rawCuts.filter(hasWord).map(toSpan), transcript)

  // Pause cuts, with smooth-seam margins anchored to the neighbouring kept words:
  // trim from (prev kept word end + TAIL_S) to (next kept word start - LEAD_IN_S),
  // so 300 ms of tail survives after the preceding speech and 100 ms of lead-in
  // survives before the following speech. Leading/trailing silence (no neighbour on
  // one side) trims to the pause edge on that side. Cuts too short to keep both
  // margins are dropped (a sub-~430 ms gap is a natural beat — leave it).
  const words = verbatim.words
  const silenceRegions: SilenceRegion[] = []
  for (const c of rawCuts) {
    if (hasWord(c)) continue
    const cs = Number(c.start)
    const ce = Number(c.end)
    let prevEnd = -Infinity
    let nextStart = Infinity
    for (const w of words) {
      if (w.end <= cs + 0.02 && w.end > prevEnd) prevEnd = w.end
      if (w.start >= ce - 0.02 && w.start < nextStart) nextStart = w.start
    }
    const lo = Number.isFinite(prevEnd) ? prevEnd + TAIL_S : cs
    const hi = Number.isFinite(nextStart) ? nextStart - LEAD_IN_S : ce
    if (hi - lo >= 0.03) {
      silenceRegions.push({ id: `pg${silenceRegions.length}`, start: lo, end: hi, action: 'remove', protect: true })
    }
  }

  if (!rawCuts.length && !warnings.length) warnings.push('Premium Cut found nothing to cut.')

  op(100, 'Premium Cut finished')
  return {
    cut_mode: 'retake_aware_beta',
    provider: 'gemini',
    verbatim,
    transcript,
    deleteWordIds,
    cutSpans,
    silenceRegions,
    retakeGroups: [],
    fillerDecisions: [],
    debugPath: null,
    warnings,
    summary: `Premium Cut (Gemini): ${deleteWordIds.length} word(s) flagged, ${silenceRegions.length} pause(s)`
  }
}
