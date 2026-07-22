// Bridge to the native `EcNativeExport` Capacitor plugin (Android, Media3
// Transformer — hardware-codec trim + concatenate). Present only in the bundled
// Android app; reports unavailable everywhere else (browser / desktop) so callers
// can fall back to the WebCodecs export path.
//
// v1 native scope: cut-only base source (trim + concat). Overlays / text / speed /
// Ken Burns keep the WebCodecs path — the caller decides which to use.

export interface NativeSegment {
  /** file path or content:// URI the native side can read. */
  uri: string
  startMs: number
  endMs: number
}

export interface NativeExportResult {
  /** cache-file path of the encoded mp4. */
  path: string
  /** user-facing gallery location it was published to (e.g. Movies/EaseCutPro/…). */
  savedTo?: string
  durationMs?: number
}

interface EcNativeExportPlugin {
  ping(): Promise<{ ok: boolean }>
  export(opts: { segments: NativeSegment[]; filename?: string }): Promise<NativeExportResult>
}

interface CapGlobal {
  isNativePlatform?: () => boolean
  Plugins?: { EcNativeExport?: EcNativeExportPlugin }
}

function cap(): CapGlobal | undefined {
  return (window as unknown as { Capacitor?: CapGlobal }).Capacitor
}

/** Synchronous best-effort: is the native app + plugin present? */
export function hasNativeExport(): boolean {
  const c = cap()
  return !!(c?.isNativePlatform?.() && c.Plugins?.EcNativeExport)
}

/** Confirm the native module actually answers (round-trips through the bridge). */
export async function nativeExportReady(): Promise<boolean> {
  const plug = cap()?.Plugins?.EcNativeExport
  if (!plug) return false
  try {
    return !!(await plug.ping()).ok
  } catch {
    return false
  }
}

/** Run a native hardware-codec trim+concat export. Resolves with the output path
 *  and the gallery location it was saved to. */
export async function nativeExport(
  segments: NativeSegment[],
  filename?: string
): Promise<NativeExportResult> {
  const plug = cap()?.Plugins?.EcNativeExport
  if (!plug) throw new Error('native export is not available on this platform')
  return plug.export({ segments, filename })
}
