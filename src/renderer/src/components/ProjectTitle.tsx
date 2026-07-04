import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'

/** Editable project name + a small Saving…/Saved indicator (used in the editor). */
export default function ProjectTitle({ compact }: { compact?: boolean }): JSX.Element {
  const name = useStore((s) => s.currentProjectName)
  const saveState = useStore((s) => s.saveState)
  const rename = useStore((s) => s.renameCurrentProject)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      setDraft(name)
      requestAnimationFrame(() => {
        ref.current?.focus()
        ref.current?.select()
      })
    }
  }, [editing, name])

  function commit(): void {
    const n = draft.trim()
    if (n && n !== name) rename(n)
    setEditing(false)
  }

  const status =
    saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Save failed' : ''

  return (
    <div className={'proj-title' + (compact ? ' compact' : '')}>
      {editing ? (
        <input
          ref={ref}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            else if (e.key === 'Escape') setEditing(false)
          }}
          maxLength={80}
        />
      ) : (
        <button className="proj-title-name" onClick={() => setEditing(true)} title="Rename project">
          {name || 'Untitled'}
        </button>
      )}
      {status && <span className={'save-dot ' + saveState}>{status}</span>}
    </div>
  )
}
