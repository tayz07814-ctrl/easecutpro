import { useState } from 'react'
import { useStore } from '../store'

interface Preset {
  label: string
  ratio: [number, number] | null // null = source
}
const PRESETS: Preset[] = [
  { label: 'Source', ratio: null },
  { label: '16:9', ratio: [16, 9] },
  { label: '9:16', ratio: [9, 16] },
  { label: '4:3', ratio: [4, 3] },
  { label: '3:4', ratio: [3, 4] },
  { label: '1:1', ratio: [1, 1] }
]

/** Pick width/height for a ratio, scaled to roughly match the source's pixel count. */
function dimsFor(ratio: [number, number], srcW: number, srcH: number): { w: number; h: number } {
  const longEdge = Math.max(srcW, srcH, 1080)
  if (ratio[0] >= ratio[1]) {
    const w = longEdge
    return { w, h: Math.round((w * ratio[1]) / ratio[0]) }
  }
  const h = longEdge
  return { w: Math.round((h * ratio[0]) / ratio[1]), h }
}

export default function ExportModal(): JSX.Element {
  const media = useStore((s) => s.project.media)
  const sequence = useStore((s) => s.project.baseSequence)
  const exportVideo = useStore((s) => s.exportVideo)
  const close = useStore((s) => s.setShowExportModal)

  const aspectW = useStore((s) => s.project.aspectW)
  const aspectH = useStore((s) => s.project.aspectH)
  const canExport = !!media || !!(sequence && sequence.length)
  const srcW = media?.width || sequence?.[0]?.srcW || 1920
  const srcH = media?.height || sequence?.[0]?.srcH || 1080
  // Default to the preview's locked aspect if one is set.
  const initial =
    aspectW && aspectH ? dimsFor([aspectW, aspectH], srcW, srcH) : { w: srcW, h: srcH }
  const [w, setW] = useState(initial.w)
  const [h, setH] = useState(initial.h)
  const [bitrate, setBitrate] = useState(12)
  const [active, setActive] = useState(aspectW && aspectH ? `${aspectW}:${aspectH}` : 'Source')

  function applyPreset(p: Preset): void {
    setActive(p.label)
    if (!p.ratio) {
      setW(srcW)
      setH(srcH)
    } else {
      const d = dimsFor(p.ratio, srcW, srcH)
      setW(d.w)
      setH(d.h)
    }
  }

  const estMbPerMin = Math.round((bitrate * 60) / 8)

  return (
    <div className="modal-backdrop" onMouseDown={() => close(false)}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Export settings</h3>
          <button onClick={() => close(false)}>✕</button>
        </div>

        <div className="exp-row">
          <span className="exp-label">Aspect</span>
          <div className="exp-presets">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                className={'chip' + (active === p.label ? ' on' : '')}
                onClick={() => applyPreset(p)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="exp-row">
          <span className="exp-label">Resolution</span>
          <input type="number" min={16} max={7680} step={2} value={w}
            onChange={(e) => { setW(Number(e.target.value)); setActive('Custom') }} />
          <span className="muted">×</span>
          <input type="number" min={16} max={7680} step={2} value={h}
            onChange={(e) => { setH(Number(e.target.value)); setActive('Custom') }} />
          <span className="muted small">px</span>
        </div>

        <div className="exp-row">
          <span className="exp-label">Bitrate</span>
          <input type="range" min={1} max={60} step={1} value={bitrate}
            onChange={(e) => setBitrate(Number(e.target.value))} style={{ flex: 1 }} />
          <span className="exp-val">{bitrate} Mbps</span>
        </div>
        <p className="muted small">~{estMbPerMin} MB per minute · content is letterboxed to fit the chosen resolution.</p>

        <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
          <button onClick={() => close(false)}>Cancel</button>
          <button
            className="primary"
            disabled={!canExport || w < 16 || h < 16}
            onClick={() => exportVideo({ width: w, height: h, bitrateMbps: bitrate })}
          >
            ⬆ Export
          </button>
        </div>
      </div>
    </div>
  )
}
