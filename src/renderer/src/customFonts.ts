// Custom user fonts (0.01 mobile). Lets the user upload a font file (.ttf/.otf/
// .woff/.woff2), registers it as a FontFace so it renders BOTH in the live preview
// (CSS) and in the canvas-baked export (textRender/overlays draw on a main-thread
// canvas, which uses document.fonts), persists it as a data-URL in localStorage so
// it survives reloads, and tracks a chosen DEFAULT text font used for new text +
// captions. Renderer-only (browser APIs); all storage access is try/guarded so a
// private-mode / quota failure degrades quietly instead of throwing.

const LS_FONTS = 'ec_custom_fonts_v1'
const LS_DEFAULT = 'ec_default_font_v1'

interface StoredFont {
  family: string
  /** data: URL of the font file. */
  dataUrl: string
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
    // Quota (fonts can be large) or private mode — keep the in-session FontFace,
    // just don't persist.
    return false
  }
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

export function setDefaultFont(family: string): void {
  try {
    localStorage.setItem(LS_DEFAULT, family)
  } catch {
    /* ignore */
  }
  notify()
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

/** Register every persisted custom font. Call once on editor startup so uploaded
 *  fonts (and the default) survive a reload. */
export async function loadStoredFonts(): Promise<void> {
  const list = readStored()
  if (list.length) await Promise.all(list.map((f) => register(f.family, f.dataUrl)))
  notify()
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error || new Error('read failed'))
    r.readAsDataURL(file)
  })
}

/** Read + register + persist an uploaded font file. Returns the family name to
 *  assign to a clip (unique, derived from the file name). */
export async function addCustomFont(file: File): Promise<string> {
  const base = (file.name.replace(/\.[^.]+$/, '') || 'Custom Font').replace(/[_-]+/g, ' ').trim() || 'Custom Font'
  const taken = new Set(getCustomFontFamilies())
  let family = base
  let i = 2
  while (taken.has(family)) family = `${base} ${i++}`
  const dataUrl = await fileToDataUrl(file)
  await register(family, dataUrl)
  writeStored([...readStored(), { family, dataUrl }])
  notify()
  return family
}

/** Remove a custom font (from storage + the option list). The FontFace stays
 *  registered for the session so any clip already using it keeps rendering. */
export function removeCustomFont(family: string): void {
  writeStored(readStored().filter((f) => f.family !== family))
  if (getDefaultFont() === family) {
    try {
      localStorage.removeItem(LS_DEFAULT)
    } catch {
      /* ignore */
    }
  }
  notify()
}
