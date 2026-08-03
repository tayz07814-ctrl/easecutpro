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

export async function premiumCutCloud(
  mediaId: string,
  onProgress?: (pct: number, msg?: string) => void
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
  const { path, token } = await invokeEdge<SttSignUploadRes>('stt', { action: 'sign-upload', ext: 'wav' })
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
  // Cuts with no words under them (pure pauses) are DROPPED — every
  // silence-cutting path was removed from this branch, so Premium is word-cuts
  // only here.
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
  const wordCuts = rawCuts.filter(hasWord)
  const cutSpans: CutSpan[] = wordCuts.map(toSpan)
  const deleteWordIds = spansToWordIds(cutSpans, transcript)
  const silenceRegions: SilenceRegion[] = []

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
    summary: `Premium Cut (Gemini): ${deleteWordIds.length} word(s) flagged`
  }
}
