// Media-data provider: how a clip gets its audio peaks and filmstrip frames.
// The renderer stays source-agnostic — it asks the provider and draws whatever
// comes back. In the app this is backed by cache managers over window.api
// (extractWaveform / extractThumbnails, shape { peaksPerSec, peaks[] } and
// { time, url }[]); in the standalone preview it's synthetic. Async data is
// delivered by the provider bumping a version the engine/React re-reads.

import { createContext, useContext, type ReactNode } from 'react'
import type { Clip } from '@shared/timeline/types'

/** Matches src/shared/types.ts `Waveform`. */
export interface ClipWaveform {
  peaksPerSec: number
  peaks: number[]
}

/** Matches src/shared/types.ts `Thumb`. */
export interface ClipFrame {
  time: number
  url: string
}

export interface MediaData {
  /** Peaks for the clip's audio, or null while loading / if silent. */
  getWaveform(clip: Clip): ClipWaveform | null
  /** Filmstrip frames for the clip's source, or null while loading. */
  getFrames(clip: Clip): ClipFrame[] | null
}

/** The peaks covering just a clip's [sourceIn, sourceOut] slice of the full-source
 *  waveform — so a split/trimmed clip shows ITS portion, not the whole file. */
export function clipPeaks(wf: ClipWaveform | null, sourceIn: number, sourceOut: number): number[] {
  if (!wf || wf.peaks.length === 0) return []
  const pps = wf.peaksPerSec || 1
  const from = Math.max(0, Math.floor(sourceIn * pps))
  const to = Math.min(wf.peaks.length, Math.ceil(sourceOut * pps))
  return to > from ? wf.peaks.slice(from, to) : wf.peaks
}

const MediaDataContext = createContext<MediaData | null>(null)

export function MediaDataProvider({
  value,
  children
}: {
  value: MediaData
  children: ReactNode
}): JSX.Element {
  return <MediaDataContext.Provider value={value}>{children}</MediaDataContext.Provider>
}

export function useMediaData(): MediaData | null {
  return useContext(MediaDataContext)
}
