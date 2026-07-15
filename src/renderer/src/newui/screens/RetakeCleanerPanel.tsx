import { css } from '../css'
import { useRetake } from '../data/useRetake'

// Stage C — production Retake Cleaner panel (editor right rail). Renders the
// approved design's state-appropriate content (idle / analyzing / results /
// executed / error) with the exact 1b + 1c markup, wired to useRetake.

const HAIR = 'rgba(255,255,255,.06)'
const CHIP = "background:rgba(217,164,74,.14);color:#D9A44A;border:1px solid rgba(217,164,74,.3);border-radius:6px;padding:2px 7px;font-family:'IBM Plex Mono',monospace;font-size:10px;margin:0 4px;white-space:nowrap"
const CUT = 'background:rgba(217,104,110,.13);color:#D9868B;border-radius:5px;padding:1px 4px;text-decoration:line-through;text-decoration-color:rgba(217,134,139,.55)'

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }): JSX.Element {
  return on ? (
    <div onClick={onClick} style={css('width:32px;height:18px;border-radius:9px;background:#6E6AE8;position:relative;flex:none;cursor:pointer')}>
      <div style={css('position:absolute;right:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff')} />
    </div>
  ) : (
    <div onClick={onClick} style={css('width:32px;height:18px;border-radius:9px;background:#3A3E48;position:relative;flex:none;cursor:pointer')}>
      <div style={css('position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#9BA0AC')} />
    </div>
  )
}

function Header(): JSX.Element {
  return (
    <div style={css('display:flex;align-items:center;gap:8px')}>
      <div style={css('font-size:15px;font-weight:650;letter-spacing:-.01em')}>Retake Cleaner</div>
      <span style={css('font-size:9.5px;font-weight:600;letter-spacing:.05em;color:#9BA0AC;border:1px solid rgba(255,255,255,.12);border-radius:5px;padding:2px 6px')}>BETA</span>
      <div style={css('flex:1')} />
      <div style={css('color:#9BA0AC;font-size:14px;padding:3px 6px;border-radius:7px;cursor:pointer')}>···</div>
    </div>
  )
}

// `stage` (results): strike STAGED words, click toggles the staged selection.
// `applied` (executed): strike COMMITTED cuts (word.deleted), click toggles the
// committed cut live (restore a struck word / cut a kept one) — the timeline,
// preview and export all follow word.deleted, so the edit updates immediately.
function Transcript({ r, mode }: { r: ReturnType<typeof useRetake>; mode: 'stage' | 'applied' }): JSX.Element {
  const isCut = mode === 'applied' ? r.isDeleted : r.isSelected
  const onWord = mode === 'applied' ? r.toggleWord : (id: string) => r.selectWord(id, true)
  return (
    <div style={css('flex:1;min-height:0;overflow:auto;margin:10px -18px 0;padding:2px 18px 18px;font-size:13.5px;line-height:2.1;color:#C6C9D2;-webkit-mask-image:linear-gradient(#000 82%,transparent)')}>
      {r.segments.map((seg) => (
        <span key={seg.id}>
          {seg.words.map((w) => {
            const chip = r.chipAfter.get(w.id)
            return (
              <span key={w.id}>
                <span
                  onMouseDown={(e) => { e.preventDefault(); onWord(w.id) }}
                  style={isCut(w.id) ? css(CUT) : css('cursor:pointer')}
                >
                  {w.text}
                </span>{' '}
                {chip && (
                  <span
                    onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); if (chip.stagedId) r.toggleChip(chip.stagedId) }}
                    style={css(CHIP)}
                  >
                    {chip.durS}s
                  </span>
                )}
                {chip && ' '}
              </span>
            )
          })}
        </span>
      ))}
    </div>
  )
}

