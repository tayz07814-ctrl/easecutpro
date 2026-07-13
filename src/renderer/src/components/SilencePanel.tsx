import { useStore } from '../store'
import { editedDuration } from '@shared/edit'

export default function SilencePanel(): JSX.Element {
  const project = useStore((s) => s.project)
  const silences = project.silences
  const setAction = useStore((s) => s.setSilenceAction)
  const setShorten = useStore((s) => s.setSilenceShorten)
  const removeAll = useStore((s) => s.removeAllSilence)
  const detect = useStore((s) => s.detectSilence)
  const hasMedia = !!project.media || ((project.baseSequence?.length ?? 0) > 0)
  const setPlayhead = useStore((s) => s.setPlayhead)
  const opts = useStore((s) => s.silenceOpts)
  const setOpts = useStore((s) => s.setSilenceOpts)
  const setPadding = useStore((s) => s.setSilencePadding)

  const srcDur = project.media?.duration ?? 0
  const saved = srcDur > 0 ? srcDur - editedDuration(project) : 0
  const mode = opts.mode ?? 'vad'

  return (
    <div className="silence-panel">
      <div className="row head">
        <h3>Silences &amp; pauses</h3>
        <div className="spacer" />
        {saved > 0.05 && <span className="badge ok">−{saved.toFixed(1)}s</span>}
        <button onClick={detect} disabled={!hasMedia}>Detect</button>
        <button onClick={removeAll} disabled={!silences.length}>Remove all</button>
      </div>

      <div className="silence-opts">
        <div className="row" style={{ gap: 4, marginBottom: 8, alignItems: 'center' }}>
          <span className="muted small">Mode</span>
          <button
            className={'mini toggle' + (mode === 'vad' ? ' on' : '')}
            onClick={() => setOpts({ mode: 'vad' })}
            title="Detects real speech, ignores background noise (recommended)"
          >
            ✨ Smart (VAD)
          </button>
          <button
            className={'mini toggle' + (mode === 'fast' ? ' on' : '')}
            onClick={() => setOpts({ mode: 'fast' })}
            title="Fast, but fooled by background noise"
          >
            Fast (dB)
          </button>
        </div>

        {mode === 'fast' ? (
          <label>
            Threshold
            <input
              type="range" min={-60} max={-10} step={1}
              value={opts.noiseDb}
              onChange={(e) => setOpts({ noiseDb: Number(e.target.value) })}
            />
            <span className="val">{opts.noiseDb} dB</span>
          </label>
        ) : (
          <label>
            Speech threshold
            <input
              type="range" min={10} max={90} step={5}
              value={Math.round((opts.vadThreshold ?? 0.5) * 100)}
              onChange={(e) => setOpts({ vadThreshold: Number(e.target.value) / 100 })}
            />
            <span className="val">{Math.round((opts.vadThreshold ?? 0.5) * 100)}%</span>
          </label>
        )}

        <label>
          Min gap
          <input
            type="number" min={0.1} max={5} step={0.1}
            value={opts.minDuration}
            onChange={(e) => setOpts({ minDuration: Number(e.target.value) })}
          />s
        </label>
        <label>
          Padding
          <input
            type="number" min={0} max={0.5} step={0.01}
            value={project.silencePadding}
            onChange={(e) => setPadding(Number(e.target.value))}
          />s
        </label>
        {mode === 'vad' && (
          <label title="Eat this much extra audio off BOTH sides of every cut for tighter, snappier cuts.">
            Trim cuts
            <input
              type="number" min={0} max={0.5} step={0.05}
              value={(opts.edgeTrimMs ?? 0) / 1000}
              onChange={(e) =>
                setOpts({ edgeTrimMs: Math.max(0, Math.round(Number(e.target.value) * 1000)) })
              }
            />s
          </label>
        )}
        {mode === 'vad' && (
          <label
            className="row"
            style={{ alignItems: 'center', gap: 6 }}
            title="Also remove breaths and quiet non-word fillers kept as speech. Can clip very soft speech — review the cuts after."
          >
            <input
              type="checkbox"
              checked={!!opts.removeBreaths}
              onChange={(e) => setOpts({ removeBreaths: e.target.checked })}
            />
            Remove breaths &amp; quiet fillers
          </label>
        )}
        {mode === 'vad' && opts.removeBreaths && (
          <label title="How aggressive: less negative removes more (and risks soft speech).">
            Breath sensitivity
            <input
              type="range" min={-45} max={-22} step={1}
              value={opts.breathDb ?? -32}
              onChange={(e) => setOpts({ breathDb: Number(e.target.value) })}
            />
            <span className="val">{opts.breathDb ?? -32} dB</span>
          </label>
        )}
        {mode === 'vad' && (
          <div className="muted small" style={{ marginTop: 4 }}>
            Finds real speech (handles background noise/music) — near-instant.
          </div>
        )}
      </div>

      {silences.length === 0 ? (
        <div className="muted small">No silences detected yet. Click <b>Detect</b>.</div>
      ) : (
        <div className="silence-list">
          {silences.map((r) => {
            const dur = r.end - r.start
            return (
              <div className="silence-row" key={r.id}>
                <button className="link" onClick={() => setPlayhead(r.start)}>
                  {fmt(r.start)}
                </button>
                <span className="dur">{dur.toFixed(2)}s</span>
                <select value={r.action} onChange={(e) => setAction(r.id, e.target.value as any)}>
                  <option value="keep">Keep</option>
                  <option value="shorten">Shorten</option>
                  <option value="remove">Remove</option>
                </select>
                {r.action === 'shorten' && (
                  <label className="shorten">
                    to
                    <input
                      type="number"
                      min={0}
                      max={dur.toFixed(2)}
                      step={0.05}
                      value={r.shortenTo ?? 0}
                      onChange={(e) => setShorten(r.id, Math.min(dur, Number(e.target.value)))}
                    />
                    s
                  </label>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function fmt(t: number): string {
  const m = Math.floor(t / 60)
  const s = (t % 60).toFixed(1)
  return `${m}:${s.padStart(4, '0')}`
}
