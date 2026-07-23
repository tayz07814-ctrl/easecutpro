// Bridge to the native `EcNativePlayer` Capacitor plugin (Android, Media3 ExoPlayer).
// Smooth hardware-decoded preview playback rendered into a TextureView behind a
// transparent WebView, so the HTML caption/overlay layers composite on top.
//
// Present only in the bundled Android app; every function no-ops / reports
// unavailable elsewhere, so the browser/desktop HTML preview is untouched.

export interface NativePlayerSegment {
  /** file path or content:// URI the native side can read. */
  uri: string
  /** trim in/out within the SOURCE media (ms). */
  startMs: number
  endMs: number
  /** this clip's position on the global timeline (ms). */
  timelineStartMs: number
  timelineEndMs: number
}

export interface NativePlayerState {
  timelineMs: number
  playing: boolean
  ended: boolean
  ready: boolean
}

interface PluginListenerHandle {
  remove: () => void | Promise<void>
}

interface EcNativePlayerPlugin {
  ping(): Promise<{ ok: boolean }>
  load(opts: { segments: NativePlayerSegment[] }): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  seek(opts: { timelineMs: number }): Promise<void>
  setRect(opts: { x: number; y: number; w: number; h: number }): Promise<void>
  setActive(opts: { active: boolean }): Promise<void>
  release(): Promise<void>
  addListener?(
    eventName: 'state',
    cb: (data: NativePlayerState) => void
  ): Promise<PluginListenerHandle> | PluginListenerHandle
}

interface CapGlobal {
  isNativePlatform?: () => boolean
  Plugins?: { EcNativePlayer?: EcNativePlayerPlugin }
}

function cap(): CapGlobal | undefined {
  return (window as unknown as { Capacitor?: CapGlobal }).Capacitor
}

function plug(): EcNativePlayerPlugin | undefined {
  return cap()?.Plugins?.EcNativePlayer
}

/** Is the native app + player plugin present? */
export function hasNativePlayer(): boolean {
  const c = cap()
  return !!(c?.isNativePlatform?.() && c.Plugins?.EcNativePlayer)
}

/** Confirm the native module actually answers (round-trips through the bridge). */
export async function nativePlayerReady(): Promise<boolean> {
  const p = plug()
  if (!p) return false
  try {
    return !!(await p.ping()).ok
  } catch {
    return false
  }
}

export const nativePlayer = {
  load: (segments: NativePlayerSegment[]) => plug()?.load({ segments }),
  play: () => plug()?.play(),
  pause: () => plug()?.pause(),
  seek: (timelineMs: number) => plug()?.seek({ timelineMs }),
  setRect: (x: number, y: number, w: number, h: number) => plug()?.setRect({ x, y, w, h }),
  setActive: (active: boolean) => plug()?.setActive({ active }),
  release: () => plug()?.release(),
  onState(cb: (s: NativePlayerState) => void): Promise<PluginListenerHandle> | PluginListenerHandle | undefined {
    const p = plug()
    if (!p || typeof p.addListener !== 'function') return undefined
    return p.addListener('state', cb)
  }
}
