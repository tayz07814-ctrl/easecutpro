// Playback/debug recorder.
//
// Writes a "latest wins" JSON (temp/easecut-debug/player-debug-latest.json)
// describing the video preview state at the moment of the write: which engine
// is active (wc/ff/element), the decoded-frame statistics, the cut/segment
// list, proxy state, and the audio engine. DocPreview calls recordPlayback()
// every rAF with cheap per-frame context; this module throttles to one write
// per ~2s plus forced writes on structural events (seams change, engine flips,
// buffering fallback, proxy ready, playback start/stop).
//
// Desktop writes via IPC.debugPlayerDump (overwrite). On web the call is a
// no-op stub, so this costs nothing in the browser build.

import { useStore } from './store'
import { IS_WEB } from './platform'

export interface PlaybackSnapshot {
  timestamp: string
  /** monotonic time for change detection (performance.now) */
  mono: number
  view: string
  playing: boolean
  playhead: number
  projectName: string
  mediaPath: string
  hasTimeline: boolean
  segmentCount: number
  seamCount: number
  jobActive: boolean
  jobKind: string | undefined
  jobMessage: string | undefined
  buildProxyOnLoad: boolean
  engine: {
    wcOn: boolean
    kind: string
    platform: string
    isMobile: boolean
  }
  stats: Record<string, unknown>
  audio: {
    ready: boolean
    playing: boolean
    active: boolean
    expected: number | null
  } | null
}

let lastWrite = 0

/** Gather the store half of the snapshot. `doc` may be null before the editor
 *  has a timeline; segments come from the document when available. */
export function snapshotPlayback(ctx: {
  playing: boolean
  engineKind?: string
  wcOn?: boolean
  isMobile?: boolean
  audio?: { ready(): boolean; isPlaying(): boolean; active(): boolean; expected(): number } | null
  segments?: { length: number; seams: number }
}): PlaybackSnapshot {
  const s = useStore.getState()
  const proj = s.project
  const raw = typeof window !== 'undefined' ? (window as unknown as { __wcStats?: unknown }).__wcStats : null
  const stats = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  let seg: { length: number; seams: number } | null = ctx.segments ?? null
  if (!seg) seg = { length: 0, seams: 0 }
  return {
    timestamp: new Date().toISOString(),
    mono: performance.now(),
    view: s.view,
    playing: ctx.playing,
    playhead: proj?.playhead ?? 0,
    projectName: proj?.name ?? '',
    mediaPath: proj?.media?.path ?? '',
    hasTimeline: !!proj?.timeline,
    segmentCount: seg?.length ?? 0,
    seamCount: seg?.seams ?? 0,
    jobActive: s.job.active,
    jobKind: s.job.kind,
    jobMessage: s.job.message,
    buildProxyOnLoad: s.buildProxyOnLoad,
    engine: {
      wcOn: ctx.wcOn ?? false,
      kind: ctx.engineKind ?? '',
      platform: IS_WEB ? 'web' : 'desktop',
      isMobile: ctx.isMobile ?? false
    },
    stats: stats ?? {},
    audio: ctx.audio
      ? {
          ready: ctx.audio.ready(),
          playing: ctx.audio.isPlaying(),
          active: ctx.audio.active(),
          expected: ctx.audio.expected()
        }
      : null
  }
}

/** Write the snapshot (throttled unless `force`). */
export function recordPlayback(snap: PlaybackSnapshot, force = false): void {
  if (IS_WEB) return
  if (!force && performance.now() - lastWrite < 2000) return
  lastWrite = performance.now()
  window.api?.debugPlayerDump?.(snap).catch(() => undefined)
}