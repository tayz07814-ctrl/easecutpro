// Text-look presets for the mobile Style tab.
//
// The catalogue is the SHARED one (textPresets.ts) — the same list the desktop
// Edit tab and the Captions tabs use — so a look saved on one surface shows up
// on all of them. This file only translates it into the flat TextClip fields the
// mobile panel edits (bgEnabled/bgColor/…, shadowDx/…), because that panel works
// on project.texts rather than the doc's nested TextContent.
//
// Every preset is a FULL bundle of the style-controlling fields, so switching
// presets is predictable: a preset with no outline/box/shadow explicitly turns
// them OFF rather than leaving the previous look's leftovers behind.

import type { TextClip } from '@shared/types'
import {
  TEXT_PRESETS,
  loadCustomPresets,
  presetPatch,
  type TextPreset,
  type TextStyle
} from '@shared/textPresets'

export interface TextStylePreset {
  id: string
  label: string
  patch: Partial<TextClip>
  /** User-made presets can be removed from the strip; built-ins cannot. */
  custom?: boolean
}

/** Shared (nested) look → the mobile panel's flat TextClip fields. */
function flatten(s: TextStyle): Partial<TextClip> {
  return {
    color: s.color,
    strokeWidth: s.strokeWidth,
    strokeColor: s.strokeColor,
    bgEnabled: s.background.enabled,
    bgColor: s.background.color,
    bgOpacity: s.background.opacity,
    bgRadius: s.background.radius,
    bgPadding: s.background.padding,
    shadowEnabled: s.shadow.enabled,
    shadowColor: s.shadow.color,
    shadowBlur: s.shadow.blur,
    shadowDx: s.shadow.dx,
    shadowDy: s.shadow.dy
  }
}

/** The mobile panel's flat fields → the shared (nested) look, so the current
 *  text can be saved as a preset the desktop swatches understand too. */
export function styleOfTextClip(c: TextClip): TextStyle {
  return {
    color: c.color,
    strokeWidth: c.strokeWidth,
    strokeColor: c.strokeColor,
    background: {
      enabled: c.bgEnabled,
      color: c.bgColor,
      opacity: c.bgOpacity,
      radius: c.bgRadius,
      padding: c.bgPadding
    },
    shadow: {
      enabled: !!c.shadowEnabled,
      color: c.shadowColor || '#000000',
      blur: c.shadowBlur ?? 0,
      dx: c.shadowDx ?? 0,
      dy: c.shadowDy ?? 0
    }
  }
}

function toMobile(p: TextPreset): TextStylePreset {
  return { id: p.id, label: p.label, patch: flatten(presetPatch(p)), custom: p.custom }
}

/** Built-ins plus the user's saved looks. A function, not a const, so a preset
 *  saved a moment ago appears without a reload. */
export function textStyles(): TextStylePreset[] {
  return [...TEXT_PRESETS, ...loadCustomPresets()].map(toMobile)
}
