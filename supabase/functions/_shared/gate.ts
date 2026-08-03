// Shared server-side gate for every edge function that spends money.
//
// Three jobs, in this order:
//   1. requireUser — resolve the caller's id from their JWT, never from the body
//   2. readBody    — parse JSON under a hard byte cap, so a giant payload can't
//                    be turned into a giant provider bill
//   3. chargeAi    — charge the caller's allowance BEFORE the provider call, and
//                    FAIL CLOSED when the ledger can't be reached
//
// Fail-closed is the whole point. The STT gate this replaces skipped the charge
// whenever the RPC errored (`if (!gate.error && ...)`), which made breaking the
// ledger the cheapest way to get unlimited AI.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { json } from './http.ts'

export function serviceClient(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
}

/** The caller's user id, or null when the JWT is missing/invalid. */
export async function requireUser(req: Request): Promise<string | null> {
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth) return null
  const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } }
  })
  const { data } = await anon.auth.getUser()
  return data.user?.id ?? null
}

/** Payload ceiling: roomy enough for a feature-length transcript map, small
 *  enough that nobody can push megabytes of prompt into a per-token model. */
export const MAX_BODY_BYTES = 1_000_000

class PayloadTooLarge extends Error {}

export async function readBody(
  req: Request,
  maxBytes = MAX_BODY_BYTES
): Promise<Record<string, unknown>> {
  // Cheap rejection first, so an honest-but-huge request never gets buffered.
  const declared = Number(req.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) throw new PayloadTooLarge()

  const raw = await req.text()
  // Bytes, not code units — a multibyte transcript must not slip past the cap.
  if (new TextEncoder().encode(raw).length > maxBytes) throw new PayloadTooLarge()

  try {
    const v = JSON.parse(raw || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export type Charge = { ok: true } | { ok: false; res: Response }

/** Charge `credits` against the caller's daily allowance. Fails CLOSED: an
 *  unreachable ledger refuses the work rather than handing out a free call. */
export async function chargeAi(
  service: SupabaseClient,
  userId: string,
  credits: number
): Promise<Charge> {
  const { data, error } = await service.rpc('charge_ai_credits', {
    p_user: userId,
    p_credits: Math.max(1, Math.floor(credits))
  })
  if (error) {
    console.error('charge_ai_credits failed:', error.message)
    return { ok: false, res: json({ error: 'metering_unavailable' }, 503) }
  }
  const g = data as { allowed?: boolean; used?: number; limit?: number } | null
  if (!g || g.allowed !== true) {
    return {
      ok: false,
      res: json({ error: 'credit_limit', used: g?.used ?? 0, limit: g?.limit ?? 0 }, 402)
    }
  }
  return { ok: true }
}

export type Gated = { userId: string; body: Record<string, unknown> }

/** requireUser + readBody + chargeAi in one call, so wiring a function up is a
 *  two-line change. Either the caller's id and parsed body, or the Response to
 *  return immediately. */
export async function gate(
  req: Request,
  credits: number,
  maxBytes = MAX_BODY_BYTES
): Promise<{ ok: true; ctx: Gated } | { ok: false; res: Response }> {
  const userId = await requireUser(req)
  if (!userId) return { ok: false, res: json({ error: 'Not signed in' }, 401) }

  let body: Record<string, unknown>
  try {
    body = await readBody(req, maxBytes)
  } catch {
    return { ok: false, res: json({ error: 'payload_too_large' }, 413) }
  }

  const charged = await chargeAi(serviceClient(), userId, credits)
  if (!charged.ok) return { ok: false, res: charged.res }
  return { ok: true, ctx: { userId, body } }
}

// ---------------------------------------------------------------------------
// STT metering — minutes, not credits
// ---------------------------------------------------------------------------

/** Free-tier STT minutes, read from the SERVER's env and never from the request
 *  body (the old gate took this from the client, so sending freeMin:0 bought
 *  unlimited transcription). Unset/0 keeps the beta behaviour: free = unlimited. */
export function freeSttMinutes(): number {
  const n = Math.floor(Number(Deno.env.get('FREE_STT_MINUTES') ?? '0'))
  return Number.isFinite(n) && n > 0 ? n : 0
}

export async function chargeSttSeconds(
  service: SupabaseClient,
  userId: string,
  seconds: number
): Promise<Charge> {
  const { data, error } = await service.rpc('consume_ai_seconds', {
    p_user: userId,
    p_seconds: Math.max(0, Math.ceil(seconds)),
    p_free_min: freeSttMinutes()
  })
  if (error) {
    console.error('consume_ai_seconds failed:', error.message)
    return { ok: false, res: json({ error: 'metering_unavailable' }, 503) }
  }
  const g = data as { allowed?: boolean; used_seconds?: number; limit_minutes?: number } | null
  if (!g || g.allowed !== true) {
    return {
      ok: false,
      res: json(
        {
          error: 'minute_limit',
          used_seconds: g?.used_seconds ?? 0,
          limit_minutes: g?.limit_minutes ?? 0
        },
        402
      )
    }
  }
  return { ok: true }
}

export { wavSeconds } from './wav.ts'

/** Fetch just enough of a signed URL to measure the audio, without pulling the
 *  whole object through the function. */
export async function wavSecondsFromUrl(url: string): Promise<number | null> {
  const r = await fetch(url, { headers: { Range: 'bytes=0-8191' } })
  if (!r.ok) return null
  const head = new Uint8Array(await r.arrayBuffer())

  // "bytes 0-8191/1234567" on a ranged reply; otherwise the server sent it all.
  const total = Number((r.headers.get('content-range') ?? '').split('/')[1] ?? '')
  const totalBytes = Number.isFinite(total) && total > 0 ? total : head.length
  return wavSeconds(head, totalBytes)
}
