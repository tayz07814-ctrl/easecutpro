// Silence Mastery debug telemetry. Every Clean Silence / Find cuts run
// writes what the engine SAW and what it DECIDED to public.silence_mastery_debugs
// (insert-only for the client; reviewed via SQL server-side):
//   mode 'stage' — the transcript words, every inter-word gap with its verdict,
//                  the settings, and the regions staged for review.
//   mode 'apply' — the regions the user actually applied + the resulting
//                  project silences and keep ranges.
// Best-effort: a failed insert logs and never breaks the run.

import { getSupabase, supabaseConfigured } from './supabase'
import { IS_CLOUD_BACKEND, IS_DESKTOP_CLOUD } from '../platform'

export async function saveSilenceDebug(mode: 'stage' | 'apply', debug: Record<string, unknown>): Promise<void> {
  // IS_CLOUD_BACKEND, not IS_CLOUD: the desktop build runs the SAME renderer
  // silence engine and signs in to the same Supabase project, so its runs
  // belong in the same table. Without this the PC build tuned silence blind —
  // and these dumps are what the threshold/breath work is reviewed from.
  if (!IS_CLOUD_BACKEND || !supabaseConfigured()) return
  try {
    // Tag the shell: web and desktop now share this table, and their audio
    // differs (desktop gets a native-ffmpeg 16k WAV, web a browser decode), so
    // a dump is only comparable once you know which produced it.
    const tagged = { ...debug, platform: IS_DESKTOP_CLOUD ? 'desktop' : 'web' }
    const { error } = await getSupabase().from('silence_mastery_debugs').insert({ mode, debug: tagged })
    if (error) console.warn('[silence-mastery] debug insert failed:', error.message)
    else console.log(`[silence-mastery] debug saved (${mode})`)
  } catch (e) {
    console.warn('[silence-mastery] debug insert error:', (e as Error).message)
  }
}
