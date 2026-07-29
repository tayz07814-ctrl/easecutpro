// Live Original-vs-Processed timeline. Pure recompute from words + plan — no
// audio, no rendering. Two bars share the SAME time scale so the Processed bar
// is visibly shorter (the empty tail = time saved).

import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { SilencePlan, Word } from '../types'
import { fmtDuration } from '../stats'
import { MONO, T } from './theme'

const VW = 1000 // viewBox width (user units)
const BAR_H = 34

interface Seg {
  a: number
  b: number
  o: number
}

function LegendDot({ color, label }: { color: string; label: string }): JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 10, height: 10, borderRadius: 3, background: color, flex: 'none' }} />
      <span style={{ fontSize: 10.5, color: T.textDim }}>{label}</span>
    </span>
  )
}

function Bar({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div style={{ borderRadius: 8, overflow: 'hidden', background: T.track, height: BAR_H, border: `1px solid ${T.hair}` }}>
      <svg
        viewBox={`0 0 ${VW} ${BAR_H}`}
        width="100%"
        height={BAR_H}
        preserveAspectRatio="none"
        style={{ display: 'block' }}
      >
        {children}
      </svg>
    </div>
  )
}

export function TimelinePreview({ words, plan }: { words: Word[]; plan: SilencePlan }): JSX.Element {
  const duration = plan.originalDurationMs
  const hasFiller = plan.cuts.some((c) => c.reason === 'filler')

  const model = useMemo(() => {
    if (duration <= 0) return null
    const sx = VW / duration

    // compacted-time segments (keep ranges with cumulative offsets)
    let acc = 0
    const segs: Seg[] = plan.keeps.map(([a, b]) => {
      const s = { a, b, o: acc }
      acc += b - a
      return s
    })
    const outputMs = acc
    const mapStart = (t: number): number | null => {
      for (const s of segs) if (t >= s.a - 1e-6 && t <= s.b + 1e-6) return s.o + (t - s.a)
      return null
    }

    const speech = words.map((w) => ({
      x: w.startMs * sx,
      w: Math.max(0, (w.endMs - w.startMs) * sx),
    }))
    const removed = plan.cuts.map((c) => ({
      x: c.startMs * sx,
      w: Math.max(0, c.removedMs * sx),
      color: c.reason === 'filler' ? T.orange : T.removed,
    }))
    const procSpeech = words
      .map((w) => {
        const cs = mapStart(w.startMs)
        return cs === null ? null : { x: cs * sx, w: Math.max(0, (w.endMs - w.startMs) * sx) }
      })
      .filter((v): v is { x: number; w: number } => v !== null)

    return { sx, speech, removed, procSpeech, outputW: outputMs * sx, outputMs }
  }, [words, plan, duration])

  if (!model) {
    return (
      <div style={{ padding: 20, color: T.textMute, fontSize: 12 }}>No transcript to preview.</div>
    )
  }

  const savedW = Math.max(0, VW - model.outputW)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Original */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: T.textDim, letterSpacing: 0.2 }}>ORIGINAL</span>
          <span style={{ fontFamily: MONO, fontSize: 11, color: T.textMute }}>{fmtDuration(duration)}</span>
        </div>
        <Bar>
          {model.speech.map((r, i) => (
            <rect key={`s${i}`} x={r.x} y={0} width={r.w} height={BAR_H} fill={T.speech} />
          ))}
          {model.removed.map((r, i) => (
            <rect key={`r${i}`} x={r.x} y={0} width={r.w} height={BAR_H} fill={r.color} opacity={0.9} />
          ))}
        </Bar>
      </div>

      {/* Processed */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: T.accent, letterSpacing: 0.2 }}>PROCESSED</span>
          <span style={{ fontFamily: MONO, fontSize: 11, color: T.textMute }}>{fmtDuration(model.outputMs)}</span>
        </div>
        <Bar>
          {/* saved tail */}
          {savedW > 0.5 && (
            <>
              <rect x={model.outputW} y={0} width={savedW} height={BAR_H} fill={T.removed} opacity={0.1} />
              <line x1={model.outputW} y1={0} x2={model.outputW} y2={BAR_H} stroke={T.removed} strokeWidth={1} opacity={0.5} />
            </>
          )}
          {model.procSpeech.map((r, i) => (
            <rect key={`p${i}`} x={r.x} y={0} width={r.w} height={BAR_H} fill={T.accent} />
          ))}
        </Bar>
      </div>

      {/* legend */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 18px', paddingTop: 2 }}>
        <LegendDot color={T.speech} label="Speech" />
        <LegendDot color={T.track} label="Kept pause" />
        <LegendDot color={T.removed} label="Removed silence" />
        {hasFiller && <LegendDot color={T.orange} label="Filler" />}
      </div>
    </div>
  )
}
