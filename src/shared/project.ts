import type { Project, Track } from './types'
import { TIMELINE_TRACK_COUNT } from './types'

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

export function emptyTracks(): Track[] {
  return Array.from({ length: TIMELINE_TRACK_COUNT }, (_, i) => ({
    id: uid(),
    index: i,
    name: i === 0 ? 'A-roll (base)' : `Overlay ${i}`,
    muted: false,
    hidden: false,
    clips: []
  }))
}

/** A fresh, empty project (matches the editor's New Project state). */
export function createEmptyProject(name = 'Untitled'): Project {
  return {
    version: 1,
    name,
    silences: [],
    tracks: emptyTracks(),
    playhead: 0,
    pxPerSec: 80,
    magnet: true,
    trackHeight: 96,
    baseSplits: [],
    manualCuts: [],
    keepOverrides: [],
    silencePadding: 0.08,
    showThumbnails: true,
    texts: [],
    aspectW: 0,
    aspectH: 0
  }
}

export function newTextId(): string {
  return uid()
}
export function newClipId(): string {
  return uid()
}
