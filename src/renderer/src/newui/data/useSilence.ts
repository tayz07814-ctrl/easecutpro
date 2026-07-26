// Stage C — Silence Settings adapter (screen 1d). Maps the design's presets +
// friendly sliders onto the existing vadSilenceSettings profile (persisted via
// setVadSilenceSettings). It uses the SHARED canonical presets (silencePresets.ts
// — the same unit-tested bundles the stable app uses), so the new UI and the
// stable app detect silence identically. The screen edits a local draft and only
// commits settings when the creator presses Apply.

import { useStore, type SeamFadeSettings } from '../../store'
import type { VadSilenceSettings } from '@shared/vadsilence'
import {
  SILENCE_PRESETS,
  detectPreset as detectSilencePreset,
  type SilencePresetId,
  type SilencePresetOrCustom
} from '../../silencePresets'

export type Preset = SilencePresetOrCustom
export { SILENCE_PRESETS }
export type { SilencePresetId }

export interface SilenceModel {
  show: boolean
  s: VadSilenceSettings
  detected: Preset
  /** the canonical preset definitions (id/label/blurb/values) for rendering. */
  presets: typeof SILENCE_PRESETS
  /** Seam blend ("overlap") at cuts — global render setting, separate from presets. */
  seamFade: SeamFadeSettings
  commit: (settings: VadSilenceSettings, fade: SeamFadeSettings) => void
  close: () => void
}

export function useSilence(): SilenceModel {
  const s = useStore((st) => st.vadSilenceSettings)
  const setS = useStore((st) => st.setVadSilenceSettings)
  const show = useStore((st) => st.showSilenceSettings)
  const setShow = useStore((st) => st.setShowSilenceSettings)
  const seamFade = useStore((st) => st.seamFade)
  const setSeamFade = useStore((st) => st.setSeamFade)
  return {
    show,
    s,
    detected: detectSilencePreset(s),
    presets: SILENCE_PRESETS,
    seamFade,
    commit: (settings, fade) => {
      setS(settings)
      setSeamFade(fade)
    },
    close: () => setShow(false)
  }
}
