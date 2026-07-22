// Premade text-look presets (0.01 mobile Style tab). Each preset is a full bundle
// of the style-controlling flat TextClip fields, so switching presets is
// predictable — a preset that has no outline/box/shadow explicitly turns them OFF.
// Applied via the panel's set(patch); the store deep-merges background + shadow.

import type { TextClip } from '@shared/types'

export interface TextStylePreset {
  id: string
  label: string
  patch: Partial<TextClip>
}

const OFF_BG = { bgEnabled: false, bgColor: '#000000', bgOpacity: 1, bgRadius: 0.3, bgPadding: 0.3 }
const OFF_SHADOW = { shadowEnabled: false, shadowColor: '#000000', shadowBlur: 0, shadowDx: 0, shadowDy: 0 }

export const TEXT_STYLES: TextStylePreset[] = [
  {
    id: 'plain',
    label: 'Plain',
    patch: { color: '#ffffff', strokeWidth: 0, strokeColor: '#000000', ...OFF_BG, ...OFF_SHADOW }
  },
  {
    id: 'outline',
    label: 'Outline',
    patch: { color: '#ffffff', strokeWidth: 0.08, strokeColor: '#000000', ...OFF_BG, ...OFF_SHADOW }
  },
  {
    id: 'boxed',
    label: 'Boxed',
    patch: { color: '#ffffff', strokeWidth: 0, strokeColor: '#000000', bgEnabled: true, bgColor: '#000000', bgOpacity: 1, bgRadius: 0.22, bgPadding: 0.34, ...OFF_SHADOW }
  },
  {
    id: 'shadow',
    label: 'Shadow',
    patch: { color: '#ffffff', strokeWidth: 0, strokeColor: '#000000', ...OFF_BG, shadowEnabled: true, shadowColor: '#000000', shadowBlur: 0.16, shadowDx: 0.03, shadowDy: 0.06 }
  },
  {
    id: 'yellow',
    label: 'Yellow',
    patch: { color: '#ffe14d', strokeWidth: 0.09, strokeColor: '#000000', ...OFF_BG, ...OFF_SHADOW }
  },
  {
    id: 'pop',
    label: 'Pop',
    patch: { color: '#ffffff', strokeWidth: 0.12, strokeColor: '#000000', ...OFF_BG, shadowEnabled: true, shadowColor: '#000000', shadowBlur: 0.12, shadowDx: 0.03, shadowDy: 0.05 }
  }
]
