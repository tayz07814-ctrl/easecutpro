// Silence Settings adapter — now bound to the FSMN (FunASR) engine ported from
// 0.07. The Retake/Speech-cleaner silence path uses retakeFinalBossSettings
// (padBefore/padAfter/trimEdges + the audioOverlap crossfade). The old Silero
// VadSilenceSettings + presets are no longer driven here (they stay in the store
// for ProCut/Ultracut/Premium, which are unchanged).

import { useStore, type SeamFadeSettings } from '../../store'
import { DEFAULT_RETAKE_FINAL_BOSS_SETTINGS, type RetakeFinalBossSettings } from '@shared/retakefinalboss'

export interface SilenceModel {
  show: boolean
  s: RetakeFinalBossSettings
  setField: (k: keyof RetakeFinalBossSettings, v: number) => void
  /** Seam blend ("overlap") at cuts — the FSMN audioOverlapMs, mirrored into the
   *  global render crossfade so preview + export match. */
  seamFade: SeamFadeSettings
  setSeamFade: (patch: Partial<SeamFadeSettings>) => void
  reset: () => void
  close: () => void
}

export function useSilence(): SilenceModel {
  const s = useStore((st) => st.retakeFinalBossSettings)
  const setS = useStore((st) => st.setRetakeFinalBossSettings)
  const show = useStore((st) => st.showSilenceSettings)
  const setShow = useStore((st) => st.setShowSilenceSettings)
  const seamFade = useStore((st) => st.seamFade)
  const setSeamFade = useStore((st) => st.setSeamFade)
  const applyOverlap = (ms: number): void => {
    setS({ audioOverlapMs: ms })
    setSeamFade({ enabled: ms > 0, ms })
  }
  return {
    show,
    s,
    seamFade,
    setField: (k, v) => {
      if (k === 'audioOverlapMs') applyOverlap(v)
      else setS({ [k]: v } as Partial<RetakeFinalBossSettings>)
    },
    setSeamFade: (patch) => {
      // Keep the FSMN setting and the render crossfade in lockstep.
      if (patch.ms !== undefined) applyOverlap(patch.ms)
      else if (patch.enabled !== undefined) applyOverlap(patch.enabled ? s.audioOverlapMs || 20 : 0)
      else setSeamFade(patch)
    },
    reset: () => {
      setS({ ...DEFAULT_RETAKE_FINAL_BOSS_SETTINGS })
      setSeamFade({ enabled: DEFAULT_RETAKE_FINAL_BOSS_SETTINGS.audioOverlapMs > 0, ms: DEFAULT_RETAKE_FINAL_BOSS_SETTINGS.audioOverlapMs })
    },
    close: () => setShow(false)
  }
}
