import { useEffect, useState } from 'react'
import { probeEncodeCaps, whyNotLocal, type EncodeCaps } from '../export/localExport'
import { useSharedEngineSnapshot } from '../timelineEngine'
import { IS_WEB, IS_CLOUD } from '../platform'
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

/** Output size tiers, named by their SHORT edge (the way creators think about
 *  it — "1080p" is 1080 tall in landscape and 1080 wide in portrait). */
const RES_TIERS: { label: string; short: number }[] = [
  { label: '480p', short: 480 },
  { label: '720p', short: 720 },
  { label: '1080p', short: 1080 },
  { label: '2K', short: 1440 },
  { label: '4K', short: 2160 }
]

/** Width/height from an aspect (null = the source's own) at a short-edge tier.
 *  Even numbers — H.264 chroma requires it. */
function dimsFrom(
  ratio: [number, number] | null,
  short: number,
  srcW: number,
  srcH: number
): { w: number; h: number } {
  const rw = ratio ? ratio[0] : srcW || 16
  const rh = ratio ? ratio[1] : srcH || 9
  const portrait = rh >= rw
  let w = portrait ? short : Math.round((short * rw) / rh)
  let h = portrait ? Math.round((short * rh) / rw) : short
  w -= w % 2
  h -= h % 2
  return { w: Math.max(16, w), h: Math.max(16, h) }
}

/** The tier closest to the source, so the default export matches what the
 *  creator shot instead of silently up- or down-scaling it. */
function nearestTier(srcW: number, srcH: number): number {
  const short = Math.min(srcW || 1080, srcH || 1920)
  return RES_TIERS.reduce((best, t) =>
    Math.abs(t.short - short) < Math.abs(best.short - short) ? t : best
  ).short
}

export default function ExportModal(): JSX.Element {
  // On-device (in-browser) export: shown on web when the browser can encode
  // H.264+AAC and the timeline only uses phase-1 features.
  const project = useStore((s) => s.project)
  const exportVideoOnDevice = useStore((s) => s.exportVideoOnDevice)
  const [caps, setCaps] = useState<EncodeCaps | null>(null)
  useEffect(() => {
    if (!IS_WEB) return
    let alive = true
    void probeEncodeCaps().then((c) => alive && setCaps(c))
    return () => {
      alive = false
    }
  }, [])
  // Video-capable is the real "can export on device" gate; audio may still be
  // missing (iOS Safari < 26), in which case we export video-only + warn.
  const deviceOk = !!caps?.video
  const audioMissing = !!caps?.video && !caps.audio
  const localGate = IS_WEB && deviceOk ? whyNotLocal(project) : ''
  const media = useStore((s) => s.project.media)
  const sequence = useStore((s) => s.project.baseSequence)
  const exportVideo = useStore((s) => s.exportVideo)
  const close = useStore((s) => s.setShowExportModal)

  const aspectW = useStore((s) => s.project.aspectW)
  const aspectH = useStore((s) => s.project.aspectH)
  // Doc-native projects don't set the legacy media/baseSequence fields — the
  // MAIN lane having clips is the real "there is something to export".
  const snap = useSharedEngineSnapshot()
  const hasBase = !!snap?.doc.tracks.some((t) => t.isMain && t.clips.length > 0)
  const canExport = !!media || !!(sequence && sequence.length) || hasBase
  const srcW = media?.width || sequence?.[0]?.srcW || 1920
  const srcH = media?.height || sequence?.[0]?.srcH || 1080
  const [bitrate, setBitrate] = useState(12)
  // Aspect (shape) and size tier are independent choices; width/height are
  // DERIVED from them. They used to be free-typed number boxes, which let a
  // creator produce odd or mismatched output without meaning to.
  const [active, setActive] = useState(aspectW && aspectH ? `${aspectW}:${aspectH}` : 'Source')
  const [tier, setTier] = useState(() => nearestTier(srcW, srcH))
  const ratio: [number, number] | null =
    active === 'Source' ? null : (PRESETS.find((p) => p.label === active)?.ratio ?? (aspectW && aspectH ? [aspectW, aspectH] : null))
  const { w, h } = dimsFrom(ratio, tier, srcW, srcH)
  // Output file name — defaults to the project title, editable by the creator.
  const [filename, setFilename] = useState(() => (project.name || 'export').trim())

  const estMbPerMin = Math.round((bitrate * 60) / 8)

  return (
    <div className="modal-backdrop" onMouseDown={() => close(false)}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Export settings</h3>
          <button onClick={() => close(false)}>✕</button>
        </div>

        <div className="exp-row">
          <span className="exp-label">File name</span>
          <input
            type="text"
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            placeholder={project.name || 'export'}
            style={{ flex: 1 }}
          />
          <span className="muted small">.mp4</span>
        </div>

        <div className="exp-row">
          <span className="exp-label">Aspect</span>
          <div className="exp-presets">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                className={'chip' + (active === p.label ? ' on' : '')}
                onClick={() => setActive(p.label)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="exp-row">
          <span className="exp-label">Resolution</span>
          <div className="exp-presets">
            {RES_TIERS.map((t) => (
              <button
                key={t.label}
                className={'chip' + (tier === t.short ? ' on' : '')}
                onClick={() => setTier(t.short)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <span className="muted small">{w}×{h}</span>
        </div>

        <div className="exp-row">
          <span className="exp-label">Bitrate</span>
          <input type="range" min={1} max={60} step={1} value={bitrate}
            onChange={(e) => setBitrate(Number(e.target.value))} style={{ flex: 1 }} />
          <span className="exp-val">{bitrate} Mbps</span>
        </div>
        <p className="muted small">~{estMbPerMin} MB per minute · content is letterboxed to fit the chosen resolution.</p>

        {audioMissing && (
          <p className="muted small">
            On iPhone/iPad this browser has no built-in audio encoder, so sound is encoded in-browser
            {' '}(beta) — the first export may take a little longer. The file includes full video + audio.
          </p>
        )}

        <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
          <button onClick={() => close(false)}>Cancel</button>
          {IS_WEB && deviceOk && (
            <button
              className={IS_CLOUD ? 'primary' : ''}
              disabled={!canExport || w < 16 || h < 16 || !!localGate}
              title={
                localGate
                  ? `Not available for this timeline yet: ${localGate}`
                  : 'Render + encode in this browser and save straight to this device — nothing is uploaded'
              }
              onClick={() => void exportVideoOnDevice({ width: w, height: h, bitrateMbps: bitrate, filename })}
            >
              📱 Export on this device {!IS_CLOUD && <span className="muted small">beta</span>}
            </button>
          )}
          {/* Cloud build has no server renderer — on-device export IS the export. */}
          {IS_CLOUD && caps && !caps.video && (
            <span className="muted small">
              This browser can't encode video — use Chrome/Edge on desktop or Android.
            </span>
          )}
          {!IS_CLOUD && (
            <button
              className="primary"
              disabled={!canExport || w < 16 || h < 16}
              onClick={() => exportVideo({ width: w, height: h, bitrateMbps: bitrate, filename })}
            >
              ⬆ Export
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
