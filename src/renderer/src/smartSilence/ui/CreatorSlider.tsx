// A plain-language creator slider (0-100) with semantic end labels.

import { T } from './theme'

export function CreatorSlider({
  label,
  leftLabel,
  rightLabel,
  value,
  onChange,
}: {
  label: string
  leftLabel: string
  rightLabel: string
  value: number
  onChange: (value: number) => void
}): JSX.Element {
  const pct = Math.max(0, Math.min(100, value))
  const fill = `linear-gradient(90deg, ${T.accent} 0%, ${T.accent} ${pct}%, ${T.track} ${pct}%, ${T.track} 100%)`
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: T.text }}>{label}</div>
      <input
        className="ssc-range"
        type="range"
        min={0}
        max={100}
        step={1}
        value={pct}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%', background: fill }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: T.textMute }}>
        <span>{leftLabel}</span>
        <span>{rightLabel}</span>
      </div>
    </div>
  )
}
