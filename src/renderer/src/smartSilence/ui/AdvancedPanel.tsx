// Collapsible Advanced panel — the raw engine parameters (power users).
// Collapsed by default. Editing any value switches the mode to Custom (handled
// by the parent via onParam).

import type { SilenceSettings } from '../types'
import * as config from '../config'
import { MONO, T } from './theme'

type ParamKey =
  | 'minGapMs'
  | 'targetPauseMs'
  | 'sentencePauseMs'
  | 'commaPauseMs'
  | 'mergeGapMs'
  | 'padBeforeMs'
  | 'padAfterMs'

interface Field {
  key: ParamKey
  label: string
  min: number
  max: number
}

const FIELDS: Field[] = [
  { key: 'minGapMs', label: 'Minimum Gap', min: config.BOUNDS_MIN_GAP_MS[0], max: config.BOUNDS_MIN_GAP_MS[1] },
  { key: 'targetPauseMs', label: 'Target Pause', min: config.BOUNDS_TARGET_PAUSE_MS[0], max: config.BOUNDS_TARGET_PAUSE_MS[1] },
  { key: 'sentencePauseMs', label: 'Sentence Pause', min: config.BOUNDS_SENTENCE_PAUSE_MS[0], max: config.BOUNDS_SENTENCE_PAUSE_MS[1] },
  { key: 'commaPauseMs', label: 'Comma Pause', min: config.BOUNDS_COMMA_PAUSE_MS[0], max: config.BOUNDS_COMMA_PAUSE_MS[1] },
  { key: 'mergeGapMs', label: 'Merge Gap', min: config.BOUNDS_MERGE_GAP_MS[0], max: config.BOUNDS_MERGE_GAP_MS[1] },
  { key: 'padBeforeMs', label: 'Padding Before', min: config.BOUNDS_PAD_MS[0], max: config.BOUNDS_PAD_MS[1] },
  { key: 'padAfterMs', label: 'Padding After', min: config.BOUNDS_PAD_MS[0], max: config.BOUNDS_PAD_MS[1] },
]

function ParamRow({
  field,
  value,
  onChange,
}: {
  field: Field
  value: number
  onChange: (v: number) => void
}): JSX.Element {
  const pct = field.max > field.min ? ((value - field.min) / (field.max - field.min)) * 100 : 0
  const clamped = Math.max(0, Math.min(100, pct))
  const fill = `linear-gradient(90deg, ${T.accent} 0%, ${T.accent} ${clamped}%, ${T.track} ${clamped}%, ${T.track} 100%)`
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 12, color: T.textDim }}>{field.label}</span>
        <span style={{ fontFamily: MONO, fontSize: 11.5, color: T.text }}>{Math.round(value)} ms</span>
      </div>
      <input
        className="ssc-range"
        type="range"
        min={field.min}
        max={field.max}
        step={5}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%', background: fill }}
      />
    </div>
  )
}

export function AdvancedPanel({
  open,
  onToggle,
  settings,
  onParam,
}: {
  open: boolean
  onToggle: () => void
  settings: SilenceSettings
  onParam: (key: ParamKey, value: number) => void
}): JSX.Element {
  return (
    <div
      style={{
        background: T.panel,
        border: `1px solid ${T.border}`,
        borderRadius: 14,
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        className="ssc-ghost"
        onClick={onToggle}
        aria-expanded={open}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 16px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontFamily: 'inherit',
          color: T.text,
        }}
      >
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'left' }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Advanced</span>
          <span style={{ fontSize: 11, color: T.textDim }}>Exact values, in milliseconds</span>
        </span>
        <span
          aria-hidden
          style={{
            color: T.textDim,
            fontSize: 12,
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform .16s ease',
          }}
        >
          ▾
        </span>
      </button>
      {open && (
        <div
          style={{
            padding: '4px 16px 18px',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
            gap: '16px 22px',
            borderTop: `1px solid ${T.hair}`,
          }}
        >
          {FIELDS.map((f) => (
            <ParamRow key={f.key} field={f} value={settings[f.key]} onChange={(v) => onParam(f.key, v)} />
          ))}
        </div>
      )}
    </div>
  )
}
