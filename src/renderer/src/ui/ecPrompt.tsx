// In-app replacement for window.prompt().
//
// Electron has never implemented prompt() and says so outright ("prompt() is and
// will not be supported"), so every naming flow that used it — new folder, new
// space, rename, username — threw on the desktop build instead of asking. This
// is the same question as a real dialog: focused input, Enter to confirm, Escape
// to cancel, resolves to the trimmed string or null.
//
// Async, unlike the native call it replaces, so callers must await it.

import { useEffect, useRef, useState } from 'react'

interface Req {
  message: string
  value: string
  okLabel: string
  resolve: (v: string | null) => void
}

let publish: ((r: Req) => void) | null = null

/**
 * Ask for a line of text. Resolves to the trimmed value, or null if the creator
 * cancelled or submitted an empty box (matching how the old prompt() callers all
 * treated a blank answer). Resolves null if the host isn't mounted rather than
 * hanging the caller forever.
 */
export function ecPrompt(message: string, value = '', okLabel = 'OK'): Promise<string | null> {
  return new Promise((resolve) => {
    if (!publish) {
      resolve(null)
      return
    }
    publish({ message, value, okLabel, resolve })
  })
}

/** Mount ONCE at the app root, beside the other global hosts. */
export function EcPromptHost(): JSX.Element | null {
  const [req, setReq] = useState<Req | null>(null)
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    publish = (r) => {
      setReq(r)
      setText(r.value)
    }
    return () => {
      publish = null
    }
  }, [])

  useEffect(() => {
    if (!req) return
    // Select the seeded text so a rename can be typed straight over.
    const id = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(id)
  }, [req])

  if (!req) return null

  const close = (v: string | null): void => {
    req.resolve(v)
    setReq(null)
  }
  const submit = (): void => {
    const t = text.trim()
    close(t ? t : null)
  }

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close(null)
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147483000,
        background: 'rgba(0,0,0,.55)',
        backdropFilter: 'blur(2px)',
        display: 'grid',
        placeItems: 'center',
        fontFamily: 'Geist, system-ui, sans-serif'
      }}
    >
      <div
        style={{
          width: 'min(420px, calc(100vw - 40px))',
          background: '#111117',
          border: '1px solid rgba(255,255,255,.1)',
          borderRadius: 14,
          padding: 18,
          boxShadow: '0 18px 60px rgba(0,0,0,.6)'
        }}
      >
        <div style={{ fontSize: 13.5, color: '#ededf2', lineHeight: 1.5 }}>{req.message}</div>
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              close(null)
            }
            e.stopPropagation() // the timeline's global shortcuts must not see this
          }}
          style={{
            width: '100%',
            marginTop: 12,
            background: '#0a0a0e',
            border: '1px solid rgba(255,255,255,.14)',
            borderRadius: 9,
            color: '#ededf2',
            font: 'inherit',
            fontSize: 13,
            padding: '10px 11px',
            outline: 'none'
          }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
          <button
            onClick={() => close(null)}
            style={{
              background: 'none',
              border: '1px solid rgba(255,255,255,.14)',
              color: '#c9c9da',
              font: 'inherit',
              fontSize: 12.5,
              borderRadius: 9,
              padding: '9px 16px',
              cursor: 'pointer'
            }}
          >
            Cancel
          </button>
          <button
            onClick={submit}
            style={{
              background: '#7c6bff',
              border: 'none',
              color: '#fff',
              font: 'inherit',
              fontSize: 12.5,
              fontWeight: 600,
              borderRadius: 9,
              padding: '9px 18px',
              cursor: 'pointer'
            }}
          >
            {req.okLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
