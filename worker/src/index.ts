// EaseCutPro upload gateway — every R2 WRITE passes through here so it can be
// counted and capped.
//
// WHY THIS EXISTS
// Uploads used to go straight to R2 on a presigned PUT. A presigned URL cannot
// be made single-use, so one mint bought a full hour of unlimited replay: an
// attacker could overwrite the same key a million times, pay nothing, stay
// inside the 100 GB storage quota (overwrites are storage-neutral) and run up
// Class A operation charges indefinitely. No byte-based quota can see that, and
// rate-limiting the MINTS doesn't help either, because one mint is unlimited
// writes. The only way to bound operations is to be on the path of every one.
//
// SHAPE
//   1. client asks Supabase `r2-sign` for an upload TICKET (it owns auth,
//      space membership and the storage quota — none of that moves here)
//   2. client sends the bytes here with that ticket
//   3. this Worker verifies the ticket, charges the user's daily budget, and
//      writes to R2 through a binding
//
// The ticket is HMAC-signed with a secret shared with the edge function, so this
// Worker never needs a database or a Supabase round-trip on the hot path.
//
// Replaying a ticket is allowed and harmless: every replay is charged, so it
// burns the attacker's own daily budget instead of your bill.

export interface Env {
  BUCKET: R2Bucket
  QUOTA: DurableObjectNamespace
  /** Shared with the r2-sign edge function; signs/verifies upload tickets. */
  TICKET_SECRET: string
  /** Writes allowed per user per UTC day. */
  DAILY_WRITE_LIMIT: string
  /** Comma-separated allowed browser origins. */
  ALLOWED_ORIGINS: string
  /** r2-commit edge function URL; unset = ledger rows stay 'reserved'. */
  COMMIT_URL?: string
}

/**
 * Tell the ledger the bytes really landed. Fire-and-forget via waitUntil so the
 * upload response isn't held up by it, and never fatal: a lost commit leaves the
 * row 'reserved', which still counts against the quota for 24 h. Over-counting
 * for a day beats under-counting instantly.
 *
 * This lives in the WORKER, not the client, on purpose. If the browser owned it,
 * an attacker would simply never call it — their rows would age out and their
 * storage would stop counting, which is the hole the ledger exists to close.
 */
function commitLedger(env: Env, ctx: ExecutionContext, ticket: string): void {
  if (!env.COMMIT_URL) return
  ctx.waitUntil(
    fetch(env.COMMIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket })
    }).catch(() => undefined)
  )
}

/** Multipart parts are capped well under the Workers request-body limit (100 MB
 *  free / 500 MB paid) so a single part always fits with headroom. */
const MAX_PART_BYTES = 90 * 1024 * 1024

function cors(env: Env, req: Request): Record<string, string> {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)
  const origin = req.headers.get('Origin') || ''
  const ok = allowed.includes(origin) ? origin : allowed[0] || ''
  return {
    'Access-Control-Allow-Origin': ok,
    'Access-Control-Allow-Headers': 'content-type,x-ec-ticket',
    'Access-Control-Allow-Methods': 'PUT,POST,OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  }
}
function json(env: Env, req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(env, req), 'Content-Type': 'application/json' }
  })
}

// --- ticket ----------------------------------------------------------------

interface Ticket {
  /** Supabase user id — the budget is charged to this. */
  u: string
  /** FULL R2 key, already resolved and validated by the edge function. */
  k: string
  /** Max bytes for this object. */
  m: number
  /** Expiry, epoch seconds. */
  e: number
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : ''
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Constant-time compare — a fast-exit compare leaks the signature byte by byte. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

async function verifyTicket(raw: string, secret: string): Promise<Ticket | null> {
  const dot = raw.lastIndexOf('.')
  if (dot <= 0) return null
  const payloadB64 = raw.slice(0, dot)
  const sigB64 = raw.slice(dot + 1)
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const expected = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64))
  )
  let given: Uint8Array
  try {
    given = b64urlToBytes(sigB64)
  } catch {
    return null
  }
  if (!sameBytes(expected, given)) return null
  let t: Ticket
  try {
    t = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64))) as Ticket
  } catch {
    return null
  }
  if (!t.u || !t.k || typeof t.m !== 'number' || typeof t.e !== 'number') return null
  if (t.e * 1000 < Date.now()) return null
  return t
}

// --- daily budget (Durable Object: one per user, strongly consistent) --------

