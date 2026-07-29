// A labelled on/off toggle row (pill switch).

import { T } from './theme'

export function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description?: string
  checked: boolean
  onChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 14,
        width: '100%',
        textAlign: 'left',
        padding: '11px 13px',
        borderRadius: 11,
        cursor: 'pointer',
        fontFamily: 'inherit',
        background: checked ? T.accentSoft : T.panelAlt,
        border: `1px solid ${checked ? T.accentBorder : T.border}`,
        color: T.text,
      }}
    >
      <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</span>
        {description && (
          <span style={{ fontSize: 11, lineHeight: 1.4, color: T.textDim }}>{description}</span>
        )}
      </span>
      <span
        aria-hidden
        style={{
          flex: 'none',
          width: 38,
          height: 22,
          borderRadius: 999,
          background: checked ? T.accent : '#2c2c37',
          position: 'relative',
          transition: 'background .14s ease',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: checked ? 18 : 2,
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: '#fff',
            transition: 'left .14s ease',
            boxShadow: '0 1px 3px rgba(0,0,0,.4)',
          }}
        />
      </span>
    </button>
  )
}
