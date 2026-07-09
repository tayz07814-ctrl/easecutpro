// Supabase client for the cloud build (Vercel static frontend, no PC server).
// Configured entirely from Vite env vars; the anon key is public by design —
// all authority lives in RLS policies and the edge functions' JWT check.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

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
 *  function's own error message (not a generic HTTP code) when it fails. */
export async function invokeEdge<T>(name: string, body: unknown): Promise<T> {
  const { data, error } = await getSupabase().functions.invoke(name, { body: body as Record<string, unknown> })
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
