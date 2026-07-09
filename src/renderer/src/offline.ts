// Offline capability probe.
//
// Manual timeline editing (import, split, trim, delete, move, apply cuts,
// preview) and the on-device WebCodecs export run ENTIRELY in the browser and
// need no server — only transcription and the AI cut engines (FastCut / ProCut /
// Retake β / Smart Smooth / overlays / VAD silence) call the backend. This probe
// lets the app (notably the Capacitor Android build) boot and edit with no
// connection, and gate the server-only features gracefully instead of hanging on
// the login screen or throwing raw fetch errors.
import { IS_WEB } from './platform'

/** Is the EaseCutPro backend reachable right now?
 *  - Electron (window.api present) is always "available" — its API is local.
 *  - Web: a short-timeout ping to the PUBLIC /api/ping (unauthenticated + instant).
 *    NOT /api/toolStatus — that's auth-gated AND shells out to ffmpeg/whisper, so it
 *    401s / times out for a fresh session over the tunnel and reads as offline. */
export async function probeServer(timeoutMs = 6000): Promise<boolean> {
  if (!IS_WEB) return true
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch('/api/ping', { signal: ctl.signal, credentials: 'include', cache: 'no-store' })
    return r.ok
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}