export default function RetakeCleanerPanel(): JSX.Element {
  const r = useRetake()

  const shell = (children: JSX.Element): JSX.Element => (
    <div style={css('flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;padding:18px 18px 0')}>
      <Header />
      {children}
    </div>
  )

  const smartRow = (
    <div style={css('display:flex;align-items:center;gap:9px;margin-top:12px')}>
      <Toggle on={r.smartSilence} onClick={() => r.setSmartSilence(!r.smartSilence)} />
      <div style={css('font-size:12px;color:#C6C9D2')}>Smart Silence Cutter</div>
      <div style={css('flex:1')} />
      <div style={css('font-size:11px;color:#686E7B')}>{r.pauseCount} pauses</div>
    </div>
  )

  if (r.state === 'idle') {
    return shell(
      <>
        <div style={css('font-size:12.5px;line-height:1.5;color:#9BA0AC;margin-top:6px')}>Find retakes, production chatter, false starts, and long pauses.</div>
        <button onClick={r.find} style={css('width:100%;margin-top:16px;background:#6E6AE8;border:none;color:#fff;font-family:inherit;font-size:13px;font-weight:600;border-radius:10px;padding:11px 0;cursor:pointer;box-shadow:0 6px 20px rgba(110,106,232,.35)')}>Find Retakes &amp; Silence</button>
        <button onClick={r.openSilenceSettings} style={css('width:100%;margin-top:8px;background:none;border:1px solid rgba(255,255,255,.1);color:#C6C9D2;font-family:inherit;font-size:12.5px;font-weight:500;border-radius:10px;padding:10px 0;cursor:pointer')}>Silence Settings</button>
        <div style={css('display:flex;align-items:center;gap:9px;margin-top:14px')}>
          <Toggle on={r.smartSilence} onClick={() => r.setSmartSilence(!r.smartSilence)} />
          <div style={css('font-size:12px;color:#C6C9D2')}>Smart Silence Cutter</div>
        </div>
        <button disabled style={css('width:100%;margin-top:14px;background:#22242b;border:none;color:#565C68;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:10px;padding:10px 0;cursor:not-allowed')}>Execute cuts</button>
        <div style={css('font-size:11px;color:#686E7B;margin-top:12px;line-height:1.5')}>Beta — review proposed cuts before executing. Nothing is removed without you.</div>
      </>
    )
  }

  if (r.state === 'analyzing') {
    return shell(
      <>
        <div style={css('margin-top:16px;background:#1E2026;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:16px')}>
          <div style={css('display:flex;align-items:center;justify-content:space-between;font-size:12.5px')}><span style={css('color:#E9EAEE;font-weight:550')}>Analyzing your video</span><span style={css("font-family:'IBM Plex Mono',monospace;font-size:11px;color:#9BA0AC")}>{r.job.percent}%</span></div>
          <div style={css('height:4px;border-radius:2px;background:#2A2D36;overflow:hidden;margin-top:12px')}><div style={css(`width:${Math.max(4, r.job.percent)}%;height:100%;border-radius:2px;background:#6E6AE8`)} /></div>
          <div style={css('font-size:12px;color:#9BA0AC;margin-top:14px;line-height:1.5')}>{r.job.message || 'Working…'}</div>
        </div>
        <div style={css('font-size:11px;color:#686E7B;margin-top:10px;text-align:center')}>You can keep editing while this runs.</div>
      </>
    )
  }

  if (r.state === 'executed') {
    return shell(
      <>
        <div style={css('margin-top:14px;background:rgba(70,165,124,.08);border:1px solid rgba(70,165,124,.25);border-radius:12px;padding:14px;display:flex;gap:12px;flex:none')}>
          <div style={css('width:26px;height:26px;flex:none;border-radius:50%;background:rgba(70,165,124,.18);display:grid;place-items:center;color:#5FBF94;font-size:12px')}>✓</div>
          <div>
            <div style={css('font-size:13px;font-weight:600;color:#7FCBA8')}>{r.deletedCount} cut{r.deletedCount === 1 ? '' : 's'} applied</div>
            <div style={css('font-size:12px;color:#9BA0AC;margin-top:4px;line-height:1.5')}>Every cut is on the timeline and can be undone.</div>
          </div>
        </div>
        <div style={css('display:flex;gap:8px;margin-top:12px;flex:none')}>
          <button onClick={r.find} style={css('flex:1;background:#6E6AE8;border:none;color:#fff;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:10px;padding:11px 0;cursor:pointer')}>Run again</button>
          <button onClick={r.openSilenceSettings} style={css('background:none;border:1px solid rgba(255,255,255,.1);color:#C6C9D2;font-family:inherit;font-size:12.5px;font-weight:500;border-radius:10px;padding:10px 14px;cursor:pointer')}>Silence Settings</button>
        </div>
        {smartRow}
        <div style={css(`display:flex;align-items:center;gap:8px;margin-top:16px;padding-top:14px;border-top:1px solid ${HAIR};flex:none`)}>
          <div style={css('font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#9BA0AC')}>Review cuts</div>
          <div style={css('flex:1')} />
          <div style={css('font-size:11px;color:#686E7B')}>tap a word to restore or cut</div>
        </div>
        <Transcript r={r} mode="applied" />
      </>
    )
  }

  if (r.state === 'error') {
    return shell(
      <>
        <div style={css('margin-top:14px;background:rgba(217,104,110,.07);border:1px solid rgba(217,104,110,.25);border-radius:12px;padding:16px;display:flex;gap:12px')}>
          <div style={css('width:26px;height:26px;flex:none;border-radius:50%;background:rgba(217,104,110,.16);display:grid;place-items:center;color:#D9868B;font-size:12px')}>!</div>
          <div>
            <div style={css('font-size:13px;font-weight:600;color:#E09BA0')}>Analysis didn’t finish</div>
            <div style={css('font-size:12px;color:#9BA0AC;margin-top:4px;line-height:1.5')}>{r.job.message || 'Your project and edits are untouched.'}</div>
          </div>
        </div>
        <button onClick={r.find} style={css('width:100%;margin-top:14px;background:#6E6AE8;border:none;color:#fff;font-family:inherit;font-size:13px;font-weight:600;border-radius:10px;padding:11px 0;cursor:pointer')}>Try again</button>
      </>
    )
  }

  // results / reviewing
  return shell(
    <>
      <div style={css('font-size:12.5px;line-height:1.5;color:#9BA0AC;margin-top:6px')}>Find retakes, production chatter, false starts, and long pauses.</div>
      <div style={css('margin-top:16px;background:#1E2026;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:14px')}>
        <div style={css('display:grid;grid-template-columns:1fr 1fr;gap:12px 16px')}>
          <div><div style={css('font-size:17px;font-weight:650')}>{r.retakes}</div><div style={css('font-size:11px;color:#9BA0AC;margin-top:2px')}>retakes found</div></div>
          <div><div style={css('font-size:17px;font-weight:650;color:#D9868B')}>{r.words}</div><div style={css('font-size:11px;color:#9BA0AC;margin-top:2px')}>words to remove</div></div>
          <div><div style={css('font-size:17px;font-weight:650;color:#D9A44A')}>{r.pauses}</div><div style={css('font-size:11px;color:#9BA0AC;margin-top:2px')}>pauses shortened</div></div>
          <div><div style={css('font-size:17px;font-weight:650;color:#46A57C')}>~{Math.round(r.timeSavedS)}s</div><div style={css('font-size:11px;color:#9BA0AC;margin-top:2px')}>time saved</div></div>
        </div>
      </div>
      <div style={css('display:flex;gap:8px;margin-top:12px')}>
        <button onClick={r.execute} disabled={!r.executable} style={css('flex:1;background:#6E6AE8;border:none;color:#fff;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:10px;padding:10px 0;cursor:pointer;box-shadow:0 6px 20px rgba(110,106,232,.3)')}>Execute {r.executable} cuts</button>
        <button onClick={r.openSilenceSettings} style={css('background:none;border:1px solid rgba(255,255,255,.1);color:#C6C9D2;font-family:inherit;font-size:12.5px;font-weight:500;border-radius:10px;padding:10px 14px;cursor:pointer')}>Silence Settings</button>
      </div>
      {smartRow}
      <div style={css(`display:flex;align-items:center;gap:8px;margin-top:18px;padding-top:14px;border-top:1px solid ${HAIR}`)}>
        <div style={css('font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#9BA0AC')}>Review transcript</div>
        <div style={css('flex:1')} />
        <span onClick={r.restore} style={css('font-size:11.5px;color:#9BA0AC;padding:4px 8px;border-radius:7px;cursor:pointer')}>Restore</span>
        <span onClick={r.clear} style={css('font-size:11.5px;color:#9BA0AC;padding:4px 8px;border-radius:7px;cursor:pointer')}>Clear</span>
      </div>
      <Transcript r={r} mode="stage" />
    </>
  )
}
