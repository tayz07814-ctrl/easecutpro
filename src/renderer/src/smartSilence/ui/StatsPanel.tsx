// Statistics panel — the numbers the engine reports for the current plan.

import type { Stats } from '../types'
import { fmtDuration } from '../stats'
import { MONO, T } from './theme'

function Tile({
  value,
  label,
  sub,
  accent,
}: {
  value: string
  label: string
  sub?: string
  accent?: string
}): JSX.Element {
  return (
    <div
      style={{
        background: T.panelAlt,
        border: `1px solid ${T.hair}`,
        borderRadius: 11,
        padding: '12px 13px',
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
      }}
    >
      <span style={{ fontFamily: MONO, fontSize: 18, fontWeight: 600, color: accent ?? T.text, lineHeight: 1.1 }}>
        {value}
      </span>
      <span style={{ fontSize: 11, color: T.textDim }}>{label}</span>
      {sub && <span style={{ fontSize: 10, color: T.textMute }}>{sub}</span>}
    </div>
  )
}

export function StatsPanel({ stats }: { stats: Stats }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Statistics</div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))',
          gap: 9,
        }}
      >
        <Tile value={fmtDuration(stats.timeSavedMs)} label="Time saved" accent={T.green} />
        <Tile value={`${stats.percentRemoved.toFixed(0)}%`} label="Removed" accent={T.accent} />
        <Tile
          value={`${stats.pausesRemoved}`}
          label="Pauses removed"
          sub={`of ${stats.pausesTotal} pauses`}
        />
        <Tile value={fmtDuration(stats.averagePauseMs)} label="Avg pause" />
        <Tile value={fmtDuration(stats.longestPauseMs)} label="Longest pause" />
        <Tile value={fmtDuration(stats.speechDurationMs)} label="Speech" />
        <Tile value={fmtDuration(stats.silenceDurationMs)} label="Silence" />
        {stats.fillersRemoved > 0 && (
          <Tile value={`${stats.fillersRemoved}`} label="Fillers removed" accent={T.orange} />
        )}
      </div>
    </div>
  )
}
