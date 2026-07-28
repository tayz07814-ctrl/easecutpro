// Auto Zoom — its own AI-panel tab (beside AI Cut). One button runs the Gemma
// zoom judge over the cut clips (store.runAutoZoom → cloud/autoZoom), and the panel
// lists WHICH clips ended up zoomed, read live from the timeline document so it
// reflects the real state (manual zooms show here too, and re-running updates it).

import { css } from '../css'
import { useStore } from '../../store'
import { useSharedEngineSnapshot } from '../../timelineEngine'
import { framesToSeconds } from '@shared/timeline/time'

function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

interface ZoomInfo {
  n: number
  startS: number
  endS: number
  pct: number
  style: 'push-in' | 'hold'
}

export default function AutoZoomPanel(): JSX.Element {
  const runAutoZoom = useStore((s) => s.runAutoZoom)
  const busy = useStore((s) => s.autoZoomBusy)
  const jobMsg = useStore((s) => s.job.message)
  const jobActive = useStore((s) => s.job.active)
  const setPlayhead = useStore((s) => s.setPlayhead)
  const setPlaying = useStore((s) => s.setPlaying)
  const snap = useSharedEngineSnapshot()
  const doc = snap?.doc

  // Derive the zoomed clips straight from the document (single source of truth).
  const main = doc?.tracks.find((t) => t.isMain)
  const tb = doc?.timebase
  const zoomed: ZoomInfo[] = []
  if (main && tb) {
    const clips = [...main.clips].sort((a, b) => a.start - b.start)
    clips.forEach((c, i) => {
      const scale = typeof c.metadata?.ovScale === 'number' ? c.metadata.ovScale : 1
      const zs = typeof c.metadata?.ovZoomStart === 'number' ? c.metadata.ovZoomStart : 1
      const ze = typeof c.metadata?.ovZoomEnd === 'number' ? c.metadata.ovZoomEnd : 1
      const peak = scale * Math.max(zs, ze)
      if (peak > 1.005) {
        zoomed.push({
          n: i + 1,
          startS: framesToSeconds(c.start, tb),
          endS: framesToSeconds(c.end, tb),
          pct: Math.round(peak * 100),
          style: ze > zs + 0.001 || zs > ze + 0.001 ? 'push-in' : 'hold'
        })
      }
    })
  }

  const clipCount = main?.clips.length ?? 0
  const canRun = clipCount >= 2 && !busy

  return (
    <div style={css('flex:1;min-height:0;overflow-y:auto;padding:16px')}>
      <div style={css('font-size:10px;font-weight:700;letter-spacing:.08em;color:#6e6e85;text-transform:uppercase;margin-bottom:8px')}>
        Auto Zoom
      </div>
      <p style={css('font-size:12px;color:#9a9aae;line-height:1.6;margin:0 0 14px')}>
        Gemma watches your cut clips and adds a dynamic punch-in to the key moments — so the edit
        feels alive instead of static. Re-run any time; it never doubles up.
      </p>

      <button
        onClick={() => void runAutoZoom()}
        disabled={!canRun}
        style={css(
          `width:100%;display:flex;align-items:center;justify-content:center;gap:8px;background:#7c6bff;border:none;color:#fff;font-family:inherit;font-size:13px;font-weight:600;border-radius:10px;padding:12px 0;box-shadow:0 6px 18px rgba(124,107,255,.3);opacity:${canRun ? 1 : 0.55};cursor:${canRun ? 'pointer' : 'default'}`
        )}
      >
        {busy ? '✨ Zooming the key moments…' : '✨ Auto Zoom the key moments'}
      </button>

      {clipCount < 2 && (
        <p style={css('font-size:11.5px;color:#6e6e85;line-height:1.6;margin:12px 0 0')}>
          Auto Zoom needs a few cut clips — run <b>Find Retakes &amp; Silence</b> in the AI Cut tab first.
        </p>
      )}

      {!busy && !jobActive && jobMsg && (
        <p style={css('font-size:12px;color:#9fdfbe;line-height:1.5;margin:12px 0 0')} role="status">
          {jobMsg}
        </p>
      )}

      {zoomed.length > 0 && (
        <>
          <div style={css('font-size:10px;font-weight:700;letter-spacing:.08em;color:#6e6e85;text-transform:uppercase;margin:18px 0 8px')}>
            Zoom applied · {zoomed.length} clip{zoomed.length === 1 ? '' : 's'}
          </div>
          <div style={css('display:flex;flex-direction:column;gap:6px')}>
            {zoomed.map((z) => (
              <button
                key={z.n}
                title="Jump to this clip"
                onClick={() => { setPlayhead(z.startS + 0.01); setPlaying(false) }}
                style={css('display:flex;align-items:center;gap:10px;text-align:left;background:#101015;border:1px solid rgba(255,255,255,.07);border-radius:9px;padding:9px 11px;cursor:pointer;font-family:inherit')}
              >
                <span style={css('flex:none;width:26px;height:26px;border-radius:7px;background:rgba(124,107,255,.16);color:#a99bff;display:grid;place-items:center;font-size:11px;font-weight:700')}>{z.n}</span>
                <span style={css('flex:1;min-width:0;display:flex;flex-direction:column;gap:1px')}>
                  <span style={css('font-size:12px;font-weight:600;color:#ededf2')}>Zoom {z.pct}% · {z.style}</span>
                  <span style={css("font-family:'Geist Mono',monospace;font-size:10px;color:#6e6e85")}>{mmss(z.startS)} – {mmss(z.endS)}</span>
                </span>
                <span style={css('flex:none;font-size:12px;color:#6e6e85')}>▶</span>
              </button>
            ))}
          </div>
        </>
      )}

      {!busy && zoomed.length === 0 && clipCount >= 2 && jobMsg && (
        <p style={css('font-size:11.5px;color:#6e6e85;line-height:1.6;margin:14px 0 0')}>
          No zooms are applied yet. Press <b>Auto Zoom</b> above to add them.
        </p>
      )}
    </div>
  )
}
