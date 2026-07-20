import { useEffect, useRef } from 'react'
import { css } from '../css'
import { useRetake } from '../data/useRetake'
import { useSmoothProgress } from '../../useSmoothProgress'

// Stage C — production Retake Cleaner panel (editor right rail). Renders the
// state-appropriate content (idle / analyzing / results / executed / error),
// wired to useRetake.

const HAIR = 'rgba(255,255,255,.06)'
const CHIP = "background:rgba(217,164,74,.14);color:#D9A44A;border:1px solid rgba(217,164,74,.3);border-radius:6px;padding:2px 7px;font-family:'IBM Plex Mono',monospace;font-size:10px;margin:0 4px;white-space:nowrap"
// STAGED = highlighted, marked for removal (NOT yet cut — no strike-through, so it
// never looks like a done cut). CUT = the committed strike-through (executed state).
const SEL = 'background:rgba(217,104,110,.22);color:#F1C4C7;border-radius:4px;padding:1px 3px;box-shadow:inset 0 0 0 1px rgba(217,104,110,.4)'
const CUT = 'background:rgba(217,104,110,.13);color:#D9868B;border-radius:5px;padding:1px 4px;text-decoration:line-through;text-decoration-color:rgba(217,134,139,.55)'
// a committed cut that is ALSO selected (→ eligible for Restore): accent highlight
// over the strike-through so it reads as "selected, currently removed".
const SELCUT = 'background:rgba(110,106,232,.28);color:#EDECFF;border-radius:4px;padding:1px 3px;box-shadow:inset 0 0 0 1px rgba(110,106,232,.55);text-decoration:line-through;text-decoration-color:rgba(237,236,255,.5)'

