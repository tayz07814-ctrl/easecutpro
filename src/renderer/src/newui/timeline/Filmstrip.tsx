// Filmstrip: tiles a source's decoded frames across the clip, choosing the
// nearest frame for each tile position mapped into the clip's [sourceIn,
// sourceOut] range. Tile width follows the source aspect, so vertical (9:16)
// phone clips get narrow tiles like CapCut. Frame DATA (base64 JPEG data URLs)
// comes from the media-data provider.

import { useEffect, useRef, useState } from 'react'
import type { ClipFrame } from './MediaData'

export function Filmstrip({
  frames,
  srcIn,
  srcOut,
  aspect
}: {
  frames: ClipFrame[]
  srcIn: number
  srcOut: number
  aspect: number
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [tiles, setTiles] = useState<{ url: string; width: number }[]>([])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const compute = (): void => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (w <= 0 || h <= 0 || frames.length === 0) {
        setTiles([])
        return
      }
      const tileW = Math.max(16, h * (aspect > 0 ? aspect : 16 / 9))
      const count = Math.max(1, Math.ceil(w / tileW))
      const span = Math.max(1e-3, srcOut - srcIn)
      const out: { url: string; width: number }[] = []
      for (let i = 0; i < count; i++) {
        const t = srcIn + ((i + 0.5) / count) * span
        let best = frames[0]
        for (const f of frames) if (Math.abs(f.time - t) < Math.abs(best.time - t)) best = f
        out.push({ url: best.url, width: w / count })
      }
      setTiles(out)
    }
    const ro = new ResizeObserver(compute)
    ro.observe(el)
    compute()
    return () => ro.disconnect()
  }, [frames, srcIn, srcOut, aspect])

  return (
    <div className="ec-tl-filmstrip" ref={ref}>
      {tiles.map((t, i) => (
        <div key={i} className="ec-tl-frame" style={{ width: t.width, backgroundImage: `url(${t.url})` }} />
      ))}
    </div>
  )
}
