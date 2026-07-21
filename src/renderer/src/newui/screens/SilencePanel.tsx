import { css } from '../css'
import { useStore } from '../../store'
import { useSilence } from '../data/useSilence'
import { useRetake } from '../data/useRetake'
import { SilenceControls } from './SilenceControls'

// The dedicated SILENCE tab (next to AI Cut). The whole silence engine in one
// place: presets + sliders inline (shared SilenceControls — same store values as
// the ⚙ modal), a silence-only run (stages ONLY pause chips, no word cuts), and
// the staged-review summary with Execute. Uses the exact same engine + staging +
// Execute machinery as AI Cut, so results behave identically.

const BTN_PRIMARY = 'width:100%;background:#6E6AE8;border:none;color:#fff;font-family:inherit;font-size:13px;font-weight:600;border-radius:10px;padding:11px 0;cursor:pointer;box-shadow:0 6px 18px rgba(110,106,232,.3)'
const BTN_QUIET = 'background:none;border:1px solid rgba(255,255,255,.12);color:#C6C9D2;font-family:inherit;font-size:12.5px;border-radius:9px;padding:9px 14px;cursor:pointer'

export default function SilencePanel(): JSX.Element {
  const sil = useSilence()
  const r = useRetake()
  const job = useStore((s) => s.job)
  const runSilenceOnly = useStore((s) => s.runRetakeCutBeta)
  const staged = useStore((s) => s.stagedSilences)
  const stagedSel = useStore((s) => s.stagedSilenceSel)

  const selCount = staged.filter((x) => stagedSel.has(x.id)).length
  const selSeconds = staged.filter((x) => stagedSel.has(x.id)).reduce((n, x) => n + (x.end - x.start), 0)

  return (
    <div style={css('flex:1;min-height:0;overflow-y:auto;padding:14px 16px')}>
      <div style={css('font-size:10px;font-weight:700;letter-spacing:.08em;color:#686E7B;text-transform:uppercase')}>Silence Cutter</div>
      <div style={css('font-size:11.5px;color:#9BA0AC;margin-top:6px;line-height:1.5')}>
        Cuts dead air and handling noise between words — words themselves are always protected. Retakes are untouched (that's the AI Cut tab).
      </div>

      <SilenceControls sil={sil} />

      <div style={css('margin-top:18px;border-top:1px solid rgba(255,255,255,.07);padding-top:16px')}>
        <button disabled={job.active} onClick={() => void runSilenceOnly({ silenceOnly: true })}
          style={css(BTN_PRIMARY + (job.active ? ';opacity:.55;cursor:default' : ''))}>
          🔇 Find silence
        </button>
        {job.active && (
          <div style={css('margin-top:12px')}>
            <div style={css('height:4px;border-radius:2px;background:#2A2D36;overflow:hidden')}>
              <div style={css(`width:${Math.max(4, job.percent)}%;height:100%;border-radius:2px;background:#6E6AE8`)} />
            </div>
            <div style={css('font-size:11.5px;color:#9BA0AC;margin-top:8px;line-height:1.5')}>{job.message || 'Working…'}</div>
          </div>
        )}
        {!job.active && job.message && (
          <div style={css('font-size:11.5px;color:#9BA0AC;margin-top:10px;line-height:1.5')}>{job.message}</div>
        )}
      </div>

      {staged.length > 0 && (
        <div style={css('margin-top:14px;background:#1E2026;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:14px')}>
          <div style={css('display:flex;align-items:center;gap:8px')}>
            <span style={css('font-size:12.5px;color:#E9EAEE;font-weight:600')}>{selCount} pause{selCount === 1 ? '' : 's'} staged</span>
            <span style={css("font-family:'IBM Plex Mono',monospace;font-size:11px;color:#7FCBA8")}>−{selSeconds.toFixed(1)}s</span>
            <div style={css('flex:1')} />
            <button onClick={r.clear} style={css(BTN_QUIET)}>Clear</button>
          </div>
          <div style={css('font-size:11px;color:#7E8393;margin-top:8px;line-height:1.45')}>
            Chips are on the transcript (AI Cut tab) — click one to keep that pause. Nothing is cut until Execute.
          </div>
          <button disabled={job.active || selCount === 0} onClick={r.execute}
            style={css(BTN_PRIMARY + ';margin-top:12px' + (job.active || selCount === 0 ? ';opacity:.55;cursor:default' : ''))}>
            ▶ Execute cuts
          </button>
        </div>
      )}

      {r.deletedCount > 0 && staged.length === 0 && (
        <div style={css('margin-top:14px;font-size:12px;color:#7FCBA8')}>✓ Cuts applied — run again after more edits to catch new pauses.</div>
      )}
    </div>
  )
}
