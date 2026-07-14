// Stage C — Silence Settings adapter (screen 1d). Maps the design's presets +
// friendly sliders onto the existing vadSilenceSettings profile (persisted to
// localStorage via setVadSilenceSettings). No silence-engine change.

import { useStore } from '../../store'
import { DEFAULT_VAD_SILENCE_SETTINGS, type VadSilenceSettings } from '@shared/vadsilence'

export type Preset = 'conservative' | 'balanced' | 'aggressive' | 'custom'

// Preset value-bundles. minGapS follows the approved design copy
// (Conservative >2s · Balanced >1s · Aggressive >0.5s); the other fields are
// proposed defaults (FLAGGED — adjust on request).
export const PRESET_BUNDLES: Record<Exclude<Preset, 'custom'>, Partial<VadSilenceSettings>> = {
  conservative: { minGapS: 2.0, padBeforeS: 0.15, padAfterS: 0.12, speechThreshold: 0.7 },
  balanced: { minGapS: 1.0, padBeforeS: 0.1, padAfterS: 0.07, speechThreshold: 0.8 },
  aggressive: { minGapS: 0.5, padBeforeS: 0.05, padAfterS: 0.04, speechThreshold: 0.85 }
}

function matches(s: VadSilenceSettings, b: Partial<VadSilenceSettings>): boolean {
  return (Object.keys(b) as (keyof VadSilenceSettings)[]).every((k) => Math.abs((s[k] as number) - (b[k] as number)) < 1e-6)
}

export function detectPreset(s: VadSilenceSettings): Preset {
  for (const p of ['conservative', 'balanced', 'aggressive'] as const) if (matches(s, PRESET_BUNDLES[p])) return p
  return 'custom'
}

export interface SilenceModel {
  show: boolean
  s: VadSilenceSettings
  detected: Preset
  applyPreset: (p: Exclude<Preset, 'custom'>) => void
  setField: (k: keyof VadSilenceSettings, v: number | boolean) => void
  reset: () => void
  close: () => void
}

export function useSilence(): SilenceModel {
  const s = useStore((st) => st.vadSilenceSettings)
  const setS = useStore((st) => st.setVadSilenceSettings)
  const show = useStore((st) => st.showSilenceSettings)
  const setShow = useStore((st) => st.setShowSilenceSettings)
  return {
    show,
    s,
    detected: detectPreset(s),
    applyPreset: (p) => setS(PRESET_BUNDLES[p]),
    setField: (k, v) => setS({ [k]: v } as Partial<VadSilenceSettings>),
    reset: () => setS({ ...DEFAULT_VAD_SILENCE_SETTINGS }),
    close: () => setShow(false)
  }
}
