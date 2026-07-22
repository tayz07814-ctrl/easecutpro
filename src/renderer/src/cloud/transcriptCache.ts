// Session transcript cache (cloud build). The verbatim STT transcript of a given
// media never changes, yet Cut Lord / Ultracut / Premium / the Transcribe button
// each re-uploaded the audio to AssemblyAI on EVERY run. We cache the verbatim
// transcript by mediaId so the FIRST run (whichever engine, or Generate Captions)
// transcribes once and every later run reuses it — the STT round-trip is skipped
// and only the on-device audio decode (for VAD) + the LLM judge re-run.
//
// Keyed by mediaId: a re-import or a freshly-combined montage gets a new id, so a
// genuinely different audio never reuses a stale transcript. Session-scoped (clears
// on reload). Cloud-only — the desktop STT path is untouched.
import type { VerbatimTranscript } from '@shared/retakeaware/types'
import type { ProgressFn } from '@shared/retakeaware/engine'
import { transcribeVerbatimCloud } from './stt'

export interface CachedTranscript {
  vt: VerbatimTranscript
  warnings: string[]
}

const cache = new Map<string, CachedTranscript>()

export function getCachedTranscript(mediaId: string): CachedTranscript | undefined {
  return cache.get(mediaId)
}

export function setCachedTranscript(mediaId: string, entry: CachedTranscript): void {
  cache.set(mediaId, entry)
}

/** Transcribe once per media, then reuse. On a cache hit the AssemblyAI/Deepgram
 *  call is skipped entirely (the transcript is returned immediately); on a miss it
 *  transcribes the passed audio and stores the result. */
export async function cachedTranscribe(
  mediaId: string,
  audio: { blob: Blob; ext: string },
  op: ProgressFn
): Promise<CachedTranscript> {
  const hit = cache.get(mediaId)
  if (hit) {
    op(49, 'Reusing transcript…')
    return hit
  }
  const r = await transcribeVerbatimCloud(audio, op)
  cache.set(mediaId, r)
  return r
}
