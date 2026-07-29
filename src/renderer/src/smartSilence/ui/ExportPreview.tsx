// Export preview — original length vs estimated output + the reduction.

import type { Stats } from '../types'
import { fmtDuration } from '../stats'
import { MONO, T } from './theme'

function Block({ value, label, accent }: { value: string; label: string; accent?: string }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <span style={{ fontFamily: MONO, fontSize: 22, fontWeight: 650, color: accent ?? T.text, lineHeight: 1 }}>
        {value}
      </span>
      <span style={{ fontSize: 11, color: T.textDim }}>{label}</span>
    </div>
  )
}

export function ExportPreview({ stats }: { stats: Stats }): JSX.Element {
  return (
    <div
      style={{
        background: T.panel,
        border: `1px solid ${T.border}`,
        borderRadius: 14,
        padding: '16px 18px',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        flexWrap: 'wrap',
      }}
    >
      <Block value={fmtDuration(stats.originalDurationMs)} label="Original" />
      <span style={{ color: T.textMute, fontSize: 18 }} aria-hidden>
        →
      </span>
      <Block value={fmtDuration(stats.outputDurationMs)} label="Estimated output" accent={T.accent} />
      <div style={{ flex: 1 }} />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 4,
          padding: '8px 14px',
          borderRadius: 11,
          background: 'rgba(87,217,163,0.1)',
          border: `1px solid rgba(87,217,163,0.3)`,
        }}
      >
        <span style={{ fontFamily: MONO, fontSize: 18, fontWeight: 650, color: T.green, lineHeight: 1 }}>
          −{stats.percentRemoved.toFixed(0)}%
        </span>
        <span style={{ fontSize: 10.5, color: T.textDim }}>
          {fmtDuration(stats.timeSavedMs)} shorter
        </span>
      </div>
    </div>
  )
}
