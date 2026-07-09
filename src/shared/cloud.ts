// Cloud build (Vercel + Supabase) — request/response contracts for the
// Supabase Edge Functions. These are the ONLY shapes the browser and the
// functions agree on; the functions keep a mirrored copy of the comments
// but this file is the source of truth. Shared so future mobile (Capacitor)
// builds reuse the same client layer.

// ---- stt function (supabase/functions/stt) ----
// One action-based endpoint so the whole STT flow is a single function:
//   sign-upload -> client uploads the small extracted AUDIO to the private
//   stt-audio bucket via a signed URL (media itself NEVER goes to Supabase),
//   then aai-start/aai-poll (AssemblyAI, primary) or deepgram (fallback)
//   transcribe from a short-lived signed download URL. cleanup deletes the
//   temp audio object when the run is done.

export interface SttStatusReq {
  action: 'status'
}
export interface SttStatusRes {
  assemblyai: boolean
  deepgram: boolean
}

export interface SttSignUploadReq {
  action: 'sign-upload'
  /** audio container extension: m4a | wav */
  ext: string
}
export interface SttSignUploadRes {
  /** storage object path inside the stt-audio bucket */
  path: string
  /** token for supabase.storage.uploadToSignedUrl */
  token: string
}

export interface SttAaiStartReq {
  action: 'aai-start'
  path: string
}
export interface SttAaiStartRes {
  id: string
}

export interface SttAaiPollReq {
  action: 'aai-poll'
  id: string
}
export interface SttAaiPollRes {
  status: 'queued' | 'processing' | 'completed' | 'error'
  error?: string
  words?: { text: string; start: number; end: number; confidence?: number }[]
  utterances?: { start: number; end: number; text: string }[]
}

export interface SttDeepgramReq {
  action: 'deepgram'
  path: string
}
export interface SttDeepgramRes {
  words: { word: string; punctuated_word?: string; start: number; end: number; confidence?: number }[]
  utterances: { start: number; end: number; transcript: string }[]
}

export interface SttCleanupReq {
  action: 'cleanup'
  path: string
}

export type SttReq =
  | SttStatusReq
  | SttSignUploadReq
  | SttAaiStartReq
  | SttAaiPollReq
  | SttDeepgramReq
  | SttCleanupReq

// ---- llm-judge function (supabase/functions/llm-judge) ----
// JSON-only Retake β reviewer: Anthropic Haiku first, OpenAI gpt-4o-mini
// fallback, judge:'none' when no key is configured. Mirrors
// src/main/retakeaware/llm.ts — the browser parses `raw` with the same
// parseLlmDecisions and degrades to rule-based decisions on any problem.
export interface LlmJudgeReq {
  /** ReviewPayload from src/shared/retakeaware — kept unknown here to avoid a hard coupling */
  payload: unknown
}
export interface LlmJudgeRes {
  raw: string | null
  judge: string
}
