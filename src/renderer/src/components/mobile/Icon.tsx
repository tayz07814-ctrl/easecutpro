// Mobile UI icons (0.01 reskin) — Material Symbols Outlined, rendered from a
// self-hosted 17 KB codepoint subset (see @font-face `.ec-msym` in styles.css;
// no CDN / no CSP change — the font is served same-origin). The component keeps
// its original { name, size } API so every MobileTools / MobileEditor call site
// is unchanged; each IconName maps to a Material glyph codepoint. `fill` renders
// the filled variant (FILL axis) for the play/pause transport glyphs.
import type { JSX } from 'react'

export type IconName =
  | 'back' | 'undo' | 'redo' | 'play' | 'pause'
  | 'magnet' | 'snap' | 'trash' | 'split' | 'speed' | 'crop' | 'removeBg'
  | 'animation' | 'audioExtract' | 'adjust' | 'zoom' | 'duplicate' | 'lock'
  | 'replace' | 'more' | 'plus' | 'text' | 'music' | 'volume' | 'video' | 'overlay'
  | 'kfPrev' | 'kfNext' | 'kfAdd' | 'import' | 'cutlord' | 'export' | 'check' | 'captions'
  | 'edit' | 'effect' | 'scriptcut' | 'duration' | 'upscaler' | 'layers' | 'flip' | 'chevronDown'
  | 'folder' | 'folderOpen' | 'groups' | 'batch' | 'search' | 'close' | 'cutout'

// IconName -> Material Symbols Outlined codepoint. These are the exact glyphs
// baked into newui/fonts/MaterialSymbols-subset.woff2 (referenced by codepoint,
// not ligature, so the subset stays ~17 KB). Comment = the Material glyph name.
const CP: Record<IconName, number> = {
  back: 0xe5c4,          // arrow_back
  undo: 0xe166,          // undo
  redo: 0xe15a,          // redo
  play: 0xe037,          // play_arrow
  pause: 0xe034,         // pause
  magnet: 0xe260,        // linear_scale
  snap: 0xe3ec,          // grid_on
  trash: 0xe92e,         // delete
  split: 0xe949,         // vertical_split
  speed: 0xe9e4,         // speed
  crop: 0xe3be,          // crop
  removeBg: 0xf20a,      // background_replace
  animation: 0xe71c,     // animation
  audioExtract: 0xe1b8,  // graphic_eq
  adjust: 0xe429,        // tune
  zoom: 0xe8ff,          // zoom_in
  duplicate: 0xe14d,     // content_copy
  lock: 0xe899,          // lock
  replace: 0xe86a,       // cached
  more: 0xe5d3,          // more_horiz
  plus: 0xe145,          // add
  text: 0xe262,          // text_fields
  music: 0xe405,         // music_note
  volume: 0xe050,        // volume_up
  video: 0xe684,         // movie
  overlay: 0xe8aa,       // picture_in_picture
  kfPrev: 0xe045,        // skip_previous
  kfNext: 0xe044,        // skip_next
  kfAdd: 0xe86b,         // change_history
  import: 0xf09b,        // file_upload
  cutlord: 0xea0b,       // bolt
  export: 0xf090,        // download
  check: 0xe668,         // check
  captions: 0xe996,      // closed_caption
  edit: 0xe14e,          // content_cut
  effect: 0xea0b,        // bolt
  scriptcut: 0xea0b,     // bolt
  duration: 0xefd6,      // schedule
  upscaler: 0xe65f,      // auto_awesome
  layers: 0xe53b,        // layers
  flip: 0xe3e8,          // flip
  chevronDown: 0xe313,   // keyboard_arrow_down
  folder: 0xe2c7,        // folder
  folderOpen: 0xe2c8,    // folder_open
  groups: 0xf233,        // groups
  batch: 0xeb68,         // auto_fix_high
  search: 0xe8b6,        // search
  close: 0xe5cd,          // close
  cutout: 0xe2cc          // content_cut (Cutout)
}

export function Icon({ name, size = 22, fill = false }: { name: IconName; size?: number; fill?: boolean }): JSX.Element {
  // Split gets a bespoke `]|[` mark (CapCut-style: two brackets facing a centre
  // cut line) instead of a Material glyph — drawn as an SVG so it stays crisp and
  // inherits the button's text colour via currentColor.
  if (name === 'split') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden style={{ display: 'block' }}>
        <path d="M7 5 h3 v14 h-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M12 3 v18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="2.6 2.4" />
        <path d="M17 5 h-3 v14 h3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  return (
    <span className={'ec-msym' + (fill ? ' fill' : '')} style={{ fontSize: size }} aria-hidden>
      {String.fromCodePoint(CP[name])}
    </span>
  )
}
