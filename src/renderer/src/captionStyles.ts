// Caption look presets.
//
// The catalogue IS the shared text-preset strip (textPresets.ts), so a look
// picked for captions is the same look the Edit tab offers for any text clip —
// including the user's own saved presets. There is no second, caption-only list
// to keep in sync.
//
// A preset carries only the LOOK (colour, stroke, background, shadow). Captions
// add the two things that are theirs and not part of a look: bold, and the
// caption size (0.0233 ≈ 7 on the editor scale, kept from the original default).

import type { TextContent } from '@shared/timeline/types'
import { presetById, presetPatch } from '@shared/textPresets'

/** Size + weight every caption gets, whichever look is chosen. */
const CAPTION_BASE: Partial<TextContent> = { bold: true, fontSize: 0.0233 }

/** Ids the old two-card picker used. Saved projects and any stale UI state can
 *  still hand these back, so keep them resolving instead of silently falling
 *  through to the default. */
const LEGACY: Record<string, string> = { clean: 'white-outline', boxed: 'box-black' }

export const DEFAULT_CAPTION_STYLE = 'white-outline'

/** Resolve a preset id to caption content (falls back to the default look). */
export function captionStyleContent(id: string | undefined): Partial<TextContent> {
  const wanted = (id && LEGACY[id]) || id || DEFAULT_CAPTION_STYLE
  const p = presetById(wanted) ?? presetById(DEFAULT_CAPTION_STYLE)
  return { ...CAPTION_BASE, ...(p ? presetPatch(p) : {}) }
}