export class DailyQuota {
  private state: DurableObjectState
  constructor(state: DurableObjectState) {
    this.state = state
  }
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const cost = Math.max(1, Number(url.searchParams.get('n') || '1'))
    const limit = Math.max(1, Number(url.searchParams.get('limit') || '200'))
    // UTC day, so the reset point can't be shifted by the caller's timezone.
    const today = new Date().toISOString().slice(0, 10)
    const rec = (await this.state.storage.get<{ day: string; used: number }>('c')) ?? { day: today, used: 0 }
    if (rec.day !== today) {
      rec.day = today
      rec.used = 0
    }
    if (rec.used + cost > limit) {
      return Response.json({ ok: false, used: rec.used, limit }, { status: 429 })
    }
    // Charged BEFORE the write, so a write that fails or is abandoned still
    // costs the caller. Refunding on failure would hand out a free retry loop.
    rec.used += cost
    await this.state.storage.put('c', rec)
    return Response.json({ ok: true, used: rec.used, limit })
  }
}

/** Charge `cost` writes to a user. Returns null when allowed, or a 429 Response. */
async function charge(env: Env, req: Request, uid: string, cost: number): Promise<Response | null> {
  const limit = Number(env.DAILY_WRITE_LIMIT || '200')
  const id = env.QUOTA.idFromName(uid)
  const res = await env.QUOTA.get(id).fetch(
    `https://quota/take?n=${cost}&limit=${limit}`
  )
  if (res.ok) return null
  const body = (await res.json()) as { used: number; limit: number }
  return json(
    env,
    req,
    {
      error: 'daily_write_limit',
      message: `Daily upload limit reached (${body.limit}). It resets at midnight UTC.`,
      used: body.used,
      limit: body.limit
    },
    429
  )
}

// --- routes -----------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(env, req) })

    const url = new URL(req.url)
    const raw = req.headers.get('x-ec-ticket') || url.searchParams.get('t') || ''
    if (!raw) return json(env, req, { error: 'missing ticket' }, 401)
    const t = await verifyTicket(raw, env.TICKET_SECRET)
    if (!t) return json(env, req, { error: 'bad or expired ticket' }, 401)

    const declared = Number(req.headers.get('content-length') || '0')

    // Single-shot upload: PUT the whole object. One write.
    if (req.method === 'PUT' && url.pathname === '/put') {
      if (declared > t.m) return json(env, req, { error: 'too large for this ticket' }, 413)
      if (declared > MAX_PART_BYTES) return json(env, req, { error: 'use multipart for this size' }, 413)
      const denied = await charge(env, req, t.u, 1)
      if (denied) return denied
      await env.BUCKET.put(t.k, req.body, {
        httpMetadata: { contentType: req.headers.get('x-ec-content-type') || 'application/octet-stream' }
      })
      commitLedger(env, ctx, raw)
      return json(env, req, { ok: true, key: t.k })
    }

    // Multipart: begin. Costs one write on its own so an attacker can't open
    // thousands of uploads for free.
    if (req.method === 'POST' && url.pathname === '/mpu/create') {
      const denied = await charge(env, req, t.u, 1)
      if (denied) return denied
      const mpu = await env.BUCKET.createMultipartUpload(t.k)
      return json(env, req, { uploadId: mpu.uploadId, key: t.k })
    }

    // Multipart: one part. Charged individually — this is what keeps a large
    // upload honest AND makes a flood of parts eat the attacker's own budget.
    if (req.method === 'PUT' && url.pathname === '/mpu/part') {
      const uploadId = url.searchParams.get('uploadId') || ''
      const partNumber = Number(url.searchParams.get('partNumber') || '0')
      if (!uploadId || partNumber < 1) return json(env, req, { error: 'uploadId and partNumber required' }, 400)
      if (declared > MAX_PART_BYTES) return json(env, req, { error: 'part too large' }, 413)
      const denied = await charge(env, req, t.u, 1)
      if (denied) return denied
      const mpu = env.BUCKET.resumeMultipartUpload(t.k, uploadId)
      const part = await mpu.uploadPart(partNumber, req.body!)
      return json(env, req, { partNumber: part.partNumber, etag: part.etag })
    }

    if (req.method === 'POST' && url.pathname === '/mpu/complete') {
      const uploadId = url.searchParams.get('uploadId') || ''
      if (!uploadId) return json(env, req, { error: 'uploadId required' }, 400)
      const { parts } = (await req.json()) as { parts: R2UploadedPart[] }
      const mpu = env.BUCKET.resumeMultipartUpload(t.k, uploadId)
      await mpu.complete(parts)
      commitLedger(env, ctx, raw)
      return json(env, req, { ok: true, key: t.k })
    }

    // Abort is FREE on purpose: cleaning up a failed upload should never be
    // something a user is rationed out of doing.
    if (req.method === 'POST' && url.pathname === '/mpu/abort') {
      const uploadId = url.searchParams.get('uploadId') || ''
      if (!uploadId) return json(env, req, { error: 'uploadId required' }, 400)
      try {
        await env.BUCKET.resumeMultipartUpload(t.k, uploadId).abort()
      } catch {
        /* already gone */
      }
      return json(env, req, { ok: true })
    }

    return json(env, req, { error: 'not found' }, 404)
  }
}
