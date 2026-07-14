// Gated cutover switch for the new UI. `?newui=1` turns it on and persists;
// `?newui=0` turns it off. Otherwise the persisted choice (localStorage) wins.
// Legacy UI is the default and an instant fallback until the flag is flipped.
export function isNewUi(): boolean {
  try {
    const q = new URLSearchParams(location.search).get('newui')
    if (q === '1') localStorage.setItem('ec.newui', '1')
    else if (q === '0') localStorage.removeItem('ec.newui')
    return localStorage.getItem('ec.newui') === '1'
  } catch {
    return false
  }
}
