// Standalone browser preview of the new timeline renderer. Seeds a TimelineEngine
// with a representative multi-track document (mirroring the desktop screenshot)
// and mounts <Timeline> with a small demo toolbar. This is a dev harness — the
// real app mounts <TimelinePanel> instead.

import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TimelineEngine } from '@shared/timeline/engine'
import { createTimeline, createClip } from '@shared/timeline/model'
import { FPS_30, secondsToFrames } from '@shared/timeline/time'
import * as C from '@shared/timeline/commands'
import { TimelineProvider, useEngine, useTimeline } from '@renderer/components/timeline/TimelineContext'
import { MediaDataProvider, type MediaData } from '@renderer/components/timeline/MediaData'
import Timeline from '@renderer/components/timeline/Timeline'
import MobileTimeline from '@renderer/components/timeline/MobileTimeline'
import { clamp, MIN_ZOOM, MAX_ZOOM } from '@renderer/components/timeline/geometry'
import '@renderer/styles.css'
import '@renderer/components/timeline/timeline.css'
import './demo.css'

function seed(): TimelineEngine {
  const e = new TimelineEngine(createTimeline(FPS_30))
  const F = (s: number): number => secondsToFrames(s, FPS_30)

  e.dispatch(C.addTrack('video', { id: 'ov', name: 'Overlay' }))
  e.dispatch(C.addTrack('text', { id: 't1', name: 'Text 1' }))
  e.dispatch(C.addTrack('text', { id: 't2', name: 'Text 2' }))
  e.dispatch(C.addTrack('video', { id: 'v1', name: 'Video 1' }))
  e.dispatch(C.addTrack('video', { id: 'v2', name: 'Main', main: true }))
  e.dispatch(C.addTrack('audio', { id: 'a1', name: 'Audio 1' }))
  e.dispatch(C.addTrack('audio', { id: 'a2', name: 'Audio 2' }))

  e.dispatch(C.addClip(createClip({ kind: 'image', trackId: 'ov', start: F(0.4), duration: F(2.2), name: 'Screenshot 1', sourcePath: 's1.png' })))
  e.dispatch(C.addClip(createClip({ kind: 'image', trackId: 'ov', start: F(3.0), duration: F(2.0), name: 'Screenshot 2', sourcePath: 's2.png' })))
  e.dispatch(C.addClip(createClip({ kind: 'image', trackId: 'ov', start: F(5.6), duration: F(3.2), name: 'Screenshot 2026-07-03', sourcePath: 's3.png' })))

  e.dispatch(C.addClip(createClip({ kind: 'text', trackId: 't1', start: F(1.2), duration: F(9.2), name: 'Depilación permanente' })))
  e.dispatch(C.addClip(createClip({ kind: 'text', trackId: 't2', start: F(0), duration: F(8.0), name: 'Depilación permanente' })))

  e.dispatch(C.addClip(createClip({ kind: 'video', trackId: 'v1', start: F(2.4), duration: F(91.5), name: 'MOV  00:01:31:14', sourcePath: 'mov.mp4', sourceIn: 0, sourceOut: 91.5, sourceDuration: 120 })))
  e.dispatch(C.addClip(createClip({ kind: 'video', trackId: 'v2', start: F(0), duration: F(91.5), name: 'Compound clip1  00:01:31:14', sourcePath: 'c1.mp4', sourceIn: 0, sourceOut: 91.5, sourceDuration: 120 })))

  e.dispatch(C.addClip(createClip({ kind: 'audio', trackId: 'a1', start: F(0), duration: F(91.5), name: 'Compound clip1', sourcePath: 'c1.wav', sourceIn: 0, sourceOut: 91.5, sourceDuration: 120 })))
  e.dispatch(C.addClip(createClip({ kind: 'audio', trackId: 'a2', start: F(6.5), duration: F(70), name: 'Compound clip2', sourcePath: 'c2.wav', sourceIn: 0, sourceOut: 70, sourceDuration: 120 })))

  e.setPlayhead(F(6))
  e.setZoom(14)
  return e
}

const engine = seed()
// Dev harness: expose for quick console/automation poking.
;(globalThis as unknown as { __ecEngine?: unknown }).__ecEngine = engine

