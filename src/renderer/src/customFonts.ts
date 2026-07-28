// Custom user fonts. Lets the user upload a font file (.ttf/.otf/.woff/.woff2),
// registers it as a FontFace so it renders BOTH in the live preview (CSS) and in
// the canvas-baked export (textRender/overlays draw on a main-thread canvas, which
// uses document.fonts), and tracks a chosen DEFAULT text font used for new text +
// captions.
//
// PERSISTENCE is two-tier:
//   • localStorage (data-URL cache) — instant register on reload + offline fallback.
//   • Supabase (per signed-in user) — the font file lives in the private
//     `user-fonts` bucket at `<uid>/<id>.<ext>` and a `user_fonts` row records its
//     family + storage path + default flag. So a creator's fonts follow their
//     ACCOUNT across devices/browsers, not just the one machine.
//
// Every Supabase call is best-effort + guarded: signed-out, unconfigured, offline
// or a quota failure all degrade to the local cache instead of throwing, so the
// upload/preview never breaks.

import { getSupabase, supabaseConfigured } from './cloud/supabase'

const LS_FONTS = 'ec_custom_fonts_v1'
const LS_DEFAULT = 'ec_default_font_v1'
const BUCKET = 'user-fonts'

interface StoredFont {
  family: string
  /** data: URL of the font file (local cache; also used to re-register on reload). */
  dataUrl: string
  /** storage path in the `user-fonts` bucket, when this font is synced to Supabase. */
  path?: string
}

const registered = new Set<string>()
const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((l) => {
    try {
      l()
    } catch {
      /* ignore */
    }
  })
}

/** Subscribe to font-list / default-font changes (returns an unsubscribe). */
export function onCustomFontsChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function readStored(): StoredFont[] {
  try {
    const raw = localStorage.getItem(LS_FONTS)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.filter((f) => f && typeof f.family === 'string' && typeof f.dataUrl === 'string') : []
  } catch {
    return []
  }
}

function writeStored(list: StoredFont[]): boolean {
  try {
    localStorage.setItem(LS_FONTS, JSON.stringify(list))
    return true
  } catch {
    // Quota (fonts can be large) or private mode — keep the in-session FontFace
    // and the Supabase copy, just don't cache locally.
    return false
  }
}

/** Merge a font into the local cache by family (keeps the newest dataUrl/path). */
function upsertStored(font: StoredFont): void {
  const list = readStored().filter((f) => f.family !== font.family)
  writeStored([...list, font])
}

/** Family names of every custom font the user has added. */
export function getCustomFontFamilies(): string[] {
  return readStored().map((f) => f.family)
}

/** The user's chosen default text font (family name), or null for the built-in. */
export function getDefaultFont(): string | null {
  try {
    return localStorage.getItem(LS_DEFAULT) || null
  } catch {
    return null
  }
}

async function register(family: string, src: string): Promise<void> {
  if (registered.has(family)) return
  if (typeof FontFace === 'undefined' || !document.fonts) return
  try {
    const ff = new FontFace(family, `url(${src})`)
    await ff.load()
    document.fonts.add(ff)
    registered.add(family)
  } catch {
    /* a bad/corrupt font just won't render — no red error */
  }
}

function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error || new Error('read failed'))
    r.readAsDataURL(file)
  })
}

// ---- Supabase (per-user) sync ---------------------------------------------

interface FontRow {
  family: string
  path: string
  is_default: boolean
}

/** The signed-in user's id, or null when signed-out / unconfigured. */
async function currentUid(): Promise<string | null> {
  if (!supabaseConfigured()) return null
  try {
    const { data } = await getSupabase().auth.getUser()
    return data.user?.id ?? null
  } catch {
    return null
  }
}

/** Upload a font file to the user's private bucket + upsert its metadata row.
 *  Returns the storage path, or null if it couldn't be saved remotely. */
async function uploadToSupabase(family: string, file: File): Promise<string | null> {
  const uid = await currentUid()
  if (!uid) return null
  try {
    const sb = getSupabase()
    const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] || 'ttf').toLowerCase()
    const path = `${uid}/${crypto.randomUUID()}.${ext}`
    const { error: upErr } = await sb.storage
      .from(BUCKET)
      .upload(path, file, { contentType: file.type || `font/${ext}`, upsert: false })
    if (upErr) {
      console.warn('[fonts] upload failed:', upErr.message)
      return null
    }
    // One row per (user, family): re-importing the same name replaces the path.
    const { error: rowErr } = await sb
      .from('user_fonts')
      .upsert({ user_id: uid, family, path }, { onConflict: 'user_id,family' })
    if (rowErr) {
      console.warn('[fonts] metadata upsert failed:', rowErr.message)
      return null
    }
    return path
  } catch (e) {
    console.warn('[fonts] supabase save error:', (e as Error).message)
    return null
  }
}

