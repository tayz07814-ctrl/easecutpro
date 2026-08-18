// Owns the preview proxy's lifecycle: what the current edit IS, whether a
// flattened render of it exists, and when to build one.
//
// The rules that matter:
//
//  • A proxy is a render of ONE exact edit. Playing it after any change would
//    show the creator a cut they no longer have, so it is keyed by a SIGNATURE
//    of the edit and only ever returned while that signature still matches what
//    is on screen. Any document change drops it instantly.
//  • Building is opportunistic and quiet. It never blocks the editor, the live
//    engine plays throughout, and a failure is invisible — the proxy is an
//    upgrade that arrives, not a gate to wait behind.
//  • It only helps where seams are expensive: desktop only (the web build has
//    no local ffmpeg to render with), and only once a timeline actually has
//    enough cuts to struggle. One uncut clip has no seams to remove.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TimelineDocument } from '@shared/timeline/types'
import type { Project } from '@shared/types'
import { documentToProject } from '@shared/timeline/bridge'
import { framesToSeconds } from '@shared/timeline/time'
import { useStore } from '../store'
import { IS_WEB } from '../platform'

/**
 * OFF by default — the same call the mobile build made, for the same reason.
 *
 * `mobile/lib/screens/editor_screen.dart` shipped this identical proxy (hash the
 * cut list, debounce, cache, swap only if it still matches, fall back to live on
 * failure) and then hard-disabled it once the native preview moved to Media3
 * `CompositionPlayer`, which steps over removed ranges inside ONE continuous
 * decode. A player that is seamless immediately beats a render that is seamless
 * in twenty seconds, and not baking the picture also let crop and the Ken Burns
 * pan go back to compositing live.
 *
 * The desktop equivalent of CompositionPlayer is `wcPlayer.ts` — same idea, one
 * decode graph per source with a cut as "draw from a different queue". Making
 * THAT seamless is the real fix; this file stays as a measured fallback for
 * machines where the WebCodecs path can't keep up, and is verified by
 * `scripts/verify-preview-proxy.ts` so it still works when switched on.
 *
 * MANUAL PROXY: even when auto-proxy is disabled, the user can trigger a one-shot
 * 720p render via `buildNow()` (exported below). A button in the preview pane
 * calls it; the proxy plays until the edit changes, then falls back to live.
 */
const PROXY_ENABLED = false

/** Below this many cuts the live engine copes fine; a render would be waste. */
const MIN_CLIPS = 8
/** Let editing settle before spending a render on a moving target. */
const SETTLE_MS = 1500

export interface PreviewProxy {
  /** path to play, or '' to use the live engine */
  path: string
  /** edited duration in seconds (proxy time == timeline time) */
  duration: number
  /** true while the current edit's proxy is being rendered */
  building: boolean
  /** the file won't play — stop offering it for this edit */
  reject: () => void
  /** manual trigger: render a 720p proxy now (user-requested, no debounce) */
  buildNow: () => void
}

/**
 * Fields that change how the timeline LOOKS but not what it RENDERS. Excluded
 * from the signature so that scrubbing or zooming doesn't invalidate a proxy.
 * Everything else is included, deliberately: over-invalidating costs one cheap
 * rebuild, under-invalidating shows the creator the wrong cut.
 */
const VIEW_ONLY = new Set([
  'playhead',
  'pxPerSec',
  'trackHeight',
  'showThumbnails',
  'magnet',
  'name',
  'selectedWordIds'
])

/** Small, stable, order-sensitive hash (FNV-1a). Not security, just identity. */
function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16) + s.length.toString(16)
}

function editSignature(folded: Project, doc: TimelineDocument): string {
  const body = JSON.stringify({ p: folded, d: doc }, (k, v) => (VIEW_ONLY.has(k) ? undefined : v))
  return hash(body)
}

/** Clips on the main storyline — how cut-up this timeline actually is. */
function mainClipCount(doc: TimelineDocument): number {
  const main = doc.tracks.find((t) => t.isMain) ?? doc.tracks.find((t) => t.kind === 'video')
  return main?.clips.length ?? 0
}

