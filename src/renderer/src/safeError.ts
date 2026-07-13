// Creator-facing error masking (beta ship).
//
// When something throws, the on-screen crash box and the status bar must NEVER
// expose internals to a creator: no stack traces, no bundle paths, no backend
// URLs, no provider/model/service names, no tokens. Desktop/self-host keeps the
// full detail (it's the developer's own machine) — masking is gated on IS_CLOUD.
//
// One choke point: every user-visible error string goes through safeErrMessage /
// redactForCreator, so a new call site can't accidentally leak.

import { IS_CLOUD } from './platform'

// Product/vendor internals that must never surface to a creator. Kept tight to
// real secrets/identifiers so genuinely helpful, non-sensitive text survives.
const CONFIDENTIAL =
  /\b(assembly\s?ai|deepgram|anthropic|claude|opus|sonnet|haiku|openai|gpt|whisper|parakeet|silero|supabase|vercel|procut[-\s]?judge|retake-aware-debugs|stt-audio|service[-_\s]?role)\b/gi

/** Strip stack frames, URLs, bundle paths and tokens, and redact confidential
 *  product internals from any text before it reaches a creator's screen. Pure. */
export function redactForCreator(text: string): string {
  return text
    .replace(/(?:\r?\n).*?(?:@|\bat\s).*/gi, '') // stack frames ("fn@url" or "at fn (…)")
    .replace(/https?:\/\/\S+/gi, '') // backend URLs
    .replace(/\bfunctions\/v1\/\S+/gi, '') // edge-function paths
    .replace(/\b[\w./-]+\.(?:jsx?|tsx?|mjs):\d+(?::\d+)?/gi, '') // bundle:line:col
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '') // JWTs
    .replace(CONFIDENTIAL, '…') // vendor/model/service names
    .replace(/\(\s*…?\s*\)/g, '') // empty parens left behind
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** An error message safe to show a creator: the raw message on desktop/self-host,
 *  a redacted (or generic, if redaction guts it) one in the cloud ship. Use in
 *  place of `(e as Error).message` anywhere the text can reach the screen. */
export function safeErrMessage(e: unknown): string {
  const raw = (e as Error)?.message || String(e ?? 'Unknown error')
  if (!IS_CLOUD) return raw
  const red = redactForCreator(raw)
  return red.length >= 6 ? red : 'please try again'
}
