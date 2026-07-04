// Tiny platform shim so the same renderer runs in Electron and in the browser.
// In Electron the preload exposes window.api and media streams over the custom
// `ecmedia://` protocol; in the browser the server exposes the same API over
// HTTP and streams media from `/media`.

import { isWebMediaId, localUrl } from './webmedia'

export const IS_WEB =
  typeof navigator !== 'undefined' && !/electron/i.test(navigator.userAgent)

/** Build a playable/streamable URL for a server- or local-side media path. */
export function mediaSrc(p: string): string {
  if (!p) return ''
  // Web local-first: a browser-held file plays from its blob URL (no upload).
  if (isWebMediaId(p)) return localUrl(p)
  return IS_WEB
    ? `/media?p=${encodeURIComponent(p)}`
    : `ecmedia://media/?p=${encodeURIComponent(p)}`
}
