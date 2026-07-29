// A large selectable editing-mode card (icon + title + description).

import type { Preset } from '../types'
import { T } from './theme'

export function ModeCard({
  preset,
  selected,
  onSelect,
}: {
  preset: Preset
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className="ssc-card ssc-btn"
      onClick={onSelect}
      aria-pressed={selected}
      style={{
        position: 'relative',
        textAlign: 'left',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '16px 15px',
        borderRadius: 14,
        cursor: 'pointer',
        fontFamily: 'inherit',
        background: selected ? T.accentSoft : T.panel,
        border: `1px solid ${selected ? T.accentBorder : T.border}`,
        boxShadow: selected ? T.accentGlow : 'none',
        color: T.text,
        minHeight: 132,
      }}
    >
      {selected && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: T.accent,
            color: '#fff',
            fontSize: 11,
            fontWeight: 700,
            display: 'grid',
            placeItems: 'center',
            lineHeight: 1,
          }}
        >
          ✓
        </span>
      )}
      <span style={{ fontSize: 26, lineHeight: 1 }}>{preset.icon}</span>
      <span style={{ fontSize: 13.5, fontWeight: 650, color: selected ? '#fff' : T.text }}>
        {preset.title}
      </span>
      <span style={{ fontSize: 11.5, lineHeight: 1.45, color: T.textDim }}>{preset.description}</span>
    </button>
  )
}
