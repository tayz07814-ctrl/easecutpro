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

// Desktop-cloud HYBRID: the Electron shell (native ffmpeg media pipeline) with
// the cloud backend compiled in — Supabase sign-in and edge-function AI, same
// as easecutpro.com. Baked by electron.vite.config.ts; never true on the web.
export const IS_DESKTOP_CLOUD = !IS_WEB && import.meta.env.VITE_DESKTOP_CLOUD === '1'

// "Uses the cloud backend" — true for the cloud WEB build and the desktop
// hybrid. Use this (not IS_CLOUD) wherever the question is "do auth/AI/billing
// go through Supabase?" — IS_CLOUD keeps meaning "cloud WEB shell" (no native
// binaries, webmedia-only media).
export const IS_CLOUD_BACKEND = IS_CLOUD || IS_DESKTOP_CLOUD

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
