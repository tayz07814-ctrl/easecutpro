// Single-colour line icons for the mobile UI (CapCut-style). All stroke
// currentColor so a button controls the colour; keep them minimal + consistent.
import type { JSX } from 'react'

export type IconName =
  | 'back' | 'undo' | 'redo' | 'play' | 'pause'
  | 'magnet' | 'snap' | 'trash' | 'split' | 'speed' | 'crop' | 'removeBg'
  | 'animation' | 'audioExtract' | 'adjust' | 'zoom' | 'duplicate' | 'lock'
  | 'replace' | 'more' | 'plus' | 'text' | 'music' | 'volume' | 'video'
  | 'kfPrev' | 'kfNext' | 'kfAdd' | 'import' | 'cutlord' | 'export' | 'check'

const PATHS: Record<IconName, JSX.Element> = {
  back: <path d="M15 5l-7 7 7 7" />,
  undo: <><path d="M9 7L4 12l5 5" /><path d="M4 12h11a5 5 0 010 10h-1" /></>,
  redo: <><path d="M15 7l5 5-5 5" /><path d="M20 12H9a5 5 0 000 10h1" /></>,
  play: <path d="M7 4l13 8-13 8V4z" fill="currentColor" stroke="none" />,
  pause: <><rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" /></>,
  magnet: <><path d="M6 3v8a6 6 0 0012 0V3" /><path d="M6 3H3M21 3h-3M6 9H3M21 9h-3" /></>,
  snap: <><path d="M4 8V5a1 1 0 011-1h3M20 8V5a1 1 0 00-1-1h-3M4 16v3a1 1 0 001 1h3M20 16v3a1 1 0 01-1 1h-3" /><path d="M12 8v8" /></>,
  trash: <><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></>,
  split: <><circle cx="6" cy="7" r="2.5" /><circle cx="6" cy="17" r="2.5" /><path d="M8 8.5L20 17M8 15.5L20 7" /><path d="M12 12h0" /></>,
  speed: <><path d="M12 20a8 8 0 108-8" /><path d="M4 12a8 8 0 012-5.3" /><path d="M12 12l4-3" /></>,
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
  kfPrev: <><path d="M12 4l4 8-4 8-4-8 4-8z" /><path d="M9 7l-3 5 3 5" /></>,
  kfNext: <><path d="M12 4l4 8-4 8-4-8 4-8z" /><path d="M15 7l3 5-3 5" /></>,
  kfAdd: <><path d="M12 4l4 8-4 8-4-8 4-8z" /><path d="M12 9v6M9 12h6" stroke="#111" /></>,
  import: <><path d="M12 3v11M8 10l4 4 4-4" /><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" /></>,
  cutlord: <><path d="M12 3l1.6 4L18 8.6 13.6 10 12 14l-1.6-4L6 8.6 10.4 7 12 3z" /><path d="M18 14l.9 2.2L21 17l-2.1.8L18 20l-.9-2.2L15 17l2.1-.8L18 14z" /></>,
  export: <><path d="M12 15V4M8 8l4-4 4 4" /><path d="M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3" /></>,
  check: <path d="M5 12l5 5L20 7" />
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