/** Pull the signed-in user's fonts from Supabase, register + cache any that
 *  aren't here yet, and adopt their saved default. Best-effort; no-op when
 *  signed-out. Call on editor startup so fonts follow the account. */
export async function syncFontsFromSupabase(): Promise<void> {
  const uid = await currentUid()
  if (!uid) return
  try {
    const sb = getSupabase()
    const { data, error } = await sb.from('user_fonts').select('family, path, is_default')
    if (error || !data) return
    const rows = data as FontRow[]
    const haveDataUrl = new Set(readStored().map((f) => f.family))
    let changed = false
    for (const row of rows) {
      if (haveDataUrl.has(row.family)) {
        // Already cached locally — just make sure the FontFace is live + path known.
        const cached = readStored().find((f) => f.family === row.family)
        if (cached) {
          await register(row.family, cached.dataUrl)
          if (cached.path !== row.path) {
            upsertStored({ ...cached, path: row.path })
            changed = true
          }
        }
        continue
      }
      // New to this device: download the file, register it, cache it.
      const { data: blob, error: dlErr } = await sb.storage.from(BUCKET).download(row.path)
      if (dlErr || !blob) continue
      const dataUrl = await fileToDataUrl(blob)
      await register(row.family, dataUrl)
      upsertStored({ family: row.family, dataUrl, path: row.path })
      changed = true
    }
    // Adopt the account's default font (only if the user hasn't set one locally).
    const def = rows.find((r) => r.is_default)?.family
    if (def && getDefaultFont() == null) {
      try {
        localStorage.setItem(LS_DEFAULT, def)
      } catch {
        /* ignore */
      }
      changed = true
    }
    if (changed) notify()
  } catch (e) {
    console.warn('[fonts] supabase sync error:', (e as Error).message)
  }
}

/** Register every locally-cached custom font, then pull any newer ones from the
 *  user's Supabase account. Call once on editor startup. */
export async function loadStoredFonts(): Promise<void> {
  const list = readStored()
  if (list.length) await Promise.all(list.map((f) => register(f.family, f.dataUrl)))
  notify()
  // Cross-device: fetch the account's fonts (fire-and-forget; guarded inside).
  void syncFontsFromSupabase()
}

/** Read + register + persist an uploaded font file. Registers immediately (so the
 *  preview + export can use it this session), caches it locally, and saves it to
 *  the user's Supabase account in the background. Returns the family name to
 *  assign to a clip (unique, derived from the file name). */
export async function addCustomFont(file: File): Promise<string> {
  const base = (file.name.replace(/\.[^.]+$/, '') || 'Custom Font').replace(/[_-]+/g, ' ').trim() || 'Custom Font'
  const taken = new Set(getCustomFontFamilies())
  let family = base
  let i = 2
  while (taken.has(family)) family = `${base} ${i++}`
  const dataUrl = await fileToDataUrl(file)
  await register(family, dataUrl)
  upsertStored({ family, dataUrl })
  notify()
  // Save to the account in the background — the local copy already renders.
  void uploadToSupabase(family, file).then((path) => {
    if (path) upsertStored({ family, dataUrl, path })
  })
  return family
}

export function setDefaultFont(family: string): void {
  try {
    localStorage.setItem(LS_DEFAULT, family)
  } catch {
    /* ignore */
  }
  notify()
  // Persist the choice on the account: mark this family default, clear the rest.
  void (async () => {
    const uid = await currentUid()
    if (!uid) return
    try {
      const sb = getSupabase()
      await sb.from('user_fonts').update({ is_default: false }).eq('user_id', uid).neq('family', family)
      await sb.from('user_fonts').update({ is_default: true }).eq('user_id', uid).eq('family', family)
    } catch {
      /* best-effort */
    }
  })()
}

/** Remove a custom font (from the local cache + the user's Supabase account). The
 *  FontFace stays registered for the session so any clip already using it keeps
 *  rendering. */
export function removeCustomFont(family: string): void {
  const row = readStored().find((f) => f.family === family)
  writeStored(readStored().filter((f) => f.family !== family))
  if (getDefaultFont() === family) {
    try {
      localStorage.removeItem(LS_DEFAULT)
    } catch {
      /* ignore */
    }
  }
  notify()
  void (async () => {
    const uid = await currentUid()
    if (!uid) return
    try {
      const sb = getSupabase()
      if (row?.path) await sb.storage.from(BUCKET).remove([row.path])
      await sb.from('user_fonts').delete().eq('user_id', uid).eq('family', family)
    } catch {
      /* best-effort */
    }
  })()
}