// Synthetic audio peaks so the preview shows the REAL waveform renderer without
// ffmpeg. In the app this provider is backed by cache managers over window.api.
function hashSeed(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
function synthPeaks(seed: number, n: number): number[] {
  const out = new Array<number>(n)
  let a = seed || 1
  const rnd = (): number => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0
    return a / 4294967296
  }
  let env = 0.5
  for (let i = 0; i < n; i++) {
    env = Math.max(0.08, Math.min(1, env + (rnd() - 0.5) * 0.14))
    const syllable = 0.45 + 0.55 * Math.abs(Math.sin(i * 0.08) * Math.sin(i * 0.017))
    out[i] = Math.max(0.02, Math.min(1, env * syllable * (0.7 + 0.6 * rnd())))
  }
  return out
}
const waveCache = new Map<string, number[]>()
// Synthetic filmstrip frames (coloured SVG tiles) so the preview shows the REAL
// filmstrip renderer without ffmpeg — used to verify the top-thumbnails /
// bottom-waveform split on video clips.
const frameCache = new Map<string, { time: number; url: string }[]>()
function synthFrames(clip: { kind: string; sourcePath?: string; id: string; sourceIn: number; sourceOut: number }): { time: number; url: string }[] | null {
  if (clip.kind !== 'video' && clip.kind !== 'image' && clip.kind !== 'gif') return null
  const key = clip.sourcePath || clip.id
  let frames = frameCache.get(key)
  if (!frames) {
    const seed = hashSeed(key)
    const n = 12
    const span = Math.max(0.1, clip.sourceOut - clip.sourceIn)
    frames = []
    for (let i = 0; i < n; i++) {
      const hue = (seed + i * 41) % 360
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='48' height='32'><rect width='48' height='32' fill='hsl(${hue},52%,42%)'/><rect x='2' y='2' width='44' height='28' fill='none' stroke='hsl(${hue},60%,72%)'/><text x='24' y='21' font-family='sans-serif' font-size='13' fill='white' text-anchor='middle'>${i + 1}</text></svg>`
      frames.push({ time: clip.sourceIn + ((i + 0.5) / n) * span, url: 'data:image/svg+xml;base64,' + btoa(svg) })
    }
    frameCache.set(key, frames)
  }
  return frames
}
const demoMedia: MediaData = {
  getWaveform(clip) {
    if (!clip.hasAudio || clip.audioDetached) return null
    const key = clip.sourcePath || clip.id
    let peaks = waveCache.get(key)
    if (!peaks) {
      peaks = synthPeaks(hashSeed(key), 2000)
      waveCache.set(key, peaks)
    }
    return { peaksPerSec: 30, peaks }
  },
  getFrames(clip) {
    return synthFrames(clip)
  }
}

function Toolbar(): JSX.Element {
  const eng = useEngine()
  const { session, interaction } = useTimeline()
  const setZoom = (z: number): void => eng.setZoom(clamp(z, MIN_ZOOM, MAX_ZOOM))
  const cycleWave = (): void => {
    const sizes = [0.3, 0.6, 1]
    const i = sizes.indexOf(session.settings.waveformSize)
    eng.updateSettings({ waveformSize: sizes[(i + 1) % sizes.length] ?? 0.3 })
  }
  const detach = (): void => {
    const id = interaction.selection[0]
    if (id) eng.dispatch(C.detachAudio(id))
  }
  const importClip = (): void => {
    eng.dispatch(
      C.importToMain(
        createClip({
          kind: 'video',
          trackId: '',
          start: 0,
          duration: secondsToFrames(6, FPS_30),
          name: 'Imported.mp4',
          sourcePath: 'imp.mp4',
          sourceIn: 0,
          sourceOut: 6,
          sourceDuration: 30
        })
      )
    )
  }
  return (
    <div className="demo-bar">
      <span className="demo-brand">EaseCut<span>Pro</span> · Timeline</span>
      <button onClick={() => eng.undo()} disabled={!eng.canUndo()}>↶ Undo</button>
      <button onClick={() => eng.redo()} disabled={!eng.canRedo()}>↷ Redo</button>
      <span className="demo-sep" />
      <button onClick={() => setZoom(session.zoom / 1.3)}>–</button>
      <span className="demo-zoom">{Math.round(session.zoom)} px/s</span>
      <button onClick={() => setZoom(session.zoom * 1.3)}>+</button>
      <span className="demo-sep" />
      <button
        className={session.settings.magnet ? 'on' : ''}
        onClick={() => eng.updateSettings({ magnet: !session.settings.magnet })}
        title="Magnet: main lane clips stay attached (gapless). Off = main is free."
      >
        🧲 Magnet
      </button>
      <button
        className={session.settings.snapping ? 'on' : ''}
        onClick={() => eng.updateSettings({ snapping: !session.settings.snapping })}
        title="Snap edges to the playhead / other clips while dragging & trimming"
      >
        ⊹ Snap
      </button>
      <button onClick={() => eng.dispatch(C.addTrack('video'))}>+ Track</button>
      <button onClick={importClip} title="Import a clip onto the Main track">⤓ Import</button>
      <span className="demo-sep" />
      <button onClick={cycleWave} title="Audio waveform size">〜 Wave {Math.round(session.settings.waveformSize * 100)}%</button>
      <button onClick={detach} disabled={interaction.selection.length === 0} title="Detach audio from the selected clip">
        ✂ Detach audio
      </button>
      <span className="demo-hint">click a clip, then Detach audio · drag clips/edges · Ctrl+scroll zoom</span>
    </div>
  )
}

function DemoApp(): JSX.Element {
  const [mobile, setMobile] = useState(false)
  return (
    <TimelineProvider engine={engine}>
      <div className="demo-root">
        <Toolbar />
        <div className="demo-mobbar">
          <button className={mobile ? 'on' : ''} onClick={() => setMobile((m) => !m)}>
            {mobile ? '📱 Mobile view' : '🖥 Desktop view'}
          </button>
          <span className="demo-hint">{mobile ? 'scroll the timeline to scrub — the red centre line is the playhead' : ''}</span>
        </div>
        <div
          className="demo-tl"
          style={mobile ? { maxWidth: 400, width: '100%', margin: '0 auto', borderLeft: '1px solid var(--border)', borderRight: '1px solid var(--border)' } : undefined}
        >
          <MediaDataProvider value={demoMedia}>{mobile ? <MobileTimeline /> : <Timeline />}</MediaDataProvider>
        </div>
      </div>
    </TimelineProvider>
  )
}

// Reuse the root across HMR so hot-updates don't re-create it on the same node.
const container = document.getElementById('root') as HTMLElement
const rootStore = globalThis as unknown as { __ecRoot?: ReturnType<typeof createRoot> }
rootStore.__ecRoot ??= createRoot(container)
rootStore.__ecRoot.render(<DemoApp />)
