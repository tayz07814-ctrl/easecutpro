// The "Aa" swatch strip — built-in text/caption looks plus the user's own.
//
// Each chip renders live from the preset it applies (same colour, stroke,
// background and shadow), so the strip IS the preview: no bitmaps to keep in
// sync with the styles.

import { useState } from 'react'
import { css } from '../css'
import { ecPrompt } from '../../ui/ecPrompt'
import {
  TEXT_PRESETS,
  addCustomPreset,
  bgFill,
  loadCustomPresets,
  presetPatch,
  removeCustomPreset,
  type TextPreset,
  type TextStyle
} from '@shared/textPresets'

// Every chip sits on the SAME neutral stand-in for footage. Without it a dark
// translucent box preset is indistinguishable from a chip with no box at all,
// and a white-text preset looks identical to a white box preset.
const CHIP_BACK = 'background:linear-gradient(135deg,#4a4a58,#1c1c24)'

/** The "Aa" itself, plus its box — drawn with the preset's own values. */
function chipGlyph(p: TextPreset): string {
  const s = p.style
  if (!s) return 'color:#c9c9da'
  // The glyph is ~15px, and the doc's stroke/shadow fractions are relative to
  // font size, so scale them or they render as invisible hairlines.
  const stroke = s.strokeWidth > 0 ? `-webkit-text-stroke:${(s.strokeWidth * 12).toFixed(2)}px ${s.strokeColor};` : ''
  const shadow = s.shadow.enabled
    ? `text-shadow:${(s.shadow.dx * 6).toFixed(1)}px ${(s.shadow.dy * 6).toFixed(1)}px ${(s.shadow.blur * 6).toFixed(1)}px ${s.shadow.color};`
    : ''
  // Alpha is baked into the fill, never applied as `opacity` — that would fade
  // the "Aa" along with its box, which the real renderer never does.
  const box = s.background.enabled
    ? `background:${bgFill(s.background.color, s.background.opacity)};padding:1px 5px;border-radius:3px;`
    : ''
  return `color:${s.color};${stroke}${shadow}${box}`
}

export default function TextPresetStrip({
  current,
  onApply,
  selectedId = null,
  title = 'Style presets'
}: {
  /** The selected clip's live look, for "save current style as preset". */
  current: TextStyle | null
  onApply: (style: TextStyle, preset: TextPreset) => void
  /** When set, that chip is ringed and the strip reads as a picker (the
   *  Captions tab, choosing a look before generating) rather than a
   *  fire-and-forget "restyle the selection" control (the Edit tab). */
  selectedId?: string | null
  title?: string
}): JSX.Element {
  const [custom, setCustom] = useState<TextPreset[]>(() => loadCustomPresets())

  const save = async (): Promise<void> => {
    if (!current) return
    const name = await ecPrompt('Name this style', 'My style')
    if (name === null) return
    setCustom(addCustomPreset(name, current))
  }

  const forget = (p: TextPreset): void => {
    setCustom(removeCustomPreset(p.id))
  }

  const all = [...TEXT_PRESETS, ...custom]

  return (
    <>
      <div style={css('display:flex;align-items:center;justify-content:space-between;margin-top:14px')}>
        <div style={css('font-size:10px;font-weight:700;letter-spacing:.08em;color:#6e6e85;text-transform:uppercase')}>{title}</div>
        <button
          onClick={() => void save()}
          disabled={!current}
          title={current ? 'Save the selected text’s current look as a preset' : 'Select some text first'}
          style={css(
            'background:none;border:1px solid rgba(255,255,255,.12);color:#c4baff;font-family:inherit;font-size:11px;border-radius:7px;padding:4px 9px;cursor:pointer',
            current ? '' : 'opacity:.45;cursor:default'
          )}
        >
          + Save current
        </button>
      </div>

      <div style={css('display:flex;flex-wrap:wrap;gap:7px;margin-top:9px')}>
        {all.map((p) => (
          <div key={p.id} style={css('position:relative')}>
            <div
              onClick={() => onApply(presetPatch(p), p)}
              title={p.label}
              style={css(
                'width:44px;height:34px;border-radius:8px;display:grid;place-items:center;cursor:pointer;font-weight:800;font-size:15px;user-select:none;border:1px solid rgba(255,255,255,.10);overflow:hidden',
                CHIP_BACK,
                selectedId === p.id ? 'border-color:#7c6bff;box-shadow:0 0 0 2px rgba(124,107,255,.55)' : ''
              )}
            >
              <span style={css('line-height:1.1', chipGlyph(p))}>{p.style === null ? '⊘' : 'Aa'}</span>
            </div>
            {p.custom && (
              // Only user presets can be removed — the built-ins are the catalogue.
              <div
                onClick={(e) => { e.stopPropagation(); forget(p) }}
                title={`Remove “${p.label}”`}
                style={css('position:absolute;right:-5px;top:-5px;width:16px;height:16px;border-radius:50%;background:#2a2a33;border:1px solid rgba(255,255,255,.18);color:#ff9b9b;font-size:11px;line-height:14px;text-align:center;cursor:pointer')}
              >
                ×
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  )
}
