// Drives the native ExoPlayer preview (Android) from the timeline, keeping the
// HTML caption/overlay layers composited on top. Strictly additive: it activates
// ONLY for a plain cut whose sources were imported natively, and on ANY problem it
// disables itself for the session so the proven HTML `<video>` preview takes over.
// Every path no-ops on web/desktop (hasNativePlayer() is false there).

import { useEffect, useRef, useState } from 'react'
import { playClock } from './clock'
import { nativePathFor } from './webmedia'
import {
  hasNativePlayer,
  nativePlayerReady,
  nativePlayer,
  type NativePlayerSegment,
  type NativePlayerState
} from './cloud/nativePlayer'

/** Minimal projection of a main-lane segment (DocPreview's Seg is compatible). */
export interface PreviewSeg {
  src: string
  sourceStart: number
  sourceEnd: number
  start: number
  len: number
  speed: number
  muted?: boolean
  gain?: number
  ovScale?: number
  ovZoomStart?: number
  ovZoomEnd?: number
  ovX?: number
  ovY?: number
}

const EPS = 1e-3
const one = (v: number | undefined): boolean => Math.abs((v ?? 1) - 1) < EPS
const zero = (v: number | undefined): boolean => Math.abs(v ?? 0) < EPS

// Session kill switch. Set localStorage 'ec.nativePlayer' = '0' to force the HTML
// preview. Also flipped true if the native player ever errors, so we never thrash.
let disabledForSession = false
function enabled(): boolean {
  if (disabledForSession) return false
  try {
    // Default OFF. On-device the native ExoPlayer preview has serious regressions
    // (double audio for the first seconds, ~5s stuck/vibrating start, can't scrub
    // while playing, seam stutter), so the reliable HTML <video> preview runs by
    // default. Opt in for testing with localStorage.setItem('ec.nativePlayer','1').
    if (localStorage.getItem('ec.nativePlayer') !== '1') return false
  } catch {
    return false
  }
  return hasNativePlayer()
}

/** Eligible ONLY for a plain cut: contiguous base-video slices, natively imported,
 *  no speed / mute / gain / Ken Burns / crop. Returns the native segments or null. */
export function buildNativePlayerSegments(segs: PreviewSeg[]): NativePlayerSegment[] | null {
  if (!segs.length) return null
  const out: NativePlayerSegment[] = []
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    if (!one(s.speed) || s.muted || !one(s.gain)) return null
    if (!one(s.ovScale) || !one(s.ovZoomStart) || !one(s.ovZoomEnd) || !zero(s.ovX) || !zero(s.ovY)) return null
    const path = nativePathFor(s.src)
    if (!path) return null
    if (i > 0) {
      const prev = segs[i - 1]
      if (Math.abs(s.start - (prev.start + prev.len)) > 0.05) return null // no gaps
    }
    const startMs = Math.max(0, Math.round(s.sourceStart * 1000))
    const endMs = Math.round(s.sourceEnd * 1000)
    if (endMs <= startMs) return null
    out.push({
      uri: 'file://' + path,
      startMs,
      endMs,
      timelineStartMs: Math.round(s.start * 1000),
      timelineEndMs: Math.round((s.start + s.len) * 1000)
    })
  }
  return out
}

/** Stable signature so effects only re-run when the cut actually changes. */
function sig(segs: NativePlayerSegment[] | null): string {
  return segs ? segs.map((s) => `${s.uri}:${s.startMs}:${s.endMs}:${s.timelineStartMs}`).join('|') : ''
}

