// Centered blocking overlay for the Find Cuts → Polishing flow.
//
// Two phases, both lock the editor (a full-screen backdrop captures every
// pointer/scroll event, so nothing can be edited while it's up):
//   • Finding cuts   — the retake job is running (cutJobActive).
//   • Polishing cuts — cuts are applied; the preview is decoding a landing
//     frame for every cut (seam cache) so the first playback is glitch-free.
//     Presented as "polishing" so the wait reads as finishing touches.

import { useStore } from '../../store'
import { css } from '../css'
import { useSmoothProgress } from '../../useSmoothProgress'

const ACCENT = '#7c6bff'

export default function CutProgressOverlay(): JSX.Element | null {
  const cutJobActive = useStore((s) => s.cutJobActive)
  const jobPct = useStore((s) => s.job.percent)
  const jobMsg = useStore((s) => s.job.message)
  const polishing = useStore((s) => s.polishing)

  const phase: 'finding' | 'polishing' | null = cutJobActive ? 'finding' : polishing.active ? 'polishing' : null
  // Hooks must run unconditionally — compute the smoothed value, then bail below.
  const findingPct = Math.round(useSmoothProgress(cutJobActive, jobPct))
  if (!phase) return null

  const finding = phase === 'finding'
  const pct = finding ? Math.max(2, findingPct) : Math.max(2, polishing.percent)
  const title = finding ? 'Finding cuts…' : 'Polishing cuts…'
  const sub = finding
    ? jobMsg || 'Analyzing your speech for retakes and dead air.'
    : 'Adding the finishing touches so playback stays perfectly smooth.'

  return (
    <div
      // z above the editor; captures all input → the editor is locked.
      style={css('position:fixed;inset:0;z-index:3000;display:grid;place-items:center;background:rgba(6,6,9,.72);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)')}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div style={css(`width:340px;max-width:88vw;background:#111117;border:1px solid rgba(255,255,255,.09);border-radius:16px;box-shadow:0 30px 80px rgba(0,0,0,.6);padding:26px 24px;text-align:center`)}>
        <div style={css(`width:38px;height:38px;margin:0 auto 16px;border-radius:11px;background:rgba(124,107,255,.16);display:grid;place-items:center`)}>
          <div style={css(`width:18px;height:18px;border-radius:50%;border:2.5px solid rgba(124,107,255,.3);border-top-color:${ACCENT};animation:ec-spin .8s linear infinite`)} />
        </div>
        <div style={css('font-size:16px;font-weight:650;letter-spacing:-.01em')}>{title}</div>
        <div style={css('font-size:12.5px;color:#9a9aae;margin-top:7px;line-height:1.5;min-height:38px')}>{sub}</div>
        <div style={css('height:5px;border-radius:3px;background:#22222b;overflow:hidden;margin-top:16px')}>
          <div style={css(`width:${pct}%;height:100%;border-radius:3px;background:${ACCENT};transition:width .25s ease`)} />
        </div>
        <div style={css("font-family:'Geist Mono',monospace;font-size:11px;color:#7a7a8c;margin-top:9px")}>{pct}%</div>
      </div>
      {/* spinner keyframes (scoped-ish; harmless global) */}
      <style>{'@keyframes ec-spin{to{transform:rotate(360deg)}}'}</style>
    </div>
  )
}
