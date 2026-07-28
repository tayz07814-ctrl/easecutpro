// A lightweight right-click menu. Closes on outside-click or Escape. Positions
// itself at (x,y) and nudges back on-screen if it would overflow the viewport.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface MenuItem {
  label?: string
  onClick?: () => void
  danger?: boolean
  disabled?: boolean
  separator?: boolean
}

export function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const nx = x + r.width > window.innerWidth ? Math.max(4, window.innerWidth - r.width - 4) : x
    const ny = y + r.height > window.innerHeight ? Math.max(4, window.innerHeight - r.height - 4) : y
    setPos({ x: nx, y: ny })
  }, [x, y])

  useEffect(() => {
    const down = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key)
    }
  }, [onClose])

  return (
    <div
      className="ec-tl-menu"
      ref={ref}
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="ec-tl-menu-sep" />
        ) : (
          <button
            key={i}
            className={`ec-tl-menu-item ${it.danger ? 'danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              it.onClick?.()
              onClose()
            }}
          >
            {it.label}
          </button>
        )
      )}
    </div>
  )
}
