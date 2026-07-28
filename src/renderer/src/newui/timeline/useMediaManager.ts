// React binding for the media cache managers: creates one manager for the
// subtree and re-renders when fetched waveform/thumbnail data arrives. Provide
// its result to <MediaDataProvider> in the app.

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { createMediaManager } from './mediaManager'
import type { MediaData } from './MediaData'

export function useMediaManager(): MediaData {
  const mgr = useMemo(() => createMediaManager(), [])
  useSyncExternalStore(mgr.subscribe, mgr.getVersion, mgr.getVersion)
  useEffect(() => () => mgr.dispose(), [mgr])
  return mgr
}
