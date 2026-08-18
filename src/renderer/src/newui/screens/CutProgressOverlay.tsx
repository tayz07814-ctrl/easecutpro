// Centered blocking overlay for long jobs. All phases lock the editor (a
// full-screen backdrop captures every pointer/scroll event, so nothing can be
// edited while it's up):
//   • Finding cuts    — the retake job is running (cutJobActive).
//   • Seam-cache warming is deliberately NOT listed here. It is optional
//     background preview work and must never lock the editor.
//   • Exporting video — an on-device render. It belongs here rather than inside
//     a tool panel: the editor must not be touched mid-render, and an export
//     reported from the Speech-cleaner panel read as "Finding cuts…" because
//     that panel only checked whether SOME job was active.

import { useStore } from '../../store'
import { css } from '../css'
import { useSmoothProgress } from '../../useSmoothProgress'

const ACCENT = '#7c6bff'

export default function CutProgressOverlay(): JSX.Element | null {
  const cutJobActive = useStore((s) => s.cutJobActive)
  const jobActive = useStore((s) => s.job.active)
  const jobKind = useStore((s) => s.job.kind)
  const jobPct = useStore((s) => s.job.percent)
  const jobMsg = useStore((s) => s.job.message)

  // EVERY long job lands here, in the middle of the screen. Each tool used to
  // draw its own bar wherever it happened to live, which meant a Variations or
  // Transcribe run reported itself inside the Speech cleaner panel — the one
  // place it had nothing to do with. One overlay, one bar, titled per tool.
  const TITLES: Record<string, [string, string]> = {
    export: ['Exporting video…', 'Rendering your edit. Keep this tab open until it finishes.'],
    transcribe: ['Ease Lord is transcribing…', 'Reading every word and its timing.'],
    silence: ['Ease Lord is judging true silence…', 'Listening for pauses that are safe to remove.'],
    variations: ['Casting variations…', 'Rebuilding your edit into alternate cuts.'],
    zoom: ['Planning Auto Zoom…', 'Picking the moments worth punching in on.'],
    broll: ['Placing b-roll…', 'Matching your overlay cards to what you talk about.'],
    probe: ['Importing…', 'Reading your media.']
  }
  // Seam caching is an optional background preview optimization. It is not a
  // blocking job and must never enter this full-screen overlay.
  const busy = jobActive || cutJobActive
  // Hooks must run unconditionally — compute the smoothed value, then bail below.
  const smoothPct = Math.round(useSmoothProgress(busy, jobPct, jobKind))
  if (!busy) return null

  const pct = Math.max(2, smoothPct)
  // A cut run reports through the shared transcribe/silence job kinds. The
  // message emitted by the store supplies the active Ease Lord phase.
  const known = jobActive && jobKind ? TITLES[jobKind] : undefined
  const easeLordPhase: [string, string] | undefined =
    jobActive && jobMsg?.startsWith('Ease Lord is ')
      ? [jobMsg, 'Ease Lord is preparing a reviewable edit.']
      : undefined
  const [title, subFallback] = easeLordPhase ?? (known
    ? known
    : cutJobActive
      ? ['Ease Lord is finding retakes…', 'Finding retakes, judging true silence, and preparing your review.']
       : ['Working…', ''])
  const sub = easeLordPhase
      ? subFallback
      : jobMsg || subFallback

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
