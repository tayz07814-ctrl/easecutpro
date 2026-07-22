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

interface PluginListenerHandle {
  remove: () => void | Promise<void>
}

interface EcNativeExportPlugin {
  ping(): Promise<{ ok: boolean }>
  export(opts: { segments: NativeSegment[]; filename?: string }): Promise<NativeExportResult>
  addListener?(
    eventName: 'nativeExportProgress',
    cb: (data: { percent: number }) => void
  ): Promise<PluginListenerHandle> | PluginListenerHandle
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
 *  and the gallery location it was saved to. `onProgress` (0–100) streams the
 *  Media3 encode progress so the export bar moves; it's best-effort (skipped if
 *  the platform doesn't deliver events). */
export async function nativeExport(
  segments: NativeSegment[],
  filename?: string,
  onProgress?: (percent: number) => void
): Promise<NativeExportResult> {
  const plug = cap()?.Plugins?.EcNativeExport
  if (!plug) throw new Error('native export is not available on this platform')
  let handle: PluginListenerHandle | undefined
  if (onProgress && typeof plug.addListener === 'function') {
    try {
      handle = await plug.addListener('nativeExportProgress', (d) =>
        onProgress(Math.max(0, Math.min(100, Math.round(d?.percent ?? 0))))
      )
    } catch {
      /* no progress events on this platform — the export still runs */
    }
  }
  try {
    return await plug.export({ segments, filename })
  } finally {
    try {
      await handle?.remove()
    } catch {
      /* listener already gone */
    }
  }
}
