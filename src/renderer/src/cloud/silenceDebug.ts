// Silence Mastery debug telemetry (TEST BRANCH). Every Clean Silence run
// writes what the engine SAW and what it DECIDED to public.silence_mastery_debugs
// (insert-only for the client; reviewed via SQL server-side):
//   mode 'stage' — the transcript words, every inter-word gap with its verdict,
//                  the settings, and the regions staged for review.
//   mode 'apply' — the regions the user actually applied + the resulting
//                  project silences and keep ranges.
// Best-effort: a failed insert logs and never breaks the run.

import { getSupabase, supabaseConfigured } from './supabase'
import { IS_CLOUD } from '../platform'

export async function saveSilenceDebug(mode: 'stage' | 'apply', debug: Record<string, unknown>): Promise<void> {
  if (!IS_CLOUD || !supabaseConfigured()) return
  try {
    const { error } = await getSupabase().from('silence_mastery_debugs').insert({ mode, debug })
    if (error) console.warn('[silence-mastery] debug insert failed:', error.message)
    else console.log(`[silence-mastery] debug saved (${mode})`)
  } catch (e) {
    console.warn('[silence-mastery] debug insert error:', (e as Error).message)
  }
}
