// Smart Silence Cleaner UI — self-contained design tokens + scoped CSS.
//
// This page depends on NOTHING from the rest of the app's styles. Everything is
// either an inline style object built from these tokens or one of the scoped
// `.ssc-*` classes below (injected once by the page). Dark aesthetic matching
// the host app (accent #7c6bff on near-black panels).

export const T = {
  pageBg: '#0d0d12',
  panel: '#14141b',
  panelAlt: '#101017',
  raised: '#1b1b24',
  border: 'rgba(255,255,255,0.08)',
  hair: 'rgba(255,255,255,0.06)',
  text: '#ededf2',
  textDim: '#9a9aae',
  textMute: '#6b6b80',
  accent: '#7c6bff',
  accentSoft: 'rgba(124,107,255,0.14)',
  accentBorder: 'rgba(124,107,255,0.55)',
  accentGlow: '0 8px 24px rgba(124,107,255,0.28)',
  green: '#57d9a3',
  orange: '#e6b26a',
  red: '#ff8a8a',
  speech: '#8b83ff',
  track: '#26262f',
  removed: '#ff7a7a',
} as const

export const MONO = "'Geist Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace"

/** Injected once by the page. Handles range inputs + hover/press transitions. */
export const SCOPED_CSS = `
.ssc-root *{box-sizing:border-box}
.ssc-range{-webkit-appearance:none;appearance:none;height:6px;border-radius:999px;outline:none;cursor:pointer;padding:0;margin:0}
.ssc-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;border-radius:50%;background:#fff;border:3px solid ${T.accent};box-shadow:0 1px 6px rgba(0,0,0,.55);cursor:pointer}
.ssc-range::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:#fff;border:3px solid ${T.accent};box-shadow:0 1px 6px rgba(0,0,0,.55);cursor:pointer}
.ssc-range:focus-visible{box-shadow:0 0 0 3px ${T.accentSoft}}
.ssc-card{transition:transform .12s ease,border-color .12s ease,background .12s ease,box-shadow .12s ease}
.ssc-card:hover{transform:translateY(-2px)}
.ssc-btn{transition:filter .12s ease,transform .06s ease,opacity .12s ease}
.ssc-btn:hover{filter:brightness(1.08)}
.ssc-btn:active{transform:translateY(1px)}
.ssc-ghost:hover{background:rgba(255,255,255,.05)}
`