/** whole seconds → M:SS */
const fmtDur = (s: number): string => {
  const t = Math.max(0, Math.round(s))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

// Silence "chip" mouse-down: toggle that staged pause; stop it bubbling to any
// word-drag. Shared by both transcript modes.
const chipDown = (r: ReturnType<typeof useRetake>, stagedId?: string) => (e: React.MouseEvent): void => {
  e.preventDefault()
  e.stopPropagation()
  if (stagedId) r.toggleChip(stagedId)
}

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

// Word gestures (Descript/CapCut-style — selection is ALWAYS non-destructive;
// cuts/restores happen ONLY via the buttons, never on a click):
//  • single click       → toggle-highlight one word
//  • click + drag       → highlight a range of words (a whole sentence, etc.)
//  • drag from a already-highlighted word → UN-highlight the range it covers
//  • double click       → seek the preview to that word and play (no highlight)
// `showCuts` adds the committed-cut strike-through (executed review), so you can
// see what was removed and select those words to Restore them. Words are grouped
// into paragraphs by segment, and — for a multi-clip import — under a labelled
// divider per source video, in import order.
function Transcript({ r, showCuts }: { r: ReturnType<typeof useRetake>; showCuts: boolean }): JSX.Element {
  const isMarked = r.isSelected // drag paints the SELECTION (never the cut)
  const applyWord = (id: string): void => r.selectWord(id, true)
  const drag = useRef<{ active: boolean; anchor: string | null; add: boolean; moved: boolean; done: Set<string> }>({
    active: false,
    anchor: null,
    add: true,
    moved: false,
    done: new Set()
  })

  // Toggle a word toward the drag's direction, once per drag, only if it isn't
  // already in that state (so dragging never double-flips a word).
  const paint = (id: string): void => {
    const d = drag.current
    if (d.done.has(id)) return
    d.done.add(id)
    if (d.add ? !isMarked(id) : isMarked(id)) applyWord(id)
  }

  useEffect(() => {
    const up = (): void => {
      const d = drag.current
      if (d.active && !d.moved && d.anchor) applyWord(d.anchor) // a pure click = single toggle
      d.active = false
      d.anchor = null
      d.moved = false
      d.done = new Set()
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const bounds = r.clipBounds
  const clipOf = (startS: number): number => {
    let idx = 0
    for (let i = 0; i < bounds.length; i++) if (startS >= bounds[i].startS - 0.01) idx = i
    return idx
  }
  let lastClip = -1

  return (
    <div style={css('flex:1;min-height:0;overflow:auto;margin:8px -18px 0;padding:2px 18px 18px;font-size:13.5px;line-height:1.9;color:#C6C9D2;-webkit-mask-image:linear-gradient(#000 90%,transparent)')}>
      {r.segments.map((seg) => {
        const ci = bounds.length > 1 ? clipOf(seg.words[0]?.start ?? 0) : 0
        const divider = bounds.length > 1 && ci !== lastClip
        lastClip = ci
        return (
          <div key={seg.id}>
            {divider && (
              <div style={css('display:flex;align-items:center;gap:8px;margin:16px 0 9px;color:#8B909C;font-size:10.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase')}>
                <span style={css("width:16px;height:16px;flex:none;border-radius:5px;background:#2A2D36;display:grid;place-items:center;font-size:9.5px;color:#B9B4FF;font-family:'IBM Plex Mono',monospace")}>{ci + 1}</span>
                <span style={css('white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px')}>{bounds[ci].name}</span>
                <span style={css('flex:1;height:1px;background:rgba(255,255,255,.07)')} />
              </div>
            )}
            <p style={css('margin:0 0 11px')}>
              {seg.words.map((w) => {
                const chip = r.chipAfter.get(w.id)
                return (
                  <span key={w.id}>
                    <span
                      onMouseDown={(e) => {
                        e.preventDefault()
                        if (e.detail >= 2) {
                          // Double-click: undo the single-click's toggle, then seek+play.
                          applyWord(w.id)
                          r.seekWord(w.start)
                          drag.current.active = false
                          return
                        }
                        drag.current = { active: true, anchor: w.id, add: !isMarked(w.id), moved: false, done: new Set() }
                      }}
                      onMouseEnter={() => {
                        const d = drag.current
                        if (!d.active) return
                        if (w.id !== d.anchor) {
                          if (!d.moved && d.anchor) paint(d.anchor) // include the start word once we actually drag
                          d.moved = true
                        }
                        paint(w.id)
                      }}
                      style={(() => {
                        const sel = r.isSelected(w.id)
                        const cut = showCuts && r.isDeleted(w.id)
                        return css(sel ? (cut ? SELCUT : SEL) : cut ? CUT : 'cursor:pointer;border-radius:4px;padding:1px 3px')
                      })()}
                    >
                      {w.text}
                    </span>{' '}
                    {chip && (
                      <span onMouseDown={chipDown(r, chip.stagedId)} style={css(CHIP)}>
                        {chip.durS}s
                      </span>
                    )}
                    {chip && ' '}
                  </span>
                )
              })}
            </p>
          </div>
        )
      })}
    </div>
  )
}

export default function RetakeCleanerPanel(): JSX.Element {
  const r = useRetake()
  // Glide the bar between real progress milestones (and creep during the opaque
  // transcribe step) so it never freezes at one number.
  const shownPct = Math.round(useSmoothProgress(r.job.active, r.job.percent))

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
        <div style={css('display:flex;gap:7px;margin-top:16px')}>
          <button onClick={r.find} style={css('flex:1;background:#6E6AE8;border:none;color:#fff;font-family:inherit;font-size:11px;font-weight:600;border-radius:10px;padding:11px 0;cursor:pointer;box-shadow:0 6px 20px rgba(110,106,232,.35)')}>Retake Beta</button>
          <button onClick={r.findUltracut} style={css('flex:1;background:#E8843A;border:none;color:#fff;font-family:inherit;font-size:11px;font-weight:600;border-radius:10px;padding:11px 0;cursor:pointer;box-shadow:0 6px 20px rgba(232,132,58,.32)')}>Ultracut Beta</button>
          <button onClick={r.findPremium} style={css('flex:1;background:#2E9C6A;border:none;color:#fff;font-family:inherit;font-size:11px;font-weight:600;border-radius:10px;padding:11px 0;cursor:pointer;box-shadow:0 6px 20px rgba(46,156,106,.32)')}>Premium Cut</button>
        </div>
        <div style={css('font-size:10.5px;color:#686E7B;margin-top:7px;line-height:1.5;text-align:center')}>Retake Beta = Opus · Ultracut = DeepSeek · Premium = Gemini 3.5 Flash (listens)</div>
        <button onClick={r.openSilenceSettings} style={css('width:100%;margin-top:10px;background:none;border:1px solid rgba(255,255,255,.1);color:#C6C9D2;font-family:inherit;font-size:12.5px;font-weight:500;border-radius:10px;padding:10px 0;cursor:pointer')}>Silence Settings</button>
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
          <div style={css('display:flex;align-items:center;justify-content:space-between;font-size:12.5px')}><span style={css('color:#E9EAEE;font-weight:550')}>Analyzing your video</span><span style={css("font-family:'IBM Plex Mono',monospace;font-size:11px;color:#9BA0AC")}>{shownPct}%</span></div>
          <div style={css('height:4px;border-radius:2px;background:#2A2D36;overflow:hidden;margin-top:12px')}><div style={css(`width:${Math.max(4, shownPct)}%;height:100%;border-radius:2px;background:#6E6AE8`)} /></div>
          <div style={css('font-size:12px;color:#9BA0AC;margin-top:14px;line-height:1.5')}>{r.job.message || 'Working…'}</div>
        </div>
        <div style={css('font-size:11px;color:#686E7B;margin-top:10px;text-align:center')}>You can keep editing while this runs.</div>
      </>
    )
  }

  if (r.state === 'executed') {
    return shell(
      <>
        {/* Compact executed header: count status on the left, actions on the
            right (Silence Settings collapses to a gear icon to save vertical space). */}
        <div style={css('display:flex;align-items:center;gap:10px;margin-top:14px;flex:none')}>
          <span style={css('display:flex;align-items:center;gap:7px;flex:none;background:rgba(46,156,106,.12);border:1px solid rgba(46,156,106,.3);border-radius:999px;padding:6px 12px 6px 8px;font-size:12px;font-weight:600;color:#E9EAEE;white-space:nowrap')}>
            <span style={css('width:16px;height:16px;flex:none;border-radius:50%;background:#2E9C6A;display:grid;place-items:center;color:#fff;font-size:9px')}>✓</span>
            {r.deletedCount} cut{r.deletedCount === 1 ? '' : 's'} applied
          </span>
          <div style={css('flex:1')} />
          <button onClick={r.find} style={css('flex:none;background:#6E6AE8;border:none;color:#fff;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:9px 16px;cursor:pointer;white-space:nowrap')}>Run again</button>
          <button onClick={r.openSilenceSettings} title="Silence Settings" aria-label="Silence Settings" style={css('flex:none;width:36px;height:36px;background:none;border:1px solid rgba(255,255,255,.14);border-radius:9px;color:#C6C9D2;display:grid;place-items:center;cursor:pointer;padding:0;appearance:none;-webkit-appearance:none')}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
        {smartRow}
        <div style={css(`display:flex;align-items:center;gap:8px;margin-top:16px;padding-top:14px;border-top:1px solid ${HAIR};flex:none`)}>
          <div style={css('font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#9BA0AC')}>Review cuts</div>
          <div style={css('flex:1')} />
          <div style={css('font-size:11px;color:#686E7B')}>{r.words > 0 ? `${r.words} selected` : 'click or drag to select'}</div>
        </div>
        {/* Selection actions — cutting or restoring happens HERE, never on a click.
            Restore un-cuts the selected words; Cut removes the selected kept ones. */}
        {r.words > 0 && (
          <div style={css('display:flex;gap:8px;margin-top:8px;flex:none')}>
            <button onClick={r.restore} style={css('flex:1;background:rgba(46,156,106,.14);border:1px solid rgba(46,156,106,.4);color:#7FCFAA;font-family:inherit;font-size:12px;font-weight:600;border-radius:8px;padding:8px 0;cursor:pointer')}>↺ Restore selected</button>
            <button onClick={r.cutSelected} style={css('flex:1;background:rgba(217,104,110,.16);border:1px solid rgba(217,104,110,.4);color:#F1B0B4;font-family:inherit;font-size:12px;font-weight:600;border-radius:8px;padding:8px 0;cursor:pointer')}>✂ Cut selected</button>
          </div>
        )}
        <div style={css('font-size:10.5px;color:#686E7B;margin-top:8px;flex:none')}>Click or drag to select · double-click to play · a click never cuts — use Cut / Restore.</div>
        <Transcript r={r} showCuts={true} />
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

  // results / reviewing — compact so the transcript gets the vertical space.
  return shell(
    <>
      {/* single-line status (replaces the big 2×2 stat box) */}
      <div style={css('display:flex;align-items:center;margin-top:12px;flex:none;background:#1E2026;border:1px solid rgba(255,255,255,.07);border-radius:9px;padding:8px 12px;font-size:11.5px;color:#9BA0AC')}>
        <span><b style={css('color:#D9868B;font-weight:650')}>{r.words}</b> cuts</span>
        <span style={css('color:#3A3E48;margin:0 9px')}>·</span>
        <span><b style={css('color:#D9A44A;font-weight:650')}>{r.pauses}</b> silence</span>
        <span style={css('color:#3A3E48;margin:0 9px')}>·</span>
        <span><b style={css('color:#46A57C;font-weight:650')}>{fmtDur(r.timeSavedS)}</b> saved</span>
      </div>
      {/* compact action row: Execute (primary) + Silence Settings as a gear icon */}
      <div style={css('display:flex;gap:8px;margin-top:10px;flex:none')}>
        <button onClick={r.execute} disabled={!r.executable} style={css('flex:1;background:#6E6AE8;border:none;color:#fff;font-family:inherit;font-size:12px;font-weight:600;border-radius:8px;padding:8px 0;cursor:pointer', !r.executable && 'opacity:.5;cursor:not-allowed;box-shadow:none')}>Execute {r.executable} cut{r.executable === 1 ? '' : 's'}</button>
        <button onClick={r.openSilenceSettings} title="Silence Settings" aria-label="Silence Settings" style={css('flex:none;width:34px;height:34px;background:none;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#C6C9D2;display:grid;place-items:center;cursor:pointer;padding:0;appearance:none;-webkit-appearance:none')}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
      {smartRow}
      <div style={css(`display:flex;align-items:center;gap:8px;margin-top:14px;padding-top:12px;border-top:1px solid ${HAIR};flex:none`)}>
        <div style={css('font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#9BA0AC')}>Review transcript</div>
        <div style={css('flex:1')} />
        <span onClick={r.restore} style={css('font-size:11.5px;color:#9BA0AC;padding:4px 8px;border-radius:7px;cursor:pointer')}>Restore</span>
        <span onClick={r.clear} style={css('font-size:11.5px;color:#9BA0AC;padding:4px 8px;border-radius:7px;cursor:pointer')}>Clear</span>
      </div>
      <div style={css('font-size:10.5px;color:#686E7B;margin-top:6px;flex:none')}>Click or drag to highlight words to cut · double-click to play · nothing is removed until you press Execute</div>
      <Transcript r={r} showCuts={false} />
    </>
  )
}
