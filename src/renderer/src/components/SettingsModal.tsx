import { useEffect, useState } from 'react'
import { useStore } from '../store'

type Action = 'split' | 'del' | 'undelete' | 'playPause'

const LABELS: Record<Action, string> = {
  split: 'Split at playhead',
  del: 'Delete selection',
  undelete: 'Restore / undelete selection',
  playPause: 'Play / Pause'
}

function fmtKey(k: string): string {
  if (k === ' ') return 'Space'
  if (k.length === 1) return k.toUpperCase()
  return k
}

export default function SettingsModal(): JSX.Element {
  const keybinds = useStore((s) => s.keybinds)
  const setKeybind = useStore((s) => s.setKeybind)
  const fillerWords = useStore((s) => s.fillerWords)
  const setFillerWords = useStore((s) => s.setFillerWords)
  const close = useStore((s) => s.setShowSettings)
  const [recording, setRecording] = useState<Action | null>(null)
  const [fillerText, setFillerText] = useState(fillerWords.join(', '))

  // Capture the next key while recording a binding.
  useEffect(() => {
    if (!recording) return
    function onKey(e: KeyboardEvent): void {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(null)
        return
      }
      setKeybind(recording as Action, e.key.length === 1 ? e.key.toLowerCase() : e.key)
      setRecording(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, setKeybind])

  return (
    <div className="modal-backdrop" onMouseDown={() => close(false)}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Settings · Keyboard shortcuts</h3>
          <button onClick={() => close(false)}>✕</button>
        </div>

        <div className="keybind-list">
          {(Object.keys(LABELS) as Action[]).map((a) => (
            <div className="keybind-row" key={a}>
              <span>{LABELS[a]}</span>
              <button
                className={'keycap' + (recording === a ? ' recording' : '')}
                onClick={() => setRecording(a)}
              >
                {recording === a ? 'Press a key…' : fmtKey(keybinds[a])}
              </button>
            </div>
          ))}
        </div>

        <p className="muted small">
          Click a shortcut, then press the key to rebind. Esc cancels. Transcript word
          deletion also responds to <b>Delete</b>/<b>Backspace</b>.
        </p>

        <h3 className="settings-sub">Filler words &amp; phrases</h3>
        <p className="muted small">
          Comma- or newline-separated. Multi-word entries (e.g. <i>you know</i>) match as
          phrases. Used by <b>Find fillers</b> (repeats &amp; stutters are detected automatically).
        </p>
        <textarea
          className="filler-input"
          value={fillerText}
          onChange={(e) => setFillerText(e.target.value)}
          rows={4}
          spellCheck={false}
        />
        <div className="row">
          <button
            className="primary"
            onClick={() => setFillerWords(fillerText.split(/[\n,]+/))}
          >
            Save list
          </button>
          <button
            onClick={() => {
              setFillerText(DEFAULT_FILLER_TEXT)
              setFillerWords(DEFAULT_FILLER_TEXT.split(/[\n,]+/))
            }}
          >
            Reset to defaults
          </button>
          <span className="muted small">{fillerWords.length} active</span>
        </div>
      </div>
    </div>
  )
}

const DEFAULT_FILLER_TEXT =
  'um, umm, uh, uhh, uhm, er, err, ah, hmm, mm, mhm, eh, like, basically, actually, ' +
  'literally, honestly, you know, i mean, sort of, kind of'
