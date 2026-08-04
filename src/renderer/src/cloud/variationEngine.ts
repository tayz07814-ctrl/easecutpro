// AI Variations — ask the judge to cast the transcript into short-form edits.
//
// Reuses the `ultracut-judge` edge function on its `variations` prompt, so this
// inherits the streaming keep-alive, the time budget and the fallback model
// already proven by the retake path. The only thing that differs is the prompt
// and the shape of the reply.
//
// The model answers in WORD INDICES; validateAiVariations converts those to
// source seconds from the transcript's own timings, so no timestamp is ever
// invented by the model.

import type { Transcript } from '@shared/types'
import type { ProcutJudgeRes } from '@shared/cloud'
import type { Variation } from '@shared/variations'
import { buildVariationPayload, validateAiVariations, type AiVariationWord } from '@shared/aiVariations'
import { invokeEdge } from './supabase'

export interface GenerateVariationsResult {
  variations: Variation[]
  warnings: string[]
}

export async function generateVariationsCloud(
  transcript: Transcript,
  durationS: number,
  count: number,
  targetSeconds: number,
  onProgress?: (pct: number, msg?: string) => void
): Promise<GenerateVariationsResult> {
  const op = (pct: number, msg?: string): void => onProgress?.(pct, msg)

  // Only real spoken words — blanks would shift every index the model returns.
  const words: AiVariationWord[] = transcript.words
    .filter((w) => w.text && w.text.trim())
    .map((w) => ({ text: w.text, start: w.start, end: w.end }))

  if (words.length < 20) {
    return { variations: [], warnings: ['This transcript is too short to build variations from.'] }
  }

  op(35, 'Reading your transcript…')
  const payload = buildVariationPayload(words, durationS, count, targetSeconds)

  op(55, `Casting ${count} ${targetSeconds}s variation${count === 1 ? '' : 's'}…`)
  let res: ProcutJudgeRes
  try {
    res = await invokeEdge<ProcutJudgeRes>('ultracut-judge', {
      payload,
      proposal: { word_cuts: [], pause_cuts: [] },
      // Gemma 4 31B at reasoning 'medium', matching the retake judge.
      model: 'google/gemma-4-31b-it',
      promptVariant: 'variations',
      reasoning: 'medium'
    })
  } catch {
    return { variations: [], warnings: ['Couldn’t reach the AI — please try again.'] }
  }

  if (res.judge === 'none' || res.raw == null) {
    return { variations: [], warnings: ['The AI couldn’t analyse this transcript — please try again.'] }
  }

  op(90, 'Checking the cuts…')
  const out = validateAiVariations(res.raw, words)

  // The model is asked for an exact count; say so rather than silently under-
  // delivering, since the creator picked the number explicitly.
  if (out.variations.length && out.variations.length < count) {
    out.warnings.push(`The AI returned ${out.variations.length} of ${count} — the transcript may not support more.`)
  }
  op(100, 'Done')
  return out
}