export function usePreviewProxy(doc: TimelineDocument | null): PreviewProxy {
  const [path, setPath] = useState('')
  const [duration, setDuration] = useState(0)
  const [building, setBuilding] = useState(false)
  // Signatures whose proxy failed to play; never offered again this session.
  const rejected = useRef(new Set<string>())
  const sigRef = useRef('')
  // Building while the creator is watching would put an ffmpeg render on the
  // machine at the exact moment smooth playback matters most.
  const playing = useStore((s) => s.playing)

  const clips = useMemo(() => (doc ? mainClipCount(doc) : 0), [doc])
  const eligible =
    PROXY_ENABLED && !IS_WEB && !!doc && clips >= MIN_CLIPS && typeof window.api?.buildPreviewProxy === 'function'

  // Signatures already handed to the main process this session. The build effect
  // legitimately re-runs (play/pause flips `playing`), and without this each
  // re-run fires another IPC for an edit already being rendered. The main
  // process de-duplicates too, so this is about not asking twice, not safety.
  const requested = useRef(new Set<string>())

  const reject = useCallback(() => {
    if (sigRef.current) rejected.current.add(sigRef.current)
    setPath('')
    setBuilding(false)
  }, [])

  /** Manual trigger: build a 720p proxy RIGHT NOW for the current edit.
   *  The user asked for it — no debounce, no eligibility check, no waiting
   *  for pause. The proxy plays until the edit changes. */
  const buildNow = useCallback(() => {
    if (!doc || IS_WEB || typeof window.api?.buildPreviewProxyManual !== 'function') return
    const stored = useStore.getState().project
    const folded = documentToProject(doc, stored)
    const sig = editSignature(folded, doc)
    sigRef.current = sig
    setPath('')
    setDuration(0)
    setBuilding(true)
    void window.api
      .buildPreviewProxyManual(folded, sig)
      .then((p) => {
        if (!p || sigRef.current !== sig) return
        setPath(p)
        setDuration(framesToSeconds(doc.duration, doc.timebase))
        setBuilding(false)
      })
      .catch(() => {
        if (sigRef.current === sig) setBuilding(false)
      })
  }, [doc])

  // INVALIDATION — deliberately its own effect, depending on the document and
  // nothing else. `doc` is a fresh object on every mutation, so this fires on
  // every edit, and dropping the proxy before anything else runs is what makes
  // showing a stale cut impossible. A stutter is recoverable; a preview of a
  // cut the creator no longer has is not.
  useEffect(() => {
    setPath('')
    setDuration(0)
    setBuilding(false)
    sigRef.current = ''
  }, [doc])

  // BUILDING — separate, because it also waits on playback, and pausing or
  // resuming must never disturb a proxy that is already playing correctly.
  useEffect(() => {
    if (!eligible || !doc || playing) return

    let alive = true
    const timer = window.setTimeout(() => {
      const stored = useStore.getState().project
      const folded = documentToProject(doc, stored)
      const sig = editSignature(folded, doc)
      if (!alive || rejected.current.has(sig)) return
      sigRef.current = sig

      // A render takes time and the creator keeps working; only adopt a result
      // if it still describes what is on screen.
      const adopt = (p: string): void => {
        if (!alive || !p || sigRef.current !== sig) return
        setPath(p)
        setDuration(framesToSeconds(doc.duration, doc.timebase))
        setBuilding(false)
      }

      // Already rendered this exact edit (an undo back to it, say) — instant.
        void window.api
          .existingPreviewProxy(sig)
          .then((p) => {
            if (p) return adopt(p)
            if (requested.current.has(sig)) return // already rendering for us
            requested.current.add(sig)
            setBuilding(true)
            return window.api.buildPreviewProxy(folded, sig).then(adopt)
          })
          .catch(() => {
            // A newer edit aborts this disposable build. Allow the signature to
            // be requested again if the user later undoes back to it.
            requested.current.delete(sig)
            if (sigRef.current === sig) setBuilding(false)
          }) // silent by design: the live engine is still playing
    }, SETTLE_MS)

    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [doc, eligible, playing])

  return { path, duration, building, reject, buildNow }
}
