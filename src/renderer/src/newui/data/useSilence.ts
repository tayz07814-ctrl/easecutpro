// Stage C — Silence Settings adapter (screen 1d). Maps the design's presets +
// friendly sliders onto the existing vadSilenceSettings profile (persisted via
// setVadSilenceSettings). It uses the SHARED canonical presets (silencePresets.ts
// — the same unit-tested bundles the stable app uses), so the new UI and the
// stable app detect silence identically. No silence-engine change.

import { useStore, type SeamFadeSettings } from '../../store'
import { DEFAULT_VAD_SILENCE_SETTINGS, type VadSilenceSettings } from '@shared/vadsilence'
import {
  SILENCE_PRESETS,
  detectPreset as detectSilencePreset,
  presetValues,
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
  applyPreset: (p: SilencePresetId) => void
  setField: (k: keyof VadSilenceSettings, v: number | boolean) => void
  /** Seam blend ("overlap") at cuts — global render setting, separate from presets. */
  seamFade: SeamFadeSettings
  setSeamFade: (patch: Partial<SeamFadeSettings>) => void
  reset: () => void
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
    setSeamFade,
    // presetValues() is a full VadSilenceSettings bundle (all 7 fields), so a
    // preset lands on exactly the tested values — not a partial that leaves
    // stale fields behind (the old bug that made "Balanced" under-cut).
    applyPreset: (p) => setS(presetValues(p)),
    setField: (k, v) => setS({ [k]: v } as Partial<VadSilenceSettings>),
    reset: () => setS({ ...DEFAULT_VAD_SILENCE_SETTINGS }), // Balanced
    close: () => setShow(false)
  }
}
