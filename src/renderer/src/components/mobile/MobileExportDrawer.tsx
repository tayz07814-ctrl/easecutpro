// Mobile export drawer (0.01 redesign) — the CapCut-style sheet the Export button
// opens. Resolution / Frame-rate / Code-rate sliders + a live estimated file size,
// then the on-device WebCodecs export. Resolution and code-rate drive the real
// encode (width/height + bitrate); frame-rate is shown for parity but the export
// currently renders at 30 fps (a fixed constant in localExport), noted inline.

import { useEffect, useMemo, useState } from 'react'
import { probeEncodeCaps, whyNotLocal, planFromDoc, type EncodeCaps } from '../../export/localExport'
import { useSharedEngineSnapshot } from '../../timelineEngine'
import { useStore } from '../../store'
import { Icon } from './Icon'

const RES = [
  { label: '480p', short: 480, tag: 'Data Saver' },
  { label: '720p', short: 720, tag: 'Space Saver' },
  { label: '1080p', short: 1080, tag: 'Recommended' },
  { label: '2K', short: 1440, tag: 'High' },
  { label: '4K', short: 2160, tag: 'Ultra' }
]
const FPS = [24, 25, 30, 50, 60]
const FPS_TAG: Record<number, string> = { 24: 'Cinematic', 25: 'PAL', 30: 'NTSC Standard', 50: 'PAL HFR', 60: 'Smooth' }
const RATE = [
  { label: 'Low', f: 0.6 },
  { label: 'Medium', f: 1 },
  { label: 'High', f: 1.6 }
]

/** A discrete slider — custom green track with a white-circle thumb + clickable
 *  tick stops and labels (matches the design). Same {stops, idx, onIdx} API. */
function StopSlider({ stops, idx, onIdx }: { stops: string[]; idx: number; onIdx: (i: number) => void }): JSX.Element {
  const n = Math.max(1, stops.length - 1)
  const pct = (idx / n) * 100
  return (
    <div className="mx-slider">
      <div className="mx-track">
        <div className="mx-track-bg" />
        <div className="mx-track-fill" style={{ width: `${pct}%` }} />
        {stops.map((s, i) => {
          const left = (i / n) * 100
          return (
            <div key={s} className="mx-stop" style={{ left: `${left}%` }} onClick={() => onIdx(i)}>
              <span className="mx-stop-tick" style={{ background: left <= pct ? '#7ed957' : '#3a3a40' }} />
            </div>
          )
        })}
        <div className="mx-thumb" style={{ left: `${pct}%` }} />
      </div>
      <div className="mx-ticks">
        {stops.map((s, i) => (
          <span key={s} className={'mx-tick' + (i === idx ? ' on' : '')} style={{ left: `${(i / n) * 100}%` }} onClick={() => onIdx(i)}>{s}</span>
        ))}
      </div>
    </div>
  )
}

export default function MobileExportDrawer(): JSX.Element | null {
  const show = useStore((s) => s.showExportModal)
  const close = useStore((s) => s.setShowExportModal)
  const project = useStore((s) => s.project)
  const exportVideoOnDevice = useStore((s) => s.exportVideoOnDevice)
  const snap = useSharedEngineSnapshot()

  const [caps, setCaps] = useState<EncodeCaps | null>(null)
  useEffect(() => {
    let alive = true
    void probeEncodeCaps().then((c) => alive && setCaps(c))
    return () => {
      alive = false
    }
  }, [])

  const [resI, setResI] = useState(1) // 720p
  const [fpsI, setFpsI] = useState(2) // 30
  const [rateI, setRateI] = useState(2) // High (matches the mockup default)

  // Output dimensions from the project's aspect at the chosen short-edge tier.
  const aw = project.aspectW || project.media?.width || 1080
  const ah = project.aspectH || project.media?.height || 1920
  const dims = useMemo(() => {
    const short = RES[resI].short
    const portrait = ah >= aw
    let w = portrait ? short : Math.round((short * aw) / ah)
    let h = portrait ? Math.round((short * ah) / aw) : short
    w -= w % 2
    h -= h % 2
    return { w: Math.max(16, w), h: Math.max(16, h) }
  }, [resI, aw, ah])

  const bitrate = Math.max(2, Math.round((RES[resI].short / 720) * 12 * RATE[rateI].f))

  const totalSec = useMemo(() => {
    try {
      return snap?.doc ? planFromDoc(snap.doc, project).total : 0
    } catch {
      return 0
    }
  }, [snap, project])
  const estMB = ((bitrate * totalSec) / 8).toFixed(2)

  const deviceOk = !!caps?.video
  const gate = deviceOk ? whyNotLocal(project) : ''
  const canExport = deviceOk && !gate

  if (!show) return null

  const filename = (project.name || 'export').trim()
  const run = (): void => {
    if (!canExport) return
    close(false)
    void exportVideoOnDevice({ width: dims.w, height: dims.h, bitrateMbps: bitrate, filename })
  }

  return (
    <div className="mx-back" onClick={() => close(false)}>
      <div className="mx-sheet ec-newui" onClick={(e) => e.stopPropagation()}>
        <div className="mx-head">
          <button className="mx-x" onClick={() => close(false)}>✕</button>
          <div className="mx-grow" />
          <span className="mx-respill">{RES[resI].label}<Icon name="chevronDown" size={16} /></span>
          <button className="mx-export" disabled={!canExport} onClick={run}>Export</button>
        </div>

        <div className="mx-body">
          <div className="mx-sec">
            <div className="mx-row"><span className="mx-label">Resolution</span><span className="mx-desc">{RES[resI].label} · {RES[resI].tag}</span></div>
            <StopSlider stops={RES.map((r) => r.label)} idx={resI} onIdx={setResI} />
          </div>

          <div className="mx-sec">
            <div className="mx-row"><span className="mx-label">Frame Rate (FPS)</span><span className="mx-desc">{FPS[fpsI]} · {FPS_TAG[FPS[fpsI]]}</span></div>
            <StopSlider stops={FPS.map(String)} idx={fpsI} onIdx={setFpsI} />
          </div>

          <div className="mx-sec">
            <div className="mx-row"><span className="mx-label">Code Rate (Mbps)</span><span className="mx-desc">{RATE[rateI].label} · {bitrate} Mbps</span></div>
            <StopSlider stops={RATE.map((r) => r.label)} idx={rateI} onIdx={setRateI} />
          </div>

          <div className="mx-est">Estimated file size: {estMB} MB</div>

          {!deviceOk && caps && (
            <div className="mx-note">This browser can’t encode video on-device — use Chrome/Edge on desktop or Android.</div>
          )}
          {deviceOk && gate && <div className="mx-note">Not available for this timeline yet: {gate}</div>}
          {FPS[fpsI] !== 30 && <div className="mx-note">Export currently renders at 30 fps — more frame rates are coming soon.</div>}
        </div>
      </div>
    </div>
  )
}
