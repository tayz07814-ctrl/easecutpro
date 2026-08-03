import { useEffect, useRef } from 'react'
import { css } from '../css'
import { useRetake } from '../data/useRetake'
import { useSmoothProgress } from '../../useSmoothProgress'

// Stage C — production Retake Cleaner panel (editor right rail). Renders the
// state-appropriate content (idle / analyzing / results / executed / error),
// wired to useRetake.

const HAIR = 'rgba(255,255,255,.06)'
const CHIP = "background:rgba(230,178,106,.14);color:#e6b26a;border:1px solid rgba(230,178,106,.3);border-radius:6px;padding:2px 7px;font-family:'Geist Mono',monospace;font-size:10px;margin:0 4px;white-space:nowrap"
// STAGED = highlighted, marked for removal (NOT yet cut — no strike-through, so it
// never looks like a done cut). CUT = the committed strike-through (executed state).
const SEL = 'background:rgba(255,155,155,.22);color:#ff9b9b;border-radius:4px;padding:1px 3px;box-shadow:inset 0 0 0 1px rgba(255,155,155,.4)'
const CUT = 'background:rgba(255,155,155,.13);color:#ff9b9b;border-radius:5px;padding:1px 4px;text-decoration:line-through;text-decoration-color:rgba(255,155,155,.55)'
// a committed cut that is ALSO selected (→ eligible for Restore): accent highlight
// over the strike-through so it reads as "selected, currently removed".
const SELCUT = 'background:rgba(124,107,255,.28);color:#c4baff;border-radius:4px;padding:1px 3px;box-shadow:inset 0 0 0 1px rgba(124,107,255,.55);text-decoration:line-through;text-decoration-color:rgba(196,186,255,.5)'

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
    <div onClick={onClick} style={css('width:32px;height:18px;border-radius:9px;background:#7c6bff;position:relative;flex:none;cursor:pointer')}>
      <div style={css('position:absolute;right:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff')} />
    </div>
  ) : (
    <div onClick={onClick} style={css('width:32px;height:18px;border-radius:9px;background:#2a2a34;position:relative;flex:none;cursor:pointer')}>
      <div style={css('position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#9a9aae')} />
    </div>
  )
}

