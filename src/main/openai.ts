/**
 * OpenAI client + API-key resolution for the optional cloud transcription /
 * AI-cut backends. Kept free of any Electron import so the standalone web
 * server can use it too.
 *
 * The key is NEVER hard-coded or stored in a project. It is read from, in order:
 *   1. process.env.OPENAI_API_KEY
 *   2. a local `.env` file (OPENAI_API_KEY=sk-...) in the project / app dir
 * Drop the key into `.env` (which is git-ignored) and restart.
 */
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import OpenAI from 'openai'

/** Parse a tiny subset of dotenv: KEY=VALUE lines (keys upper-cased), ignoring # / blanks. */
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const eq = s.indexOf('=')
    if (eq < 0) continue
    const k = s.slice(0, eq).trim().toUpperCase()
    let v = s.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    if (k) out[k] = v
  }
  return out
}

/** Looks like a real OpenAI key token (sk-... / sk-proj-...). */
function looksLikeKey(s: string): boolean {
  return /^sk-[A-Za-z0-9_-]{20,}$/.test(s)
}

/**
 * Find an OPENAI_API_KEY in a directory by scanning likely key files.
 * Accepts ANY *.env file (Windows Explorer makes a literal `.env` awkward, so
 * `openaiapikey.env`, `openai.env`, etc. all work), plus openai*.key / .txt.
 * Each file may use `OPENAI_API_KEY=sk-...` OR just contain the bare key.
 */
function scanDirForKey(dir: string): string | null {
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return null
  }
  const cands = files.filter((f) => /\.env(\.|$)/i.test(f) || /^openai.*\.(key|txt)$/i.test(f))
  // Prefer a plain ".env" if present, then the rest.
  cands.sort((a, b) => (a === '.env' ? -1 : b === '.env' ? 1 : a.localeCompare(b)))
  for (const f of cands) {
    try {
      const text = readFileSync(join(dir, f), 'utf8')
      const assigned = parseEnvFile(text).OPENAI_API_KEY?.trim()
      if (assigned) return assigned
      const bare = text.trim()
      if (looksLikeKey(bare)) return bare // file is just the key
    } catch {
      /* ignore unreadable candidate */
    }
  }
  return null
}

let cachedKey: string | null | undefined

/** Resolve the OpenAI API key from a local *.env / key file, else env (cached).

    The PROJECT FILE wins over process.env: other local tools set a global
    OPENAI_API_KEY for themselves (found in the wild: LM Studio's `sk-lm-…`
    user-level variable), and that shadow key silently broke every OpenAI call
    — ProCut's audio pass included. The file in the app folder is this app's
    documented configuration; the env var is only a fallback when no file
    exists. */
export function resolveOpenAIKey(): string | null {
  if (cachedKey !== undefined) return cachedKey
  const fileKey = scanKnownDirs()
  if (fileKey) return (cachedKey = fileKey)
  const fromEnv = process.env.OPENAI_API_KEY?.trim()
  if (fromEnv) return (cachedKey = fromEnv)
  return (cachedKey = null)
}

function scanKnownDirs(): string | null {
  const dirs = [
    process.cwd(),
    join(process.cwd(), '..'),
    process.resourcesPath || '',
    process.resourcesPath ? join(process.resourcesPath, '..') : ''
  ].filter(Boolean)
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    const k = scanDirForKey(dir)
    if (k) return k
  }
  return null
}

/** True when an OpenAI key is available (cloud backends usable). */
export function openaiAvailable(): boolean {
  return resolveOpenAIKey() != null
}

/** A clear, user-facing message for when the key is missing. */
export const NO_KEY_MESSAGE =
  'OpenAI API key not found. Put OPENAI_API_KEY=sk-... in a *.env file (e.g. openaiapikey.env) in the EaseCutPro folder, then restart.'

let client: OpenAI | null = null

/** Get a shared OpenAI client; throws a clear error if no key is configured.

    baseURL is PINNED to the real OpenAI platform: the SDK silently honours an
    OPENAI_BASE_URL environment variable, and a machine-wide one left behind by
    a local-LLM tool (found in the wild: LM Studio's http://127.0.0.1:8875 +
    sk-lm-… key) rerouted every call — whisper, gpt-audio, gpt-5 — to a local
    server that 200-OKs an {error} body. This app only ever talks to OpenAI. */
export function getOpenAI(): OpenAI {
  const key = resolveOpenAIKey()
  if (!key) throw new Error(NO_KEY_MESSAGE)
  if (!client) client = new OpenAI({ apiKey: key, baseURL: 'https://api.openai.com/v1' })
  return client
}
