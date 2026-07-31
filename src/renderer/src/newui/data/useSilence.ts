// Silence Settings adapter — now bound to the FSMN (FunASR) engine ported from
// 0.07. The Retake/Speech-cleaner silence path uses retakeFinalBossSettings
// (padBefore/padAfter/trimEdges + the audioOverlap crossfade). The old Silero
// VadSilenceSettings + presets are no longer driven here (they stay in the store
// for ProCut/Ultracut/Premium, which are unchanged).

import { useStore, type SeamFadeSettings } from '../../store'
import {
  FSMN_SILENCE_PRESETS,
  getFsmnPreset,
  DEFAULT_FSMN_PRESET_ID,
  type RetakeFinalBossSettings,
  type SilencePreset
} from '@shared/retakefinalboss'

export interface SilenceModel {
  show: boolean
  s: RetakeFinalBossSettings
  /** numeric fields only — `tailTrim` is a boolean, see setTailTrim. */
  setField: (k: Exclude<keyof RetakeFinalBossSettings, 'tailTrim'>, v: number) => void
  /** Preset chips + the active id; the sliders only show when the active preset
   *  is editable (Mad Scientist). */
  presets: SilencePreset[]
  preset: string
  editable: boolean
  applyPreset: (id: string) => void
  /** Quiet-tail trim — preset-driven (on for No Chill + Espresso Shot), and
   *  toggleable in the editable preset. */
  setTailTrim: (v: boolean) => void
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
  const preset = useStore((st) => st.retakeFinalBossPreset)
  const applyPreset = useStore((st) => st.setRetakeFinalBossPreset)
  const show = useStore((st) => st.showSilenceSettings)
  const setShow = useStore((st) => st.setShowSilenceSettings)
  const seamFade = useStore((st) => st.seamFade)
  const setSeamFade = useStore((st) => st.setSeamFade)
  const applyOverlap = (ms: number): void => {
    setS({ audioOverlapMs: ms }) // flips preset → custom
    setSeamFade({ enabled: ms > 0, ms })
  }
  return {
    show,
    s,
    presets: FSMN_SILENCE_PRESETS,
    preset,
    editable: getFsmnPreset(preset).editable,
    applyPreset,
    setTailTrim: (v) => setS({ tailTrim: v }),
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
    reset: () => applyPreset(DEFAULT_FSMN_PRESET_ID),
    close: () => setShow(false)
  }
}
