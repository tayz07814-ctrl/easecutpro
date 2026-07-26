// Retake Final Boss settings adapter. This is a separate persisted profile and
// does not read or write any earlier Retake/ProCut silence settings.

import type { RetakeFinalBossSettings } from '@shared/retakefinalboss'
import { useStore } from '../../store'

export interface SilenceModel {
  show: boolean
  settings: RetakeFinalBossSettings
  commit: (settings: RetakeFinalBossSettings) => void
  close: () => void
}

export function useSilence(): SilenceModel {
  const settings = useStore((state) => state.retakeFinalBossSettings)
  const setSettings = useStore((state) => state.setRetakeFinalBossSettings)
  const setSeamFade = useStore((state) => state.setSeamFade)
  const show = useStore((state) => state.showSilenceSettings)
  const setShow = useStore((state) => state.setShowSilenceSettings)
  return {
    show,
    settings,
    commit: (next) => {
      setSettings(next)
      setSeamFade({ enabled: next.audioOverlapMs > 0, ms: next.audioOverlapMs })
    },
    close: () => setShow(false)
  }
}
