// Centered blocking overlay for long jobs. All phases lock the editor (a
// full-screen backdrop captures every pointer/scroll event, so nothing can be
// edited while it's up):
//   • Finding cuts    — the retake job is running (cutJobActive).
//   • Polishing cuts  — cuts are applied; the preview is decoding a landing
//     frame for every cut (seam cache) so the first playback is glitch-free.
//     Presented as "polishing" so the wait reads as finishing touches.
//   • Exporting video — an on-device render. It belongs here rather than inside
//     a tool panel: the editor must not be touched mid-render, and an export
//     reported from the Speech-cleaner panel read as "Finding cuts…" because
//     that panel only checked whether SOME job was active.

import { useStore } from '../../store'
import { css } from '../css'
import { useSmoothProgress } from '../../useSmoothProgress'
import { useEffect, useRef } from 'react'

const ACCENT = '#7c6bff'
const ACCENT_DIM = 'rgba(124,107,255,.35)'
const ACCENT_GLOW = 'rgba(124,107,255,.55)'

// Professional ring progress component with multiple animated rings
export function RingProgress({ pct, size = 88, strokeWidth = 4 }:
  { pct: number; size?: number; strokeWidth?: number }) {
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - pct / 100)

  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      {/* Ambient glow ring */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={ACCENT_DIM}
        strokeWidth={strokeWidth * 1.8}
        strokeLinecap="round"
        filter="url(#glow)"
      />
      {/* Track ring */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="rgba(255,255,255,.06)"
        strokeWidth={strokeWidth}
      />
      {/* Progress ring with animated dash */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={ACCENT}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        style={{ transition: 'stroke-dashoffset 0.35s cubic-bezier(0.22, 1, 0.36, 1)' }}
      />
      {/* Leading dot on progress ring */}
      <defs>
        <filter id="glow">
          <feGaussianBlur stdDeviation="3" result="coloredBlur" />
          <feMerge>
            <feMergeNode in="coloredBlur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {pct > 0 && pct < 100 && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={ACCENT_GLOW}
          strokeWidth={strokeWidth + 1}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={
            {
              filter: 'url(#glow)',
              animation: 'pulseGlow 1.8s ease-in-out infinite'
            } as React.CSSProperties
          }
        />
      )}
    </svg>
  )
}

// Subtle floating particles in the background
export function ParticleField(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const frameRef = useRef<number>(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const particles = Array.from({ length: 18 }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: Math.random() * 1.2 + 0.4,
      vx: (Math.random() - 0.5) * 0.08,
      vy: (Math.random() - 0.5) * 0.08,
      opacity: Math.random() * 0.35 + 0.1
    }))
    let raf = 0
    const tick = () => {
      const dpr = window.devicePixelRatio || 1
      canvas.width = canvas.clientWidth * dpr
      canvas.height = canvas.clientHeight * dpr
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      for (const p of particles) {
        p.x += p.vx
        p.y += p.vy
        if (p.x < 0) p.x = 1
        if (p.x > 1) p.x = 0
        if (p.y < 0) p.y = 1
        if (p.y > 1) p.y = 0
        ctx.beginPath()
        ctx.arc(p.x * canvas.width, p.y * canvas.height, p.r * dpr, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(124,107,255,${p.opacity * 0.6})`
        ctx.fill()
      }
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [])

  return <canvas ref={canvasRef} style={css('position:absolute;inset:0;pointer-events:none')} />
}

// Scoped keyframes for pulse glow animation
const KEYFRAMES = `@keyframes pulseGlow{0%,100%{opacity:.15;stroke-width:inherit}50%{opacity:.5;stroke-width:calc(inherit + 1px)}}@keyframes ec-fade-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}@keyframes ec-slide-up{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}`

export default function CutProgressOverlay(): JSX.Element | null {
  const cutJobActive = useStore((s) => s.cutJobActive)
  const jobActive = useStore((s) => s.job.active)
  const jobKind = useStore((s) => s.job.kind)
  const jobPct = useStore((s) => s.job.percent)
  const jobMsg = useStore((s) => s.job.message)
  const polishing = useStore((s) => s.polishing)

  // EVERY long job lands here, in the middle of the screen. Each tool used to
  // draw its own bar wherever it happened to live, which meant a Variations or
  // Transcribe run reported itself inside the Speech cleaner panel — the one
  // place it had nothing to do with. One overlay, one bar, titled per tool.
  const TITLES: Record<string, [string, string]> = {
    export: ['Exporting video…', 'Rendering your edit. Keep this tab open until it finishes.'],
    transcribe: ['Ease Lord is transcribing…', 'Reading the speech in your video.'],
    silence: ['Ease Lord is judging silence…', 'Analyzing speech cadence and dead air.'],
    variations: ['Ease Lord is casting variations…', 'Rebuilding your edit into alternate cuts.'],
    zoom: ['Planning Auto Zoom…', 'Picking the moments worth punching in on.'],
    broll: ['Placing b-roll…', 'Matching your overlay cards to what you talk about.'],
    probe: ['Importing…', 'Reading your media.']
  }
  const busy = jobActive || cutJobActive || polishing.active
  // Hooks must run unconditionally — compute the smoothed value, then bail below.
  const smoothPct = Math.round(useSmoothProgress(busy && !polishing.active, jobPct, jobKind))
  if (!busy) return null

  const pct = polishing.active && !jobActive ? Math.max(2, polishing.percent) : Math.max(2, smoothPct)
  // A cut run reports untagged, so cutJobActive is what names it.
  const known = jobActive && jobKind ? TITLES[jobKind] : undefined
  const [title, subFallback] = known
    ? known
    : cutJobActive
      ? ['Ease Lord is finding cuts…', 'Analyzing your speech for retakes and dead air.']
      : polishing.active
        ? ['Polishing cuts…', 'Adding the finishing touches so playback stays perfectly smooth.']
        : ['Working…', '']
  const sub = polishing.active && !jobActive ? subFallback : jobMsg || subFallback

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
