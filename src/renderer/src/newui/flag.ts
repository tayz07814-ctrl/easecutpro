// Gated cutover switch for the new UI.
//
// - `?newui=1` opts IN and persists; `?newui=0` opts OUT and persists (an instant
//   escape hatch to the legacy UI from anywhere).
// - With no explicit choice, the DEFAULT depends on the domain: the product
//   domain (easecutpro.com + any subdomain) shows the new UI; everywhere else
//   (the raw *.vercel.app URL, git previews, localhost) stays on legacy — so the
//   .vercel.app URL remains a known-good fallback for comparison / rollback.
// An explicit ?newui choice always wins over the domain default.
function onProductDomain(): boolean {
  try {
    return /(^|\.)easecutpro\.com$/i.test(location.hostname)
  } catch {
    return false
  }
}

export function isNewUi(): boolean {
  try {
    const q = new URLSearchParams(location.search).get('newui')
    if (q === '1') localStorage.setItem('ec.newui', '1')
    else if (q === '0') localStorage.setItem('ec.newui', '0')
    const stored = localStorage.getItem('ec.newui')
    if (stored === '1') return true
    if (stored === '0') return false
    return onProductDomain()
  } catch {
    return onProductDomain()
  }
}
