// Cloud Cowork — R2 presigned-URL minter.
//
// Given a signed-in member of a space, returns a short-lived presigned PUT
// (upload) or GET (download) URL for an object under that space's prefix in the
// private Cloudflare R2 bucket. R2 credentials live ONLY in this function's env
// (Deno.env) — never in the client bundle. Enforces space membership on every
// call and the per-space storage quota on counted uploads (raw media).
//
// Required secrets (supabase secrets set ...):
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
// Optional (enables the write-budget gateway):
//   R2_UPLOAD_WORKER, R2_TICKET_SECRET

import { createClient } from 'npm:@supabase/supabase-js@2'
import { AwsClient } from 'https://esm.sh/aws4fetch@1.0.20'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}
function preflight(req: Request): Response | null {
  return req.method === 'OPTIONS' ? new Response('ok', { headers: corsHeaders }) : null
}

interface Req {
  op: 'put' | 'get'
  spaceId: string
  /** Key RELATIVE to the space prefix, e.g. `projects/<id>/media/<mid>` or
   *  `projects/<id>/edits/<uid>.json`. Always resolved under spaces/<spaceId>/. */
  key: string
  /** Byte length of the object (op:put) — used for the quota check. */
  contentLength?: number
  /** True for raw media that counts against the 100 GB space quota; false/omitted
   *  for tiny edit-JSON files. */
  countsToQuota?: boolean
}

/** Hard ceiling per object, independent of the space quota. */
const MAX_OBJECT_BYTES = 5 * 1024 * 1024 * 1024

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** `<base64url(payload)>.<base64url(hmac)>` — verified by the Worker with the
 *  same secret, so the hot upload path needs no database round-trip. */
async function mintTicket(payload: Record<string, unknown>, secret: string): Promise<string> {
  const p = b64url(new TextEncoder().encode(JSON.stringify(payload)))
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(p)))
  return `${p}.${b64url(sig)}`
}

Deno.serve(async (req: Request) => {
  const pf = preflight(req)
  if (pf) return pf
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  let body: Req
  try {
    body = (await req.json()) as Req
  } catch {
    return json({ error: 'invalid JSON' }, 400)
  }
  const { op, spaceId, key } = body
  if ((op !== 'put' && op !== 'get') || !spaceId || !key) {
    return json({ error: 'op (put|get), spaceId and key are required' }, 400)
  }
  // Sanitize the relative key: no traversal, no absolute paths — everything stays
  // under spaces/<spaceId>/, so a member can never reach another space's objects.
  const clean = String(key).replace(/^[/]+/, '')
  if (!clean || clean.includes('..') || clean.length > 512) return json({ error: 'invalid key' }, 400)

  // Caller identity from the JWT.
  const url = Deno.env.get('SUPABASE_URL')!
  const anon = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }
  })
  const { data: udata } = await anon.auth.getUser()
  const uid = udata.user?.id
  if (!uid) return json({ error: 'not signed in' }, 401)

  // Authoritative membership + quota checks via the service role.
  const svc = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { data: mem } = await svc
    .from('space_members')
    .select('id')
    .eq('space_id', spaceId)
    .eq('user_id', uid)
    .maybeSingle()
  let member = !!mem
  if (!member) {
    const { data: owned } = await svc.from('spaces').select('id').eq('id', spaceId).eq('owner_id', uid).maybeSingle()
    member = !!owned
  }
  if (!member) return json({ error: 'not a member of this space' }, 403)

  // R2 config (server-only).
  // .trim() defends against a trailing newline/space in a pasted secret (which
  // otherwise corrupts the SigV4 Authorization header and R2 rejects the request).
  const account = Deno.env.get('R2_ACCOUNT_ID')?.trim()
  const accessKeyId = Deno.env.get('R2_ACCESS_KEY_ID')?.trim()
  const secretAccessKey = Deno.env.get('R2_SECRET_ACCESS_KEY')?.trim()
  const bucket = Deno.env.get('R2_BUCKET')?.trim()
  if (!account || !accessKeyId || !secretAccessKey || !bucket) {
    return json(
      { error: 'R2 is not configured on the server — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET' },
      500
    )
  }

  const fullKey = `spaces/${spaceId}/${clean}`

  // Per-space storage quota, reserved in the SERVER-OWNED ledger.
  //
  // This used to sum space_projects.media_bytes — a column the client writes
  // (cowork.ts updates it after each upload, and RLS lets any editor member do
  // it). So the quota asked the uploader how much they'd uploaded. Upload 10 TB,
  // skip the update, quota reads zero. space_objects has no client-facing RLS
  // policy at all, so only this function can move the number, and the reserve is
  // done inside a single SQL function so two concurrent uploads can't both read
  // the same "used" value and both pass.
  if (op === 'put' && body.countsToQuota) {
    const add = Math.min(MAX_OBJECT_BYTES, Math.max(0, Number(body.contentLength) || 0))
    const { error: qErr } = await svc.rpc('space_reserve_object', {
      p_space: spaceId,
      p_key: fullKey,
      p_bytes: add
    })
    if (qErr) {
      if ((qErr.message || '').includes('quota_exceeded')) {
        const { data: used } = await svc.rpc('space_used_bytes', { p_space: spaceId })
        const { data: sp } = await svc.from('spaces').select('quota_bytes').eq('id', spaceId).maybeSingle()
        return json({ error: 'quota_exceeded', used: Number(used ?? 0), quota: Number(sp?.quota_bytes ?? 0), need: add }, 413)
      }
      return json({ error: 'could not reserve storage', detail: qErr.message }, 500)
    }
  }

  // WRITES go through the upload Worker when it is configured. A presigned PUT
  // cannot be made single-use, so one mint is an unlimited-replay licence for
  // its whole lifetime — and because overwriting a key is storage-neutral, no
  // byte quota can ever notice. Routing writes through the Worker puts us on
  // the path of every single one, which is the only place a per-write budget
  // can actually be enforced. The Worker owns the counter; this function keeps
  // owning identity, membership and the storage quota, and hands over a signed
  // ticket saying "this user may write this key, up to this many bytes".
  const workerUrl = Deno.env.get('R2_UPLOAD_WORKER')?.trim()
  const ticketSecret = Deno.env.get('R2_TICKET_SECRET')?.trim()
  if (op === 'put' && workerUrl && ticketSecret) {
    const maxBytes = Math.min(
      MAX_OBJECT_BYTES,
      Math.max(1, Number(body.contentLength) || MAX_OBJECT_BYTES)
    )
    const ticket = await mintTicket({ u: uid, k: fullKey, m: maxBytes, e: Math.floor(Date.now() / 1000) + 300 }, ticketSecret)
    return json({ mode: 'worker', url: workerUrl.replace(/\/+$/, ''), ticket, key: fullKey, maxBytes }, 200)
  }

  const aws = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' })
  const endpoint = new URL(`https://${account}.r2.cloudflarestorage.com/${bucket}/${fullKey}`)
  // 60s, not an hour: until the Worker is deployed this URL is replayable for
  // its whole life, so its life is the blast radius. A presigned URL's expiry is
  // checked when the request STARTS, so a slow upload is unaffected.
  endpoint.searchParams.set('X-Amz-Expires', op === 'put' ? '60' : '300')
  const signed = await aws.sign(endpoint.toString(), { method: op === 'put' ? 'PUT' : 'GET', aws: { signQuery: true } })

  return json({ mode: 'presigned', url: signed.url, key: fullKey }, 200)
})
