/**
 * Anthropic (Claude) client + API-key resolution for the Smart Cut engine.
 * Mirrors openai.ts: the key is read from process.env.ANTHROPIC_API_KEY or any
 * local *.env file (e.g. openaiapikey.env). Kept Electron-free for the web server.
 *
 * Only a FOUND key is cached, so a key added to .env while the server is already
 * running is picked up on the next call without a restart.
 */
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import Anthropic from '@anthropic-ai/sdk'

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const eq = s.indexOf('=')
    if (eq < 0) continue
    const k = s.slice(0, eq).trim().toUpperCase()
    let v = s.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (k) out[k] = v
  }
  return out
}

/** Looks like an Anthropic key (sk-ant-...). */
function looksLikeKey(s: string): boolean {
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(s)
}

function scanDirForKey(dir: string): string | null {
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return null
  }
  const cands = files.filter((f) => /\.env(\.|$)/i.test(f) || /^anthropic.*\.(key|txt)$/i.test(f))
  for (const f of cands) {
    try {
      const text = readFileSync(join(dir, f), 'utf8')
      const assigned = parseEnvFile(text).ANTHROPIC_API_KEY?.trim()
      if (assigned) return assigned
      const bare = text.trim()
      if (looksLikeKey(bare)) return bare
      // Tolerate a pasted snippet (curl/JSON example) that EMBEDS the key.
      const m = text.match(/sk-ant-[A-Za-z0-9_-]{20,}/)
      if (m) return m[0]
    } catch {
      /* ignore */
    }
  }
  return null
}

let cachedKey: string | null = null

export function resolveAnthropicKey(): string | null {
  if (cachedKey) return cachedKey
  const fromEnv = process.env.ANTHROPIC_API_KEY?.trim()
  if (fromEnv) return (cachedKey = fromEnv)
  const dirs = [
    process.cwd(),
    join(process.cwd(), '..'),
    process.resourcesPath || '',
    process.resourcesPath ? join(process.resourcesPath, '..') : ''
  ].filter(Boolean)
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    const k = scanDirForKey(dir)
    if (k) return (cachedKey = k)
  }
  return null // not found — don't cache, so a later-added key is picked up
}

/** True when an Anthropic key is configured (Claude Smart Cut usable). */
export function claudeAvailable(): boolean {
  return resolveAnthropicKey() != null
}

let client: Anthropic | null = null

/** Shared Anthropic client; throws if no key. */
export function getAnthropic(): Anthropic {
  const key = resolveAnthropicKey()
  if (!key) throw new Error('Anthropic API key not found. Add ANTHROPIC_API_KEY=sk-ant-... to a *.env file, then retry.')
  if (!client) client = new Anthropic({ apiKey: key })
  return client
}
