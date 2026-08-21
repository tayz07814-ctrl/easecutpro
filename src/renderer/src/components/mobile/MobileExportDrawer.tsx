// Mobile export drawer — Flutter-parity (mobile/lib/sheets/export_sheet.dart)
// Aspect · Resolution · Frame rate · Quality as segmented chips, output summary,
// progress bar and Saved/Done state, Export gradient button. Matches pixel-close.

import { useEffect, useMemo, useState } from 'react'
import { probeEncodeCaps, whyNotLocal, planFromDoc, type EncodeCaps } from '../../export/localExport'
import { useSharedEngineSnapshot } from '../../timelineEngine'
import { useStore } from '../../store'
import { IS_WEB } from '../../platform'

const ASPECTS: Record<string, number> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '4:3': 4 / 3 }
const SHORT_SIDE: Record<string, number> = { '4K': 2160, '2K': 1440, '1080p': 1080, '720p': 720, '480p': 480 }

function even(v: number): number { return v % 2 === 0 ? v : v + 1 }

function Segment({ label, options, value, onPick }: { label: string; options: string[]; value: string; onPick: (v: string) => void }): JSX.Element {
  const many = options.length >= 6
  return (
    <div style={{ padding: '6px 0' }}>
      <div style={{ fontSize: 12.5, color: '#8F8F96', marginBottom: 7 }}>{label}</div>
      <div style={{ display: 'flex' }}>
        {options.map((o) => {
          const on = value === o
          return (
            <div key={o} onClick={() => onPick(o)} style={{ flex: 1, marginRight: many ? 4 : 6, padding: `${many ? 8 : 9}px 2px`, textAlign: 'center', borderRadius: 8, cursor: 'pointer', background: on ? 'rgba(110,106,232,.16)' : '#23252B', border: `1px solid ${on ? '#6E6AE8' : 'rgba(255,255,255,.06)' }`, color: on ? '#B7B5F4' : '#C6C9D2', fontSize: many ? 11 : 12.5, fontWeight: 600 }}>
              {o}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function MobileExportDrawer(): JSX.Element | null {
  const show = useStore((s) => s.showExportModal)
  const close = useStore((s) => s.setShowExportModal)
  const project = useStore((s) => s.project)
  const exportVideoOnDevice = useStore((s) => s.exportVideoOnDevice)
  const exportVideo = useStore((s) => s.exportVideo)
  const snap = useSharedEngineSnapshot()

  const [caps, setCaps] = useState<EncodeCaps | null>(null)
  useEffect(() => {
    if (!IS_WEB) return
    let alive = true
    void probeEncodeCaps().then((c) => alive && setCaps(c))
    return () => { alive = false }
  }, [])

  const [aspect, setAspect] = useState('Source')
  const [res, setRes] = useState('Source')
  const [fpsStr, setFpsStr] = useState('Source')
  const [quality, setQuality] = useState('High')
  const [exporting, setExporting] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const videoSize = useMemo(() => ({ w: project.media?.width || 1080, h: project.media?.height || 1920 }), [project.media])

  const out = useMemo(() => {
    const sw = Math.round(videoSize.w)
    const sh = Math.round(videoSize.h)
    const ratio = ASPECTS[aspect] ?? (sh > 0 ? sw / sh : 9 / 16)
    if (res === 'Source' && aspect === 'Source') return { w: even(sw), h: even(sh) }
    const target = SHORT_SIDE[res] ?? (sw <= sh ? sw : sh)
    const w = ratio >= 1 ? Math.round(target * ratio) : target
    const h = ratio >= 1 ? target : Math.round(target / ratio)
    return { w: even(Math.max(16, Math.min(8192, w))), h: even(Math.max(16, Math.min(8192, h))) }
  }, [videoSize, aspect, res])

  const fps = fpsStr === 'Source' ? 0 : parseInt(fpsStr, 10) || 0
  const bitrateMbps = useMemo(() => {
    if (quality === 'High') return 14
    if (quality === 'Medium') return 9
    if (quality === 'Low') return 5
    // Auto — scale with short side like the previous web logic
    const short = SHORT_SIDE[res] ?? 720
    return Math.max(4, Math.round((short / 720) * 9))
  }, [quality, res])

  const job = useStore((s) => s.job)
  useEffect(() => {
    if (!exporting) return
    if (job.kind === 'export' && job.active) return
    if (job.kind === 'export' && !job.active && job.percent === 100 && !(job.message ?? '').startsWith('Export failed')) {
      setDone((job.message as string) || 'Saved')
      setExporting(false)
    }
    if ((job.message ?? '').startsWith('Export failed')) {
      setError(job.message as string)
      setExporting(false)
    }
  }, [job, exporting])

  const deviceOk = IS_WEB ? !!caps?.video : true
  const gate = IS_WEB && deviceOk ? whyNotLocal(project) : ''
  const canExport = (IS_WEB ? deviceOk && !gate : true) && !exporting

  if (!show) return null
  const filename = (project.name || 'export').trim()

  const run = (): void => {
    if (!canExport) return
    setExporting(true)
    setDone(null)
    setError(null)
    if (IS_WEB) void exportVideoOnDevice({ width: out.w, height: out.h, bitrateMbps, filename })
    else void exportVideo({ width: out.w, height: out.h, bitrateMbps, filename })
  }

  return (
    <div onClick={() => close(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(8,8,10,.6)', zIndex: 1000, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#141418', borderTop: '1px solid rgba(255,255,255,.09)', borderRadius: '18px 18px 0 0', boxShadow: '0 -14px 44px rgba(0,0,0,.55)', display: 'flex', flexDirection: 'column', maxHeight: '92vh', height: '78vh' }}>
        <div style={{ display: 'grid', placeItems: 'center', padding: '10px 0 0' }}><div style={{ width: 38, height: 4, borderRadius: 2, background: 'rgba(255,255,255,.18)' }} /></div>
        <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 18px 6px' }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: '#E7E7EA' }}>Export</div>
          <span onClick={() => close(false)} style={{ fontSize: 18, color: '#8F8F96', cursor: 'pointer', padding: '4px 6px' }}>✕</span>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '4px 18px 18px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Segment label="Aspect ratio" options={['Source', '16:9', '9:16', '1:1', '4:5', '4:3']} value={aspect} onPick={setAspect} />
          <Segment label="Resolution" options={['Source', '4K', '2K', '1080p', '720p', '480p']} value={res} onPick={setRes} />
          <Segment label="Frame rate" options={['Source', '24', '30', '60']} value={fpsStr} onPick={setFpsStr} />
          <Segment label="Quality" options={['Auto', 'High', 'Medium', 'Low']} value={quality} onPick={setQuality} />
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0 6px', fontSize: 13 }}>
            <span style={{ color: '#8F8F96' }}>Output</span><span style={{ color: '#E7E7EA', fontWeight: 500 }}>{out.w} × {out.h} · {fps === 0 ? 'source' : `${fps}`} fps · {bitrateMbps} Mbps</span>
          </div>
          <div style={{ flex: 1 }} />
          {exporting && (
            <>
              <div style={{ height: 8, borderRadius: 6, background: '#17171B', overflow: 'hidden' }}>
                <div style={{ width: `${job.percent ?? 0}%`, height: '100%', background: '#A468FF', transition: 'width .2s' }} />
              </div>
              <div style={{ textAlign: 'center', color: '#C6C9D2', fontSize: 13, padding: '8px 0 0' }}>Exporting {Math.round(job.percent ?? 0)}% — {(job.message ?? '') as string}</div>
            </>
          )}
          {done && !exporting && (
            <div style={{ padding: 14, borderRadius: 12, background: '#17171B', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ color: '#7ED957', fontSize: 18 }}>✓</span><span style={{ color: '#7ED957', fontSize: 12.5 }}>{done}</span>
            </div>
          )}
          {error && <div style={{ color: '#FF6B6B', fontSize: 12.5 }}>{error}</div>}
          {IS_WEB && !deviceOk && caps && <div style={{ color: '#8F8F96', fontSize: 12.5 }}>This browser can’t encode video — use Chrome/Edge on desktop or Android.</div>}
          {gate && <div style={{ color: '#FF9B9B', fontSize: 12.5 }}>{gate}</div>}
          <div onClick={exporting ? undefined : run} style={{ marginTop: 14, height: 50, borderRadius: 12, display: 'grid', placeItems: 'center', cursor: exporting ? 'default' : 'pointer', opacity: canExport ? 1 : 0.5, background: 'linear-gradient(90deg,#7C5CFF,#A468FF)', boxShadow: '0 6px 18px rgba(124,92,255,.32)', color: '#fff', fontSize: 15, fontWeight: 700 }}>{done ? 'Export again' : exporting ? 'Exporting…' : 'Export'}</div>
        </div>
      </div>
    </div>
  )
}
