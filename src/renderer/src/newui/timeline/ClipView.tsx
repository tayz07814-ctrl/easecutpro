// A single clip block. A video/gif clip renders as one container: a title bar,
// a filmstrip fill, and — when it still owns its audio — a waveform band at the
// bottom sized by `waveSize` (CapCut's 30/60/100%). Audio clips are all
// waveform; images are filmstrip-only; text clips are a coloured label.
// The body starts a move-drag; the edge handles start a trim.

import { useCallback, useState } from 'react'
import { frameToPx } from './geometry'
import { WaveformCanvas } from './WaveformCanvas'
import { Filmstrip } from './Filmstrip'
import { useMediaData, clipPeaks } from './MediaData'
import type { Clip } from '@shared/timeline/types'
import type { Timebase } from '@shared/timeline/time'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'

export function ClipView({
  clip,
  zoom,
  tb,
  color,
  selected,
  waveSize,
  seamMs = 0,
  onClipPointerDown,
  onHandlePointerDown,
  onClipContextMenu
}: {
  clip: Clip
  zoom: number
  tb: Timebase
  color: string
  selected: boolean
  waveSize: number
  /** >0 = this clip starts at a cut seam with the audio blend on; render the ◢ marker. */
  seamMs?: number
  onClipPointerDown: (id: string, e: ReactPointerEvent) => void
  onHandlePointerDown: (id: string, edge: 'in' | 'out', e: ReactPointerEvent) => void
  onClipContextMenu: (id: string, e: ReactMouseEvent) => void
}): JSX.Element {
  const left = frameToPx(clip.start, zoom, tb)
  const width = Math.max(2, frameToPx(clip.duration, zoom, tb))

  const isVideo = clip.kind === 'video' || clip.kind === 'gif'
  const isImage = clip.kind === 'image'
  const isAudio = clip.kind === 'audio'
  const isText = clip.kind === 'text' || clip.kind === 'title'
  const showWave = clip.hasAudio && !clip.audioDetached && (isVideo || isAudio)
  const wavePct = Math.round(waveSize * 100)
  const media = useMediaData()
  const wf = showWave ? media?.getWaveform(clip) ?? null : null
  // The filmstrip reports what density this zoom needs; the provider then
  // fetches a finer strip for that window (see mediaManager detail tiers), so
  // zooming in actually resolves more of the footage instead of repeating one
  // still. Held in state so the request survives to the next render.
  const [density, setDensity] = useState<{ interval: number; from: number; to: number } | undefined>(undefined)
  const frames = isVideo || isImage ? media?.getFrames(clip, density) ?? null : null
  const onNeedDensity = useCallback((need: { interval: number; from: number; to: number }) => {
    setDensity((prev) =>
      prev && Math.abs(prev.interval - need.interval) < prev.interval * 0.25 && Math.abs(prev.from - need.from) < 0.5
        ? prev // same ask — don't churn renders while scrolling
        : need
    )
  }, [])

  // Zoom badge: the peak Ken Burns zoom applied to this clip (Auto Zoom or manual)
  // — ovScale × the larger of the start/end ramp. Shown in the clip's title bar.
  const m = clip.metadata
  const mn = (k: string): number => (typeof m?.[k] === 'number' ? (m[k] as number) : 1)
  const zPeak = mn('ovScale') * Math.max(mn('ovZoomStart'), mn('ovZoomEnd'))
  const zoomPct = isVideo && zPeak > 1.005 ? Math.round(zPeak * 100) : 0

  return (
    <div
      className={`ec-tl-clip kind-${clip.kind} ${selected ? 'sel' : ''}`}
      style={{ left, width, backgroundColor: color }}
      onPointerDown={(e) => onClipPointerDown(clip.id, e)}
      onContextMenu={(e) => onClipContextMenu(clip.id, e)}
    >
      {seamMs > 0 && (
        <div className="ec-tl-seam" title={`Audio blended over ${Math.round(seamMs)} ms at this cut`} />
      )}
      {isText ? (
        <div className="ec-tl-clip-text">
          <span>{clip.text?.text?.trim() || clip.name || 'Text'}</span>
        </div>
      ) : (
        <>
          <div className="ec-tl-clip-title">
            <span>{clip.name || clip.kind}</span>
          </div>
          {/* Applied zoom (Auto Zoom or manual Ken Burns), as a band you can read at
              a glance instead of squinting at the title: the fill tracks how far
              past 1.0× the punch-in goes, saturating at 2×. */}
          {zoomPct > 0 && (
            <div
              className="ec-tl-clip-zoom"
              title={`Punch-in ${zoomPct}% of the frame`}
              style={{ bottom: showWave && !isAudio ? `${wavePct}%` : 0 }}
            >
              <div className="ec-tl-clip-zoom-fill" style={{ width: `${Math.min(100, (zPeak - 1) * 100)}%` }} />
              <span className="ec-tl-clip-zoom-label">{zoomPct}%</span>
            </div>
          )}
          {(isVideo || isImage) && (
            <div
              className={`ec-tl-clip-film ${frames && frames.length > 0 ? 'has-frames' : ''}`}
              style={{ bottom: showWave && !isAudio ? `${wavePct}%` : 0 }}
            >
              {frames && frames.length > 0 && (
                <Filmstrip
                  frames={frames}
                  srcIn={clip.sourceIn}
                  srcOut={clip.sourceOut}
                  aspect={clip.srcW && clip.srcH ? clip.srcW / clip.srcH : 16 / 9}
                  onNeedDensity={onNeedDensity}
                />
              )}
            </div>
          )}
          {showWave &&
            (isAudio ? (
              <div className={`ec-tl-clip-wave audio ${wf ? 'has-canvas' : ''}`}>
                {wf && <WaveformCanvas peaks={clipPeaks(wf, clip.sourceIn, clip.sourceOut)} color="rgba(255,255,255,0.82)" />}
              </div>
            ) : (
              <div className={`ec-tl-clip-wave ${wf ? 'has-canvas' : ''}`} style={{ height: `${wavePct}%` }}>
                {wf && <WaveformCanvas peaks={clipPeaks(wf, clip.sourceIn, clip.sourceOut)} />}
              </div>
            ))}
        </>
      )}
      <div
        className="ec-tl-clip-handle l"
        onPointerDown={(e) => {
          e.stopPropagation()
          onHandlePointerDown(clip.id, 'in', e)
        }}
      />
      <div
        className="ec-tl-clip-handle r"
        onPointerDown={(e) => {
          e.stopPropagation()
          onHandlePointerDown(clip.id, 'out', e)
        }}
      />
    </div>
  )
}
