// Stage C — preview playback for the new editor. Reuses Easecut's SHARED
// cut-skip helper (computeKeepRanges from @shared/edit) and mirrors the tuned
// rAF skip loop from VideoPreview.tsx WITHOUT importing/modifying it. Single-
// base (project.media) playback; drives the store playhead so the design's
// transport, timecode and timeline all stay in sync. Skips executed cuts.

import { useEffect, useRef, type RefObject } from 'react'
import { useStore } from '../../store'
import { computeKeepRanges } from '@shared/edit'

export function usePreviewPlayback(ref: RefObject<HTMLVideoElement>): void {
  const project = useStore((s) => s.project)
  const playing = useStore((s) => s.playing)
  const setPlaying = useStore((s) => s.setPlaying)
  const setPlayhead = useStore((s) => s.setPlayhead)
  const waveform = useStore((s) => s.waveform)

  const keeps = computeKeepRanges(project, waveform)
  const keepsRef = useRef(keeps)
  keepsRef.current = keeps
  // Playhead values that ORIGINATED from the video, so the external-sync effect
  // doesn't seek the element back to a stale playhead mid-skip.
  const lastSyncRef = useRef(0)

  // External playhead changes (scrub / segment click / transport) → video.
  useEffect(() => {
    const v = ref.current
    if (!v) return
    if (Math.abs(project.playhead - lastSyncRef.current) < 0.05) return
    if (Math.abs(v.currentTime - project.playhead) > 0.15) v.currentTime = project.playhead
    lastSyncRef.current = project.playhead
  }, [project.playhead, ref])

  // play / pause.
  useEffect(() => {
    const v = ref.current
    if (!v) return
    if (playing) v.play().catch(() => undefined)
    else v.pause()
  }, [playing, ref])

  // Coarse in-keep playhead nudging (~4Hz) via timeupdate.
  useEffect(() => {
    const v = ref.current
    if (!v) return
    const onTime = (): void => {
      if (!useStore.getState().playing) return
      const t = v.currentTime
      const ranges = keepsRef.current
      const inKeep = ranges.length === 0 || ranges.find((k) => t >= k.start - 0.001 && t < k.end)
      if (inKeep) {
        lastSyncRef.current = t
        setPlayhead(t)
      }
    }
    v.addEventListener('timeupdate', onTime)
    return () => v.removeEventListener('timeupdate', onTime)
  }, [ref, setPlayhead])

  // Precise 60fps cut-skip: the instant playback enters a cut, jump to the next
  // kept range (mirrors VideoPreview's loop; micro-gaps <100ms play through).
  useEffect(() => {
    const v = ref.current
    if (!v || !playing) return
    let raf = 0
    const loop = (): void => {
      const ct = v.currentTime
      const ranges = keepsRef.current
      const inKeep = ranges.length === 0 ? true : ranges.find((k) => ct >= k.start - 0.001 && k.end > ct)
      if (!inKeep) {
        const next = ranges.find((k) => k.start > ct)
        if (next) {
          if (next.start - ct > 0.1) {
            lastSyncRef.current = next.start
            v.currentTime = next.start
            setPlayhead(next.start)
            raf = requestAnimationFrame(loop)
            return
          }
        } else {
          v.pause()
          setPlaying(false)
          return
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [playing, ref, setPlayhead, setPlaying])
}
