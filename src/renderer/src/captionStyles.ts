// Caption look presets (0.01). Two simple, visually distinct styles the user can
// pick before generating captions. The content is a Partial<TextContent> merged
// over defaultTextContent() in addDocTexts, so leaving fontFamily out lets each
// caption inherit the user's chosen default font. fontSize 0.0233 ≈ 7 on the
// editor scale (kept from the original caption default).

import type { TextContent } from '@shared/timeline/types'

export interface CaptionStyle {
  id: string
  label: string
  /** one-line description for the picker. */
  hint: string
  content: Partial<TextContent>
}

export const CAPTION_STYLES: CaptionStyle[] = [
  {
    id: 'clean',
    label: 'Clean',
    hint: 'White text, black outline',
    content: { bold: true, fontSize: 0.0233, strokeWidth: 0.09, strokeColor: '#000000', color: '#ffffff' }
  },
  {
    id: 'boxed',
    label: 'Boxed',
    hint: 'White text on a black bar',
    content: {
      bold: true,
      fontSize: 0.0233,
      strokeWidth: 0,
      color: '#ffffff',
      background: { enabled: true, color: '#000000', opacity: 1, radius: 0.22, padding: 0.34 }
    }
  }
]

export const DEFAULT_CAPTION_STYLE = CAPTION_STYLES[0].id

/** Resolve a style id to its caption content (falls back to the first style). */
export function captionStyleContent(id: string | undefined): Partial<TextContent> {
  const found = typeof id === 'string' ? CAPTION_STYLES.find((s) => s.id === id) : undefined
  return (found ?? CAPTION_STYLES[0]).content
}