function Header(): JSX.Element {
  return (
    <div style={css('display:flex;align-items:center;gap:8px')}>
      <div style={css('font-size:15px;font-weight:650;letter-spacing:-.01em')}>Retake Cleaner</div>
      <span style={css('font-size:9.5px;font-weight:600;letter-spacing:.05em;color:#9a9aae;border:1px solid rgba(255,255,255,.12);border-radius:5px;padding:2px 6px')}>BETA</span>
      <div style={css('flex:1')} />
      <div style={css('color:#9a9aae;font-size:14px;padding:3px 6px;border-radius:7px;cursor:pointer')}>···</div>
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
    <div style={css('flex:1;min-height:0;overflow:auto;margin:8px -18px 0;padding:2px 18px 18px;font-size:13.5px;line-height:1.9;color:#c9c9da;-webkit-mask-image:linear-gradient(#000 90%,transparent)')}>
      {r.segments.map((seg) => {
        const ci = bounds.length > 1 ? clipOf(seg.words[0]?.start ?? 0) : 0
        const divider = bounds.length > 1 && ci !== lastClip
        lastClip = ci
        return (
          <div key={seg.id}>
            {divider && (
              <div style={css('display:flex;align-items:center;gap:8px;margin:16px 0 9px;color:#8b8ba0;font-size:10.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase')}>
                <span style={css("width:16px;height:16px;flex:none;border-radius:5px;background:#22222b;display:grid;place-items:center;font-size:9.5px;color:#c4baff;font-family:'Geist Mono',monospace")}>{ci + 1}</span>
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


  if (r.state === 'idle') {
    return shell(
      <>
        <div style={css('font-size:12.5px;line-height:1.5;color:#9a9aae;margin-top:6px')}>Find retakes, production chatter, false starts, and long pauses.</div>
        {/* Single Retake Beta engine (retakeEngine.ts → ultracut-judge edge fn). */}
        <button onClick={r.find} style={css('width:100%;margin-top:16px;background:#7c6bff;border:none;color:#fff;font-family:inherit;font-size:13.5px;font-weight:650;border-radius:12px;padding:14px 0;cursor:pointer;box-shadow:0 6px 20px rgba(124,107,255,.35)')}>Find Retakes</button>
        <button disabled style={css('width:100%;margin-top:14px;background:#141419;border:none;color:#55556a;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:10px;padding:10px 0;cursor:not-allowed')}>Execute cuts</button>
        <div style={css('font-size:11px;color:#6e6e85;margin-top:12px;line-height:1.5')}>Beta — review proposed cuts before executing. Nothing is removed without you.</div>
      </>
    )
  }

  if (r.state === 'analyzing') {
    return shell(
      <>
        <div style={css('margin-top:16px;background:#101015;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:16px')}>
          <div style={css('display:flex;align-items:center;justify-content:space-between;font-size:12.5px')}><span style={css('color:#ededf2;font-weight:550')}>Analyzing your video</span><span style={css("font-family:'Geist Mono',monospace;font-size:11px;color:#9a9aae")}>{shownPct}%</span></div>
          <div style={css('height:4px;border-radius:2px;background:#22222b;overflow:hidden;margin-top:12px')}><div style={css(`width:${Math.max(4, shownPct)}%;height:100%;border-radius:2px;background:#7c6bff`)} /></div>
          <div style={css('font-size:12px;color:#9a9aae;margin-top:14px;line-height:1.5')}>{r.job.message || 'Working…'}</div>
        </div>
        <div style={css('font-size:11px;color:#6e6e85;margin-top:10px;text-align:center')}>You can keep editing while this runs.</div>
      </>
    )
  }

  if (r.state === 'executed') {
    return shell(
      <>
        {/* Compact executed header: count status on the left, actions on the
            right (Silence Settings collapses to a gear icon to save vertical space). */}
        <div style={css('display:flex;align-items:center;gap:10px;margin-top:14px;flex:none')}>
          <span style={css('display:flex;align-items:center;gap:7px;flex:none;background:rgba(126,214,166,.12);border:1px solid rgba(126,214,166,.3);border-radius:999px;padding:6px 12px 6px 8px;font-size:12px;font-weight:600;color:#ededf2;white-space:nowrap')}>
            <span style={css('width:16px;height:16px;flex:none;border-radius:50%;background:#7ed6a6;display:grid;place-items:center;color:#fff;font-size:9px')}>✓</span>
            {r.deletedCount} cut{r.deletedCount === 1 ? '' : 's'} applied
          </span>
          <div style={css('flex:1')} />
          <button onClick={r.find} style={css('flex:none;background:#7c6bff;border:none;color:#fff;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:9px 16px;cursor:pointer;white-space:nowrap')}>Run again</button>
        </div>
        {/* Auto Zoom — Gemma picks the key cut clips and punches in on them. */}
        <button
          onClick={r.autoZoom}
          disabled={r.autoZooming}
          style={css(
            'width:100%;margin-top:12px;border:none;color:#fff;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:10px;padding:11px 0;flex:none;',
            r.autoZooming
              ? 'background:#2a2a34;cursor:default'
              : 'background:linear-gradient(90deg,#7c6bff,#a99bff);cursor:pointer;box-shadow:0 6px 20px rgba(124,107,255,.32)'
          )}
        >
          {r.autoZooming ? 'Adding zooms…' : '🔍 Auto Zoom the key moments'}
        </button>
        <div style={css(`display:flex;align-items:center;gap:8px;margin-top:16px;padding-top:14px;border-top:1px solid ${HAIR};flex:none`)}>
          <div style={css('font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#9a9aae')}>Review cuts</div>
          <div style={css('flex:1')} />
          <div style={css('font-size:11px;color:#6e6e85')}>{r.words > 0 ? `${r.words} selected` : 'click or drag to select'}</div>
        </div>
        {/* Selection actions — cutting or restoring happens HERE, never on a click.
            Restore un-cuts the selected words; Cut removes the selected kept ones. */}
        {r.words > 0 && (
          <div style={css('display:flex;gap:8px;margin-top:8px;flex:none')}>
            <button onClick={r.restore} style={css('flex:1;background:rgba(126,214,166,.14);border:1px solid rgba(126,214,166,.4);color:#9fdfbe;font-family:inherit;font-size:12px;font-weight:600;border-radius:8px;padding:8px 0;cursor:pointer')}>↺ Restore selected</button>
            <button onClick={r.cutSelected} style={css('flex:1;background:rgba(255,155,155,.16);border:1px solid rgba(255,155,155,.4);color:#ff9b9b;font-family:inherit;font-size:12px;font-weight:600;border-radius:8px;padding:8px 0;cursor:pointer')}>✂ Cut selected</button>
          </div>
        )}
        <div style={css('font-size:10.5px;color:#6e6e85;margin-top:8px;flex:none')}>Click or drag to select · double-click to play · a click never cuts — use Cut / Restore.</div>
        <Transcript r={r} showCuts={true} />
      </>
    )
  }

  if (r.state === 'error') {
    return shell(
      <>
        <div style={css('margin-top:14px;background:rgba(255,155,155,.07);border:1px solid rgba(255,155,155,.25);border-radius:12px;padding:16px;display:flex;gap:12px')}>
          <div style={css('width:26px;height:26px;flex:none;border-radius:50%;background:rgba(255,155,155,.16);display:grid;place-items:center;color:#ff9b9b;font-size:12px')}>!</div>
          <div>
            <div style={css('font-size:13px;font-weight:600;color:#ff9b9b')}>Analysis didn’t finish</div>
            <div style={css('font-size:12px;color:#9a9aae;margin-top:4px;line-height:1.5')}>{r.job.message || 'Your project and edits are untouched.'}</div>
          </div>
        </div>
        <button onClick={r.find} style={css('width:100%;margin-top:14px;background:#7c6bff;border:none;color:#fff;font-family:inherit;font-size:13px;font-weight:600;border-radius:10px;padding:11px 0;cursor:pointer')}>Try again</button>
      </>
    )
  }

  // results / reviewing — compact so the transcript gets the vertical space.
  return shell(
    <>
      {/* single-line status (replaces the big 2×2 stat box) */}
      <div style={css('display:flex;align-items:center;margin-top:12px;flex:none;background:#101015;border:1px solid rgba(255,255,255,.07);border-radius:9px;padding:8px 12px;font-size:11.5px;color:#9a9aae')}>
        <span><b style={css('color:#ff9b9b;font-weight:650')}>{r.words}</b> cuts</span>
        <span style={css('color:#2a2a34;margin:0 9px')}>·</span>
        <span><b style={css('color:#e6b26a;font-weight:650')}>{r.pauses}</b> silence</span>
        <span style={css('color:#2a2a34;margin:0 9px')}>·</span>
        <span><b style={css('color:#7ed6a6;font-weight:650')}>{fmtDur(r.timeSavedS)}</b> saved</span>
      </div>
      {/* compact action row: Execute (primary) + Silence Settings as a gear icon */}
      <div style={css('display:flex;gap:8px;margin-top:10px;flex:none')}>
        <button onClick={r.execute} disabled={!r.executable} style={css('flex:1;background:#7c6bff;border:none;color:#fff;font-family:inherit;font-size:12px;font-weight:600;border-radius:8px;padding:8px 0;cursor:pointer', !r.executable && 'opacity:.5;cursor:not-allowed;box-shadow:none')}>Execute {r.executable} cut{r.executable === 1 ? '' : 's'}</button>
      </div>
      <div style={css(`display:flex;align-items:center;gap:8px;margin-top:14px;padding-top:12px;border-top:1px solid ${HAIR};flex:none`)}>
        <div style={css('font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#9a9aae')}>Review transcript</div>
        <div style={css('flex:1')} />
        <span onClick={r.restore} style={css('font-size:11.5px;color:#9a9aae;padding:4px 8px;border-radius:7px;cursor:pointer')}>Restore</span>
        <span onClick={r.clear} style={css('font-size:11.5px;color:#9a9aae;padding:4px 8px;border-radius:7px;cursor:pointer')}>Clear</span>
      </div>
      <div style={css('font-size:10.5px;color:#6e6e85;margin-top:6px;flex:none')}>Click or drag to highlight words to cut · double-click to play · nothing is removed until you press Execute</div>
      <Transcript r={r} showCuts={false} />
    </>
  )
}
