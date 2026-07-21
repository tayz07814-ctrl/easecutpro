// Creator-facing error masking (beta ship).
//
// When something throws, the on-screen crash box and the status bar must NEVER
// expose internals to a creator: no stack traces, no bundle paths, no backend
// URLs, no provider/model/service names, no tokens. A competitor must not be
// able to learn our stack from an error string. Desktop/self-host keeps the
// full detail (it's the developer's own machine) — masking is gated on IS_CLOUD.
//
// Strategy: a clean, human message that leaks nothing (an auth error, "import a
// video first", the free-trial prompt) is shown as-is. Anything technical or
// leaky is replaced by a stable, opaque code — "please try again (Error
// EC-1A3F7C)" — so the creator gets something to quote to support while the real
// error only ever lives in the console/logs (which we never gate).
//
// One choke point: every user-visible error string goes through safeErrMessage,
// so a new call site can't accidentally leak.

import { IS_CLOUD } from './platform'

// Product/vendor internals that must never surface to a creator. Kept tight to
// real secrets/identifiers so genuinely helpful, non-sensitive text survives.
const CONFIDENTIAL =
  /\b(assembly\s?ai|deepgram|anthropic|claude|opus|sonnet|haiku|openai|gpt|whisper|parakeet|silero|supabase|vercel|procut[-\s]?judge|retake-aware-debugs|stt-audio|service[-_\s]?role)\b/gi

// Patterns that mean the text carries internals (a vendor/model name, a URL, a
// bundle path, a JWT, a stack frame). If any match, we NEVER show the text (not
// even a redacted remnant) — we show an opaque code instead.
const LEAKY: RegExp[] = [
  CONFIDENTIAL,
  /https?:\/\//i, // backend URLs
  /\bfunctions\/v1\//i, // edge-function paths
  /\b[\w./-]+\.(?:jsx?|tsx?|mjs):\d+/i, // bundle:line
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+/, // JWTs
  /(?:\r?\n).*?(?:@|\bat\s)/i, // stack frame ("fn@url" / "at fn (…)")
  /(?=.*\b\d{3}\b)(?=.*\b(?:http|fetch|status|request|error)\b)/i // "HTTP 502", "status 400", "502 … request"
]

function hasInternals(text: string): boolean {
  return LEAKY.some((re) => {
    re.lastIndex = 0 // CONFIDENTIAL is global/stateful — reset before each test
    return re.test(text)
  })
}

/** Strip stack frames, URLs, bundle paths and tokens, and redact confidential
 *  product internals from any text before it reaches a creator's screen. Pure.
 *  Kept as a defensive final pass for text we've already judged "clean". */
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

/** A short, stable, opaque reference for an error. Same input → same code, so a
 *  creator can quote it to support and we can find the real error in the logs.
 *  Reveals nothing about the stack, the vendors, or what model is being used.
 *  FNV-1a (deterministic; no Date/Math.random so it's reproducible). */
export function errorCode(e: unknown): string {
  const raw = (e as Error)?.message ?? String(e ?? '')
  let h = 0x811c9dc5
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return 'EC-' + (h >>> 0).toString(16).toUpperCase().padStart(8, '0').slice(-6)
}

// --- Free-trial limit: an expected event, not a failure ---
export const TRIAL_LIMIT_MESSAGE = 'You’ve used all your free AI runs — upgrade to keep editing.'

/** Thrown when a free-trial user is out of AI runs. Carries a `code` so any
 *  layer can recognise it and treat it as an upgrade prompt, not a crash. */
export class TrialLimitError extends Error {
  readonly code = 'trial_limit'
  constructor(message: string = TRIAL_LIMIT_MESSAGE) {
    super(message)
    this.name = 'TrialLimitError'
  }
}

/** True for the free-trial-exhausted signal, whether it arrives as the typed
 *  error or the raw `trial_limit` string the edge function returns. */
export function isTrialLimit(e: unknown): boolean {
  return (e as { code?: string })?.code === 'trial_limit' || (e as Error)?.message === 'trial_limit'
}

/** An error message safe to show a creator: the raw message on desktop/self-host;
 *  in the cloud ship, a clean human message as-is, or an opaque code if the text
 *  is technical/leaky. Use in place of `(e as Error).message` anywhere the text
 *  can reach the screen. */
export function safeErrMessage(e: unknown): string {
  if (isTrialLimit(e)) return TRIAL_LIMIT_MESSAGE
  const raw = (e as Error)?.message || String(e ?? 'Unknown error')
  if (!IS_CLOUD) return raw
  // Anything carrying internals never reaches the screen — show a code instead.
  if (hasInternals(raw)) return `please try again (Error ${errorCode(raw)})`
  // Clean message: defensive final redaction (whitespace, stray remnants). If
  // that guts it, fall back to a code rather than showing a fragment.
  const clean = redactForCreator(raw)
  return clean.length >= 3 ? clean : `please try again (Error ${errorCode(raw)})`
}
