// Filmstrip: tiles a source's decoded frames across the clip, choosing the
// nearest frame for each tile position mapped into the clip's [sourceIn,
// sourceOut] range. Tile width follows the source aspect, so vertical (9:16)
// phone clips get narrow tiles like CapCut. Frame DATA (base64 JPEG data URLs)
// comes from the media-data provider.
//
// ONLY VISIBLE TILES ARE RENDERED. The clip element is as wide as the zoom makes
// it — at high zoom a long clip is millions of pixels — and a tile every ~40px
// across all of that meant tens of thousands of DOM nodes, each with its own
// background image. Now the strip measures its overlap with the scroll viewport
// and renders that span (plus a screen of margin) absolutely positioned, so the
// node count follows the WINDOW, not the clip length.
//
// It also reports the frame density the current zoom needs, so the provider can
// fetch a finer strip for this window; without that, zooming in just repeats the
// same still (the nearest-frame pick has nothing better to offer).

import { useEffect, useRef, useState } from 'react'
import type { ClipFrame } from './MediaData'

/** Nearest scrollable ancestor — what decides which part of us is on screen. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  let n = el?.parentElement ?? null
  while (n) {
    const o = getComputedStyle(n).overflowX
    if (o === 'auto' || o === 'scroll') return n
    n = n.parentElement
  }
  return null
}

export function Filmstrip({
  frames,
  srcIn,
  srcOut,
  aspect,
  onNeedDensity
}: {
  frames: ClipFrame[]
  srcIn: number
  srcOut: number
  aspect: number
  /** interval (seconds/frame) this zoom level needs, over [from,to] in SOURCE time */
  onNeedDensity?: (need: { interval: number; from: number; to: number }) => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [tiles, setTiles] = useState<{ url: string; left: number; width: number }[]>([])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const sp = scrollParent(el)
    let raf = 0
    const compute = (): void => {
      const w = el.clientWidth
      const h = el.clientHeight
      // Zero-sized means "not laid out yet", not "nothing to draw" — keep any
      // tiles already on screen and wait for the observer to fire again, so a
      // transient measurement can never blank the strip for good.
      if (w <= 0 || h <= 0) return
      if (frames.length === 0) {
        setTiles([])
        return
      }
      const tileW = Math.max(16, h * (aspect > 0 ? aspect : 16 / 9))
      const count = Math.max(1, Math.ceil(w / tileW))
      const span = Math.max(1e-3, srcOut - srcIn)

      // Visible slice of THIS strip, in its own pixel space, with a screen of
      // margin either side so scrolling reveals ready tiles.
      let firstIdx = 0
      let lastIdx = count - 1
      if (sp) {
        const a = el.getBoundingClientRect()
        const b = sp.getBoundingClientRect()
        const margin = b.width
        const visLeft = Math.max(0, b.left - a.left - margin)
        const visRight = Math.min(w, b.right - a.left + margin)
        if (visRight <= 0 || visLeft >= w) {
          setTiles([])
          return
        }
        firstIdx = Math.max(0, Math.floor(visLeft / (w / count)))
        lastIdx = Math.min(count - 1, Math.ceil(visRight / (w / count)))
      }

      const tw = w / count
      const out: { url: string; left: number; width: number }[] = []
      for (let i = firstIdx; i <= lastIdx; i++) {
        const t = srcIn + ((i + 0.5) / count) * span
        let best = frames[0]
        for (const f of frames) if (Math.abs(f.time - t) < Math.abs(best.time - t)) best = f
        out.push({ url: best.url, left: i * tw, width: tw })
      }
      setTiles(out)

      // Tell the provider what this zoom actually needs for the visible span.
      if (onNeedDensity && lastIdx >= firstIdx) {
        onNeedDensity({
          interval: span / count,
          from: srcIn + (firstIdx / count) * span,
          to: srcIn + ((lastIdx + 1) / count) * span
        })
      }
    }
    const schedule = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(compute)
    }
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    sp?.addEventListener('scroll', schedule, { passive: true })
    compute()
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      sp?.removeEventListener('scroll', schedule)
    }
  }, [frames, srcIn, srcOut, aspect, onNeedDensity])

  return (
    <div className="ec-tl-filmstrip" ref={ref}>
      {tiles.map((t, i) => (
        <div
          key={i}
          className="ec-tl-frame"
          style={{ position: 'absolute', left: t.left, top: 0, bottom: 0, width: t.width, backgroundImage: `url(${t.url})` }}
        />
      ))}
    </div>
  )
}
