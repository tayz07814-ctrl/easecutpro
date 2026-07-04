// Stable unique ids for timeline entities. Uses crypto.randomUUID when present
// (Electron renderer, Node 20+, modern browsers) and falls back to a
// time+counter+random token. Never collides within a session.

let counter = 0

export function uid(prefix = 'id'): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c && typeof c.randomUUID === 'function') return `${prefix}_${c.randomUUID()}`
  counter = (counter + 1) >>> 0
  const t = Date.now().toString(36)
  const r = Math.floor(Math.random() * 0x7fffffff).toString(36)
  return `${prefix}_${t}${counter.toString(36)}${r}`
}
