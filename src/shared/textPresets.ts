// Text / caption style presets — the swatch strip ("Aa" chips) shared by the
// Text panel and the Captions panel.
//
// A preset is a PARTIAL TextContent: only the look (colour, stroke, background,
// shadow), never the words, the font size or the position. Applying one to a
// caption run must not resize or re-place it, and applying one to a text clip
// must not overwrite what the user typed.
//
// Sizes here are the few that are genuinely part of a look — stroke width,
// background padding/radius, shadow offsets — expressed the same way the rest
// of TextContent expresses them (fractions of frame height for spatial values),
// so a preset lands identically at any resolution.

import type { TextContent } from './timeline/types'

/** The subset of TextContent a preset may set. */
export type TextStyle = Pick<
  TextContent,
  'color' | 'strokeWidth' | 'strokeColor' | 'background' | 'shadow'
>

export interface TextPreset {
  id: string
  label: string
  /** null = "None": strip styling back to plain text. */
  style: TextStyle | null
  /** User-made presets are editable/removable; built-ins are not. */
  custom?: boolean
}

// Value scales match the live controls, NOT raw pixels: strokeWidth 0..0.40
// (the Outline chip turns on at 0.08), background radius/padding 0..1 (the doc
// default is 0.3). Guessing small "fraction of frame" numbers here produces
// presets that look like plain text — see docTextClips.ts for the defaults.
const noBg = { enabled: false, color: '#000000', opacity: 1, radius: 0.3, padding: 0.3 }
const noShadow = { enabled: false, color: '#000000', blur: 0, dx: 0, dy: 0 }

/** Solid fill behind the words (the pill chips in the strip). */
function bg(color: string, opacity = 1): TextStyle['background'] {
  return { enabled: true, color, opacity, radius: 0.3, padding: 0.3 }
}
/** The drop shadow most caption looks use — soft, straight down. */
const softShadow = { enabled: true, color: '#000000', blur: 0.3, dx: 0, dy: 0.12 }

/** Plain coloured text with a readable dark shadow. */
function plain(color: string): TextStyle {
  return { color, strokeWidth: 0, strokeColor: '#000000', background: noBg, shadow: softShadow }
}
/** Coloured text inside a black outline — the classic caption look. */
function outlined(color: string, strokeColor = '#000000'): TextStyle {
  return { color, strokeWidth: 0.08, strokeColor, background: noBg, shadow: softShadow }
}
/** Text on a solid block. */
function boxed(color: string, boxColor: string, opacity = 1): TextStyle {
  return { color, strokeWidth: 0, strokeColor: '#000000', background: bg(boxColor, opacity), shadow: noShadow }
}

/** Built-in presets, in strip order. First is always "None". */
export const TEXT_PRESETS: TextPreset[] = [
  { id: 'none', label: 'None', style: null },

  // — plain + outlined whites (the workhorses) —
  { id: 'white', label: 'White', style: plain('#ffffff') },
  { id: 'white-outline', label: 'White outline', style: outlined('#ffffff') },
  { id: 'white-soft', label: 'Soft white', style: { color: '#ffffff', strokeWidth: 0, strokeColor: '#000000', background: noBg, shadow: { enabled: true, color: '#000000', blur: 0.6, dx: 0, dy: 0.12 } } },
  { id: 'white-hard', label: 'Hard white', style: { color: '#ffffff', strokeWidth: 0.14, strokeColor: '#000000', background: noBg, shadow: noShadow } },

  // — colour pops, all outlined so they stay legible on any footage —
  { id: 'yellow', label: 'Yellow', style: outlined('#ffd60a') },
  { id: 'red', label: 'Red', style: outlined('#ff3b30') },
  { id: 'orange', label: 'Orange', style: outlined('#ff9f0a') },
  { id: 'blue', label: 'Blue', style: outlined('#0a84ff') },
  { id: 'green', label: 'Green', style: outlined('#30d158') },

  // — blocks —
  { id: 'box-dark', label: 'Dark box', style: boxed('#ffffff', '#1c1c1e', 0.85) },
  { id: 'box-grey', label: 'Grey box', style: boxed('#1c1c1e', '#c7c7cc') },
  { id: 'box-yellow', label: 'Yellow box', style: boxed('#1c1c1e', '#ffd60a') },
  { id: 'box-purple', label: 'Purple box', style: boxed('#ffffff', '#8a3ffc') },
  { id: 'box-white', label: 'White box', style: boxed('#8a3ffc', '#ffffff') },
  { id: 'box-black', label: 'Black box', style: boxed('#ffffff', '#000000') },
  { id: 'box-pink', label: 'Pink box', style: boxed('#ffffff', '#ff2d76') },

  // — inverted / accent —
  { id: 'black-on-white', label: 'Black on white', style: boxed('#000000', '#ffffff') },
  { id: 'green-on-black', label: 'Green on black', style: boxed('#30d158', '#000000') },
  { id: 'green-outline', label: 'Green outline', style: outlined('#30d158') },
  { id: 'gold', label: 'Gold', style: outlined('#e0a80d') },
  { id: 'gold-glow', label: 'Gold glow', style: { color: '#ffd60a', strokeWidth: 0.06, strokeColor: '#7a5c00', background: noBg, shadow: { enabled: true, color: '#7a5c00', blur: 0.7, dx: 0, dy: 0 } } },
  { id: 'mint', label: 'Mint', style: { color: '#30d158', strokeWidth: 0.06, strokeColor: '#0b3d1c', background: noBg, shadow: softShadow } }
]

