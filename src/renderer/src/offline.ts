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
 *  - Web: a short-timeout ping to /api/toolStatus. Unreachable = offline
 *    (bundled Capacitor app with no server, dropped network, PC asleep, …). */
export async function probeServer(timeoutMs = 3500): Promise<boolean> {
  if (!IS_WEB) return true
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch('/api/toolStatus', { signal: ctl.signal, credentials: 'include' })
    return r.ok
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}
