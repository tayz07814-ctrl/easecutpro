// Cloud build settings sync — the app keeps reading/writing its ec.* keys in
// localStorage exactly as before; this module mirrors them into the per-user
// user_settings row so settings follow the account across devices (and future
// mobile apps). Boot: server values are applied locally. After that: any ec.*
// write marks the snapshot dirty and a debounced push upserts the whole set.
import { getSupabase, supabaseConfigured } from './supabase'

const PREFIX = 'ec.'
const PUSH_DEBOUNCE_MS = 2000

let dirty = false
let pulling = false
let timer: ReturnType<typeof setTimeout> | null = null
let installed = false

function snapshot(): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && k.startsWith(PREFIX)) out[k] = localStorage.getItem(k) ?? ''
  }
  return out
}

async function push(): Promise<void> {
  if (!dirty) return
  dirty = false
  try {
    const { data } = await getSupabase().auth.getSession()
    if (!data.session) return
    await getSupabase()
      .from('user_settings')
      .upsert({ user_id: data.session.user.id, data: snapshot() }, { onConflict: 'user_id' })
  } catch {
    dirty = true // retry on the next change/flush
  }
}

function markDirty(): void {
  if (pulling) return // server->local writes must not echo straight back up
  dirty = true
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void push(), PUSH_DEBOUNCE_MS)
}

// NOTE: the store reads its ec.* keys at module init, so values pulled here
// take full effect on the NEXT load — settings converge across devices one
// reload behind, which is fine for keybinds/prefs.
async function pull(): Promise<void> {
  pulling = true
  try {
    const { data, error } = await getSupabase().from('user_settings').select('data').maybeSingle()
    if (error || !data?.data) return
    for (const [k, v] of Object.entries(data.data as Record<string, string>)) {
      if (k.startsWith(PREFIX) && typeof v === 'string') localStorage.setItem(k, v)
    }
  } catch {
    /* offline — local values stand */
  } finally {
    pulling = false
  }
}

/** Install once at cloud boot. Uses auth state changes so login/logout need no
 *  extra wiring; the localStorage write hook is how we see the store's existing
 *  direct `localStorage.setItem('ec.…')` calls without touching them. */
export function initSettingsSync(): void {
  if (installed || !supabaseConfigured()) return
  installed = true

  // Storage objects turn own-property assignment into items (per spec), so the
  // only safe interception point is the prototype.
  const origSet = Storage.prototype.setItem
  Storage.prototype.setItem = function (k: string, v: string) {
    origSet.call(this, k, v)
    if (this === window.localStorage && k.startsWith(PREFIX)) markDirty()
  }
  const origRemove = Storage.prototype.removeItem
  Storage.prototype.removeItem = function (k: string) {
    origRemove.call(this, k)
    if (this === window.localStorage && k.startsWith(PREFIX)) markDirty()
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void push()
  })

  getSupabase().auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') void pull()
  })
}
