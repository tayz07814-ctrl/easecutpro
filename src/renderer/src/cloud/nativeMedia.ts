// Bridge to the native `EcNativeMedia` Capacitor plugin (Android). It opens the
// platform picker and COPIES each chosen file into an app-private path, returning
// real filesystem paths. Present only in the bundled Android app; reports
// unavailable everywhere else so the web/desktop code falls back to the DOM
// <input> file picker unchanged.
//
// Why a native picker: a browser blob: URL is meaningless to the native encoder
// (Media3) and to a native player. Copying up front both fixes the revoked
// content:// read bug and gives every source a path the native side can open.

export interface NativePickedFile {
  /** absolute filesystem path inside the app sandbox. */
  path: string
  name: string
  mimeType: string
  size: number
}

export type NativePickKind = 'visual' | 'audio' | 'any'

interface EcNativeMediaPlugin {
  ping(): Promise<{ ok: boolean }>
  pick(opts: { kind: NativePickKind }): Promise<{ files: NativePickedFile[] }>
}

interface CapGlobal {
  isNativePlatform?: () => boolean
  convertFileSrc?: (path: string) => string
  Plugins?: { EcNativeMedia?: EcNativeMediaPlugin }
}

function cap(): CapGlobal | undefined {
  return (window as unknown as { Capacitor?: CapGlobal }).Capacitor
}

/** Is the native app + media plugin present? */
export function hasNativeMedia(): boolean {
  const c = cap()
  return !!(c?.isNativePlatform?.() && c.Plugins?.EcNativeMedia)
}

/** Turn an app-private path into a URL the WebView can load in <video>/<img>. */
export function nativeFileUrl(path: string): string {
  const c = cap()
  if (c?.convertFileSrc) return c.convertFileSrc(path)
  return 'file://' + path
}

/** Open the native picker and return the copied files (empty on cancel/failure). */
export async function pickNativeMedia(kind: NativePickKind): Promise<NativePickedFile[]> {
  const plug = cap()?.Plugins?.EcNativeMedia
  if (!plug) return []
  try {
    const res = await plug.pick({ kind })
    return res?.files ?? []
  } catch {
    return []
  }
}
