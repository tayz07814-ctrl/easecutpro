// Which UI to render.
//
// The new UI is THE product now, so it is the default EVERYWHERE — the product
// domain, the raw *.vercel.app URL, git previews, localhost, self-hosted. It
// used to default on easecutpro.com only, which meant any link that wasn't that
// exact hostname silently served the old UI.
//
// `?newui=0` is still an instant escape hatch to legacy from anywhere, and it
// persists; `?newui=1` comes back. ONLY that explicit opt-out keeps the legacy
// UI — nothing else does.
export function isNewUi(): boolean {
  // The bundled native app (Capacitor) is served from localhost with no query
  // string, and must never be switchable to legacy — force it at build time.
  if (import.meta.env.VITE_FORCE_NEWUI === '1') return true
  // Electron desktop: same situation as Capacitor (fixed URL, no product
  // domain, no address bar to type ?newui=1 into) — the bundled app always
  // ships the new UI. window.api is the standard Electron discriminator.
  if (typeof window !== 'undefined' && !!(window as { api?: unknown }).api) return true
  try {
    const q = new URLSearchParams(location.search).get('newui')
    if (q === '1') localStorage.setItem('ec.newui', '1')
    else if (q === '0') localStorage.setItem('ec.newui', '0')
    return localStorage.getItem('ec.newui') !== '0'
  } catch {
    // Storage blocked (private mode / strict cookie settings) must not drop
    // anyone to the old UI, so fail toward the default.
    return true
  }
}
