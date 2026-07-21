// Single-colour line icons for the mobile UI (CapCut-style). All stroke
// currentColor so a button controls the colour; keep them minimal + consistent.
import type { JSX } from 'react'

export type IconName =
  | 'back' | 'undo' | 'redo' | 'play' | 'pause'
  | 'magnet' | 'snap' | 'trash' | 'split' | 'speed' | 'crop' | 'removeBg'
  | 'animation' | 'audioExtract' | 'adjust' | 'zoom' | 'duplicate' | 'lock'
  | 'replace' | 'more' | 'plus' | 'text' | 'music' | 'volume' | 'video' | 'overlay'
  | 'kfPrev' | 'kfNext' | 'kfAdd' | 'import' | 'cutlord' | 'export' | 'check' | 'captions'
  | 'edit' | 'effect' | 'scriptcut' | 'duration' | 'upscaler' | 'layers' | 'flip' | 'chevronDown'

const PATHS: Record<IconName, JSX.Element> = {
  back: <path d="M15 5l-7 7 7 7" />,
  undo: <><path d="M9 7L4 12l5 5" /><path d="M4 12h11a5 5 0 010 10h-1" /></>,
  redo: <><path d="M15 7l5 5-5 5" /><path d="M20 12H9a5 5 0 000 10h1" /></>,
  play: <path d="M7 4l13 8-13 8V4z" fill="currentColor" stroke="none" />,
  pause: <><rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" /></>,
  magnet: <><path d="M7 4v8a5 5 0 0010 0V4" /><path d="M5.5 4h3M15.5 4h3" /></>,
  snap: <><path d="M12 3v18" strokeDasharray="2 2.5" /><path d="M3 12h4M6 10l2 2-2 2" /><path d="M21 12h-4M18 10l-2 2 2 2" /></>,
  trash: <><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></>,
  split: <><circle cx="6" cy="7" r="2.5" /><circle cx="6" cy="17" r="2.5" /><path d="M8 8.5L20 17M8 15.5L20 7" /><path d="M12 12h0" /></>,
  speed: <><path d="M4 15a8 8 0 0116 0" /><path d="M12 15l4-4" /><circle cx="12" cy="15" r="1.3" fill="currentColor" stroke="none" /></>,
  crop: <><path d="M7 3v14a1 1 0 001 1h13" /><path d="M3 7h13a1 1 0 011 1v13" /></>,
  removeBg: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 15l4-4 3 3 4-4 5 5" /><path d="M4 8l4 4" strokeDasharray="1.5 2.5" /></>,
  animation: <><path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8L12 3z" /><path d="M18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9L18 15z" /></>,
  audioExtract: <><path d="M9 18V6l10-2v10" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="16.5" cy="14" r="2.5" /></>,
  adjust: <><path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4" /><circle cx="16" cy="6" r="2" fill="currentColor" stroke="none" /><circle cx="8" cy="12" r="2" fill="currentColor" stroke="none" /><circle cx="14" cy="18" r="2" fill="currentColor" stroke="none" /></>,
  zoom: <><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4M11 8v6M8 11h6" /></>,
  duplicate: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" /></>,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></>,
  replace: <><path d="M4 8a8 8 0 0114-4l2 2" /><path d="M20 16a8 8 0 01-14 4l-2-2" /><path d="M20 4v4h-4M4 20v-4h4" /></>,
  more: <><circle cx="6" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="18" cy="12" r="1.5" fill="currentColor" stroke="none" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  text: <path d="M5 6V5h14v1M12 5v14M9 19h6" />,
  music: <><path d="M9 18V5l10-2v13" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="16.5" cy="16" r="2.5" /></>,
  volume: <><path d="M5 9v6h4l5 4V5L9 9H5z" /><path d="M17 8a5 5 0 010 8" /></>,
  video: <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M10 9l5 3-5 3z" fill="currentColor" stroke="none" /></>,
  overlay: <><rect x="3" y="3" width="13" height="13" rx="2" /><rect x="8" y="8" width="13" height="13" rx="2" /></>,
  kfPrev: <><path d="M12 4l4 8-4 8-4-8 4-8z" /><path d="M9 7l-3 5 3 5" /></>,
  kfNext: <><path d="M12 4l4 8-4 8-4-8 4-8z" /><path d="M15 7l3 5-3 5" /></>,
  kfAdd: <><path d="M12 4l4 8-4 8-4-8 4-8z" /><path d="M12 9v6M9 12h6" stroke="#111" /></>,
  import: <><path d="M12 3v11M8 10l4 4 4-4" /><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" /></>,
  cutlord: <><path d="M12 3l1.6 4L18 8.6 13.6 10 12 14l-1.6-4L6 8.6 10.4 7 12 3z" /><path d="M18 14l.9 2.2L21 17l-2.1.8L18 20l-.9-2.2L15 17l2.1-.8L18 14z" /></>,
  export: <><path d="M12 15V4M8 8l4-4 4 4" /><path d="M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3" /></>,
  check: <path d="M5 12l5 5L20 7" />,
  captions: <><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M9.5 10.5a2.2 2.2 0 1 0 0 3M16 10.5a2.2 2.2 0 1 0 0 3" /></>,
  // Redesign (0.01) additions
  edit: <><circle cx="6" cy="7" r="2.3" /><circle cx="6" cy="17" r="2.3" /><path d="M7.9 8.4L19 16M7.9 15.6L19 8" /></>,
  effect: <path d="M13 3L5 13h5l-1 8 8-11h-5l1-7z" />,
  scriptcut: <><path d="M3 7h9M3 12h6M3 17h9" /><circle cx="18" cy="9" r="1.8" /><circle cx="18" cy="16" r="1.8" /><path d="M16.6 10.2L12.5 12.5l4.1 2.3" /></>,
  duration: <><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></>,
  upscaler: <><rect x="4" y="4" width="16" height="16" rx="2.5" /><path d="M10 8H8v2M14 8h2v2M10 16H8v-2M14 16h2v-2" /><path d="M12 10.5v3M10.5 12h3" /></>,
  layers: <><path d="M12 3l9 5-9 5-9-5 9-5z" /><path d="M3 13l9 5 9-5" /></>,
  flip: <><path d="M12 3v18" strokeDasharray="2 2" /><path d="M9 7L4 12l5 5V7z" fill="currentColor" stroke="none" /><path d="M15 7l5 5-5 5" /></>,
  chevronDown: <path d="M6 9l6 6 6-6" />
}

export function Icon({ name, size = 22 }: { name: IconName; size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {PATHS[name]}
    </svg>
  )
}