// ---------------------------------------------------------------------------
// Custom presets — the user's own saved looks
// ---------------------------------------------------------------------------

const LS_KEY = 'ec.textPresets.custom'

/** Read the user's saved presets. Never throws: a corrupt/absent entry is "none
 *  saved yet", because a bad JSON blob must not take the whole panel down. */
export function loadCustomPresets(): TextPreset[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return []
    const v = JSON.parse(raw) as unknown
    if (!Array.isArray(v)) return []
    return v.filter(
      (p): p is TextPreset =>
        !!p && typeof p === 'object' && typeof (p as TextPreset).id === 'string' && !!(p as TextPreset).style
    ).map((p) => ({ ...p, custom: true }))
  } catch {
    return []
  }
}

function writeCustomPresets(list: TextPreset[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list))
  } catch {
    /* quota / private mode — the in-memory list still works for this session */
  }
}

/** Save `style` as a new custom preset and return the updated list. */
export function addCustomPreset(label: string, style: TextStyle): TextPreset[] {
  const next = [
    ...loadCustomPresets(),
    { id: `u${Date.now().toString(36)}`, label: label.trim() || 'My style', style, custom: true }
  ]
  writeCustomPresets(next)
  return next
}

export function removeCustomPreset(id: string): TextPreset[] {
  const next = loadCustomPresets().filter((p) => p.id !== id)
  writeCustomPresets(next)
  return next
}

/** `#rrggbb` + 0..1 alpha → `rgba(...)`, for drawing a preset's background in a
 *  swatch. CSS `opacity` would fade the "Aa" along with the box; the real
 *  renderer fades only the box, so the swatch has to bake alpha into the fill. */
export function bgFill(color: string, opacity: number): string {
  if (opacity >= 1) return color
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim())
  if (!m) return color
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${opacity})`
}

/** Look up a preset by id across the built-ins AND the user's saved ones, so a
 *  stored id (a caption batch's chosen look) resolves to a custom preset too. */
export function presetById(id: string): TextPreset | undefined {
  return TEXT_PRESETS.find((p) => p.id === id) ?? loadCustomPresets().find((p) => p.id === id)
}

/** Pull the preset-able look out of a live text clip, so "save current style"
 *  captures exactly what the swatches represent and nothing else. */
export function styleOf(t: TextContent): TextStyle {
  return {
    color: t.color,
    strokeWidth: t.strokeWidth,
    strokeColor: t.strokeColor,
    background: { ...t.background },
    shadow: { ...t.shadow }
  }
}

/** The patch that applies a preset. "None" resets the look to plain white. */
export function presetPatch(p: TextPreset): TextStyle {
  return (
    p.style ?? {
      color: '#ffffff',
      strokeWidth: 0,
      strokeColor: '#000000',
      background: { ...noBg, enabled: false },
      shadow: { ...noShadow }
    }
  )
}
