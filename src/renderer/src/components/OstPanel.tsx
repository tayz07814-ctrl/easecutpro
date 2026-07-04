import { useStore } from '../store'

/** OST (background music) tab — add a music track that plays under the edit. */
export default function OstPanel(): JSX.Element {
  const music = useStore((s) => s.project.music)
  const addMusic = useStore((s) => s.addMusic)
  const updateMusic = useStore((s) => s.updateMusic)
  const removeMusic = useStore((s) => s.removeMusic)
  const busy = useStore((s) => s.job.active)

  return (
    <div className="tool-content">
      <h4>Background music (OST)</h4>

      {!music ? (
        <>
          <p className="muted small">
            Add a music track that plays under your edit. It previews live and is mixed into
            the export, beneath the voice.
          </p>
          <button className="primary" onClick={addMusic} disabled={busy}>
            ＋ Add music
          </button>
        </>
      ) : (
        <>
          <div className="music-row">
            <span className="music-name" title={music.path}>♪ {music.name}</span>
            <button className="mini danger" onClick={removeMusic} title="Remove music">
              ✕
            </button>
          </div>

          <div className="slider-grid" style={{ marginTop: 10 }}>
            <label className="slider-row">
              <span className="slabel">Volume</span>
              <input
                type="range"
                min={0}
                max={150}
                step={1}
                value={Math.round(music.gain * 100)}
                onChange={(e) => updateMusic({ gain: Number(e.target.value) / 100 })}
              />
              <span className="val">{Math.round(music.gain * 100)}%</span>
            </label>
            <label className="slider-row">
              <span className="slabel">Start</span>
              <input
                type="range"
                min={0}
                max={60}
                step={0.5}
                value={music.startAt}
                onChange={(e) => updateMusic({ startAt: Math.max(0, Number(e.target.value)) })}
              />
              <span className="val">{music.startAt.toFixed(1)}s</span>
            </label>
          </div>

          <label className="inline-check" style={{ marginTop: 10 }}>
            <input
              type="checkbox"
              checked={music.loop}
              onChange={(e) => updateMusic({ loop: e.target.checked })}
            />{' '}
            Loop to fill the edit
          </label>

          <p className="muted small" style={{ marginTop: 10 }}>
            Length {music.duration ? `${music.duration.toFixed(1)}s` : '—'} · plays on the edited
            timeline. Preview volume caps at 100%; export honors the full range.
          </p>

          <button onClick={addMusic} disabled={busy} style={{ marginTop: 4 }}>
            Replace…
          </button>
        </>
      )}
    </div>
  )
}