export function useNativePreview(params: {
  segs: PreviewSeg[]
  frameRef: React.RefObject<HTMLElement>
  playing: boolean
  playhead: number
  totalSec: number
  setPlaying: (b: boolean) => void
  setPlayhead: (t: number) => void
  nativeActiveRef: React.MutableRefObject<boolean>
}): { nativeShowing: boolean } {
  const { segs, frameRef, playing, playhead, totalSec, setPlaying, setPlayhead, nativeActiveRef } = params
  const [nativeShowing, setNativeShowing] = useState(false)

  const nativeSegs = enabled() ? buildNativePlayerSegments(segs) : null
  const signature = sig(nativeSegs)
  const segsRef = useRef<NativePlayerSegment[] | null>(nativeSegs)
  segsRef.current = nativeSegs
  const readyRef = useRef(false)
  const totalRef = useRef(totalSec)
  totalRef.current = totalSec

  // Interpolation anchors: the native state event (~10 Hz) sets these; a rAF
  // advances playClock between events so overlays/text animate smoothly.
  const anchorSec = useRef(0)
  const anchorWall = useRef(0)
  const lastStoreWrite = useRef(0)
  // Watchdog: if the native player doesn't advance shortly after Play (stuck / no
  // events on this device), hand playback back to the HTML player so the timeline
  // is never frozen. Tracked from the last FORWARD-progress sample.
  const lastReportedMs = useRef(-1)
  const lastProgressWall = useRef(0)
  const playingRef = useRef(playing)
  playingRef.current = playing

  // (Re)load the playlist whenever the eligible cut changes.
  useEffect(() => {
    let cancelled = false
    readyRef.current = false
    if (!nativeSegs) return
    ;(async () => {
      try {
        if (!(await nativePlayerReady())) return
        if (cancelled) return
        await nativePlayer.load(nativeSegs)
        if (!cancelled) readyRef.current = true
      } catch {
        disabledForSession = true
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  // Keep the native surface positioned under the HTML preview frame.
  useEffect(() => {
    if (!nativeSegs) return
    let raf = 0
    let last = ''
    const tick = (): void => {
      const el = frameRef.current
      if (el) {
        const r = el.getBoundingClientRect()
        const dpr = window.devicePixelRatio || 1
        const key = `${r.left}:${r.top}:${r.width}:${r.height}:${dpr}`
        if (key !== last && r.width > 0 && r.height > 0) {
          last = key
          void nativePlayer.setRect(
            Math.round(r.left * dpr),
            Math.round(r.top * dpr),
            Math.round(r.width * dpr),
            Math.round(r.height * dpr)
          )
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  // Listen to native position; drive the shared clock + store playhead while active.
  useEffect(() => {
    if (!nativeSegs) return
    let handle: { remove: () => void | Promise<void> } | undefined
    let disposed = false
    const onState = (st: NativePlayerState): void => {
      if (!nativeActiveRef.current) return
      const now = performance.now()
      // Re-anchor the interpolation clock to the native picture, and note real
      // forward progress so the watchdog knows the player is actually advancing.
      if (st.timelineMs > lastReportedMs.current + 5) {
        lastReportedMs.current = st.timelineMs
        lastProgressWall.current = now
      }
      anchorSec.current = st.timelineMs / 1000
      anchorWall.current = now
      if (st.ended) setPlaying(false)
    }
    Promise.resolve(nativePlayer.onState(onState)).then((h) => {
      if (disposed) void h?.remove?.()
      else handle = h as { remove: () => void }
    })
    return () => {
      disposed = true
      void handle?.remove?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  // Drive the clock + the store playhead from a wall-clock interpolation anchored
  // to native samples — so the TIMELINE CURSOR advances on Play even if native
  // events are sparse (the "stuck clock" fix). A watchdog hands playback back to
  // the HTML player if native isn't actually progressing on this device.
  useEffect(() => {
    let raf = 0
    const tick = (): void => {
      if (nativeActiveRef.current) {
        const now = performance.now()
        const t = Math.min(anchorSec.current + (now - anchorWall.current) / 1000, totalRef.current)
        playClock.t = t
        if (now - lastStoreWrite.current > 90) {
          lastStoreWrite.current = now
          setPlayhead(t)
        }
        if (t >= totalRef.current - 0.02 && playingRef.current) {
          setPlaying(false)
        } else if (
          playingRef.current &&
          now - lastProgressWall.current > 1800 &&
          anchorSec.current < totalRef.current - 0.3
        ) {
          // Native player isn't advancing (stuck / no state events on this device):
          // fall back to the proven HTML preview for the rest of the session so the
          // timeline is never frozen. A reload re-enables the native attempt.
          disabledForSession = true
          nativeActiveRef.current = false
          document.body.classList.remove('ec-native-active')
          setNativeShowing(false)
          void nativePlayer.setActive(false)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Transport: play → activate native surface + play; pause → deactivate (HTML resumes).
  useEffect(() => {
    if (!nativeSegs) {
      // Ineligible: make sure any prior native session is torn down.
      if (nativeActiveRef.current) {
        nativeActiveRef.current = false
        setNativeShowing(false)
        void nativePlayer.setActive(false)
        document.body.classList.remove('ec-native-active')
      }
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        if (playing) {
          if (!readyRef.current) return // still loading — HTML plays this frame
          await nativePlayer.seek(Math.round(playhead * 1000))
          anchorSec.current = playhead
          anchorWall.current = performance.now()
          // Arm the watchdog from this moment; native must show forward progress.
          lastReportedMs.current = Math.round(playhead * 1000)
          lastProgressWall.current = performance.now()
          await nativePlayer.setActive(true)
          if (cancelled) return
          nativeActiveRef.current = true
          document.body.classList.add('ec-native-active')
          setNativeShowing(true)
          await nativePlayer.play()
        } else {
          await nativePlayer.pause()
          nativeActiveRef.current = false
          document.body.classList.remove('ec-native-active')
          setNativeShowing(false)
          await nativePlayer.setActive(false)
        }
      } catch {
        disabledForSession = true
        nativeActiveRef.current = false
        document.body.classList.remove('ec-native-active')
        setNativeShowing(false)
        void nativePlayer.setActive(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, signature])

  // Scrub while the native player is active → seek the native player.
  useEffect(() => {
    if (nativeActiveRef.current && readyRef.current) {
      void nativePlayer.seek(Math.round(playhead * 1000))
      anchorSec.current = playhead
      anchorWall.current = performance.now()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playhead])

  // Release the native player + restore the WebView when the preview unmounts.
  useEffect(() => {
    return () => {
      nativeActiveRef.current = false
      document.body.classList.remove('ec-native-active')
      void nativePlayer.setActive(false)
      void nativePlayer.release()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { nativeShowing: nativeShowing && !!nativeSegs }
}
