// Tiny platform shim so the same renderer runs in Electron and in the browser.
// In Electron the preload exposes window.api and media streams over the custom
// `ecmedia://` protocol; in the browser the server exposes the same API over
// HTTP and streams media from `/media`.

import { isWebMediaId, localUrl } from './webmedia'

// Web = no Electron preload. The preload's contextBridge exposes window.api
// BEFORE any page script runs, so its absence is definitive — unlike UA
// sniffing, which broke inside any Electron-shelled browser (their UAs carry
// "Electron" even when loading the site over plain HTTP).
export const IS_WEB =
  typeof window !== 'undefined' && !(window as { api?: unknown }).api

// Cloud build (Vercel static + Supabase, no PC server at all). Baked in at
// build time by vite.config.cloud.ts; always false in Electron and in the
// self-hosted web build.
export const IS_CLOUD = IS_WEB && import.meta.env.VITE_CLOUD === '1'

// Easecut premium redesign, gated behind an opt-in build flag. OFF by default:
// the existing UI ships unchanged unless VITE_NEW_EASECUT_UI=true. When on,
// main.tsx marks <html data-ec-ui="new"> and the scoped design-system CSS
// (design/*.css) applies. Purely presentational — no engine/handler behavior
// depends on this flag.
export const IS_NEW_UI = import.meta.env.VITE_NEW_EASECUT_UI === 'true'

/** Build a playable/streamable URL for a server- or local-side media path. */
export function mediaSrc(p: string): string {
  if (!p) return ''
  // Web local-first: a browser-held file plays from its blob URL (no upload).
  if (isWebMediaId(p)) return localUrl(p)
  return IS_WEB
    ? `/media?p=${encodeURIComponent(p)}`
    : `ecmedia://media/?p=${encodeURIComponent(p)}`
}
