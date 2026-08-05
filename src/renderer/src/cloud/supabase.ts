// Supabase client for the cloud build (Vercel static frontend, no PC server).
// Configured entirely from Vite env vars; the anon key is public by design —
// all authority lives in RLS policies and the edge functions' JWT check.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { IS_WEB } from '../platform'

export function supabaseConfigured(): boolean {
  return !!(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY)
}

let client: SupabaseClient | null = null

export function getSupabase(): SupabaseClient {
  if (!client) {
    const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
    if (!url || !key) {
      throw new Error('Cloud backend is not configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.')
    }
    client = createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    })
  }
  return client
}

/** Call an edge function with the signed-in user's JWT. Throws with the
 *  function's own error message (not a generic HTTP code) when it fails.
 *
 *  TRANSPORT: same-origin first. `/edge/<fn>` is a vercel.json rewrite that
 *  proxies to the Supabase functions host, so the browser sees a first-party
 *  request — no CORS preflight and nothing for ad/privacy blockers to cancel.
 *  (Several filter lists silently kill cross-origin `/functions/v1/` POSTs
 *  right after their preflight; the server logs an orphan OPTIONS and the app
 *  dies with "Failed to send a request to the Edge Function".) Environments
 *  without the rewrite (vite dev without the proxy, self-host, static preview)
 *  return non-JSON there, and we fall back to the original direct supabase-js
 *  call. A real function error (JSON, any status) NEVER falls back — the same
 *  request is not sent twice. */
export async function invokeEdge<T>(name: string, body: unknown): Promise<T> {
  const sb = getSupabase()
  // Same auth supabase-js functions.invoke attaches: user JWT when signed in
  // (getSession refreshes an expired token), anon key otherwise.
  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string
  let token = anon
  try {
    token = (await sb.auth.getSession()).data.session?.access_token || anon
  } catch {
    /* signed out — anon key */
  }
  let res: Response | null = null
  // Electron (desktop-cloud hybrid) has no /edge rewrite — a same-origin POST
  // would just 404 against the bundled files. Go straight to the direct call.
  if (IS_WEB) {
    try {
      res = await fetch(`/edge/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, apikey: anon },
        body: JSON.stringify(body ?? {})
      })
      // The functions only ever produce JSON (shared http.ts). Anything else
      // means the rewrite isn't in front of us (SPA index.html, host 404/504).
      if (!res.headers.get('content-type')?.includes('application/json')) res = null
    } catch {
      res = null // transport failed (offline/blocked/no rewrite) — direct call below
    }
  }
  if (res) {
    const detail = await res.json().catch(() => null)
    if (!res.ok) throw new Error(detail?.error || detail?.message || `${name} failed`)
    return detail as T
  }
  // Fallback: the original direct supabase-js transport.
  const { data, error } = await sb.functions.invoke(name, { body: body as Record<string, unknown> })
  if (error) {
    // FunctionsHttpError carries the Response — surface the function's message.
    const ctx = (error as { context?: Response }).context
    if (ctx && typeof ctx.json === 'function') {
      const detail = await ctx.json().catch(() => null)
      throw new Error(detail?.error || detail?.message || error.message || `${name} failed`)
    }
    throw new Error(error.message || `${name} failed`)
  }
  return data as T
}
