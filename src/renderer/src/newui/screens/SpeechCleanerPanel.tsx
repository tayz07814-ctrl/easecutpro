// Speech cleaner (right panel → AI tools) — the redesign's cut-card review.
// The cards are DERIVED live from the real staged cuts (contiguous runs of struck
// transcript words) + staged silences, so toggling a card here changes the same
// selection the Transcript drawer paints and the Execute path applies. Nothing is
// removed until "Apply". Wired to useRetake — no mock data.

import { css } from '../css'
import { useRetake } from '../data/useRetake'
import { useSmoothProgress } from '../../useSmoothProgress'

const HAIR = 'rgba(255,255,255,.06)'

const mmss = (s: number): string => {
  const t = Math.max(0, Math.round(s))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}
// M:SS.d (tenths) for cut ranges, matching the design.
const mmssT = (s: number): string => {
  const v = Math.max(0, s)
  const m = Math.floor(v / 60)
  const sec = (v % 60).toFixed(1).padStart(4, '0')
  return `${m}:${sec}`
}

interface Cut {
  id: string
  kind: string
  dot: string
  startS: number
  endS: number
  text: string
  keep: () => void
}

function deriveCuts(r: ReturnType<typeof useRetake>, applied: boolean): Cut[] {
  const hit = applied ? r.isDeleted : r.isSelected
  const cuts: Cut[] = []
  let run: { startS: number; endS: number; words: string[]; ids: string[] } | null = null
  const flush = (): void => {
    if (!run) return
    const ids = run.ids
    const filler = ids.length <= 2
    cuts.push({
      id: 'w:' + ids[0],
      kind: filler ? 'Filler' : 'Retake',
      dot: filler ? '#e6b26a' : '#ff9b9b',
      startS: run.startS,
      endS: run.endS,
      text: '“' + run.words.join(' ') + '”',
      // staged → un-stage (keep); applied → undo the committed cut (live).
      keep: () => ids.forEach((id) => (applied ? r.toggleWord(id) : r.selectWord(id, true)))
    })
    run = null
  }
  for (const seg of r.segments) {
    for (const w of seg.words) {
      if (hit(w.id)) {
        if (!run) run = { startS: w.start, endS: w.end, words: [w.text], ids: [w.id] }
        else { run.endS = w.end; run.words.push(w.text); run.ids.push(w.id) }
      } else {
        flush()
      }
      const chip = r.chipAfter.get(w.id)
      if (!applied && chip && chip.stagedId && r.isChipSel(chip.stagedId)) {
        flush()
        const sid = chip.stagedId
        cuts.push({ id: 's:' + sid, kind: 'Silence', dot: '#e6b26a', startS: w.end, endS: w.end + chip.durS, text: `${chip.durS}s of dead air`, keep: () => r.toggleChip(sid) })
      }
    }
  }
  flush()
  // "Find Silences" runs WITHOUT transcribing, so on a project that has never
  // been transcribed there are no words and no chips — the loop above produces
  // nothing even though silences are staged. Fall back to the raw spans so the
  // run is visible and reviewable.
  if (!applied && !r.segments.length) {
    for (const s of r.stagedSilenceCuts) {
      cuts.push({
        id: 's:' + s.id,
        kind: 'Silence',
        dot: '#e6b26a',
        startS: s.startS,
        endS: s.endS,
        text: `${(s.endS - s.startS).toFixed(1)}s of dead air`,
        keep: () => r.toggleChip(s.id)
      })
    }
  }
  return cuts.sort((a, b) => a.startS - b.startS)
}

// Original (pre-cut) runtime = last spoken word's end, or the source length when
// there is no transcript to measure (silence-only runs).
function originalRuntime(r: ReturnType<typeof useRetake>): number {
  let end = 0
  for (const seg of r.segments) for (const w of seg.words) end = Math.max(end, w.end)
  return end || r.sourceDurationS
}

export default function SpeechCleanerPanel(): JSX.Element {
  const r = useRetake()
  const shownPct = Math.round(useSmoothProgress(r.job.active, r.job.percent))

  if (r.state === 'idle') {
    return (
      <div style={css('flex:1;min-height:0;overflow-y:auto;padding:14px 14px 18px')}>
        <div style={css('font-size:12px;color:#8b8ba0;line-height:1.5')}>Transcribe your video and find retakes, false starts, fillers and dead air — reviewable before anything is cut.</div>
        <button onClick={r.find} style={css('width:100%;margin-top:14px;background:#7c6bff;border:none;color:#fff;font-family:inherit;font-size:13.5px;font-weight:650;border-radius:10px;padding:12px;cursor:pointer;box-shadow:0 6px 20px rgba(124,107,255,.28)')}>Find cuts</button>
        {/* Smart Silence (transcript-gap) — secondary so "Find cuts" stays primary. */}
        <button onClick={r.findSilences} style={css('width:100%;margin-top:10px;background:rgba(124,107,255,.12);border:1px solid rgba(124,107,255,.4);color:#c4baff;font-family:inherit;font-size:13px;font-weight:600;border-radius:10px;padding:11px;cursor:pointer')}>Find Silences</button>
        {/* Find cuts runs both silence engines around the retake judge:
            step 1 Smart Silence (transcript gaps) -> step 2 retake AI -> step 3
            Silence settings (FSMN audio VAD). Numbered so it's clear which
            modal tunes which stage. */}
        <div style={css('font-size:11px;color:#71718a;margin-top:16px;line-height:1.5')}>Find cuts runs in 3 steps — dead air, then retakes, then silence.</div>
        <button onClick={r.openSmartSilenceSettings} style={css('width:100%;margin-top:8px;background:none;border:1px solid rgba(255,255,255,.1);color:#c9c9da;font-family:inherit;font-size:12.5px;font-weight:500;border-radius:9px;padding:10px 0;cursor:pointer')}>1 · Smart Silence settings</button>
        <button onClick={r.openSilenceSettings} style={css('width:100%;margin-top:8px;background:none;border:1px solid rgba(255,255,255,.1);color:#c9c9da;font-family:inherit;font-size:12.5px;font-weight:500;border-radius:9px;padding:10px 0;cursor:pointer')}>3 · Silence settings</button>
      </div>
    )
  }

  if (r.state === 'analyzing') {
    return (
      <div style={css('flex:1;min-height:0;overflow-y:auto;padding:14px')}>
        <div style={css('background:#111117;border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:14px')}>
          <div style={css('display:flex;align-items:center;justify-content:space-between;font-size:12.5px')}><span style={css('color:#ededf2;font-weight:550')}>Finding cuts…</span><span style={css("font-family:'Geist Mono',monospace;font-size:11px;color:#9a9aae")}>{shownPct}%</span></div>
          <div style={css('height:4px;border-radius:2px;background:#22222b;overflow:hidden;margin-top:12px')}><div style={css(`width:${Math.max(4, shownPct)}%;height:100%;border-radius:2px;background:#7c6bff`)} /></div>
          <div style={css('font-size:12px;color:#9a9aae;margin-top:12px;line-height:1.5')}>{r.job.message || 'Working…'}</div>
        </div>
      </div>
    )
  }

  const applied = r.state === 'executed' && r.deletedCount > 0
  const cuts = deriveCuts(r, applied)
  const original = originalRuntime(r)
  const newRuntime = Math.max(0, original - r.timeSavedS)

  return (
    <div style={css('flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden')}>
      <div style={css('flex:none;padding:10px 14px 0')}>
        <div style={css('font-size:11.5px;color:#7a7a8c;line-height:1.45')}>Retakes, false starts, fillers and dead air found in your speech.</div>
      </div>

      {/* runtime summary */}
      <div style={css(`flex:none;padding:12px 14px;border-bottom:1px solid ${HAIR}`)}>
        <div style={css('display:flex;align-items:center;gap:8px;background:#111117;border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:10px 12px')}>
          <div>
            <div style={css('font-size:12px;color:#8b8ba0')}>{applied ? 'Runtime' : 'New runtime'}</div>
            <div style={css('font-size:16px;font-weight:600;letter-spacing:-.02em;margin-top:2px')}>{mmss(newRuntime)} <span style={css('font-size:11.5px;font-weight:400;color:#7ed6a6')}>−{Math.round(r.timeSavedS)}s</span></div>
          </div>
          <div style={css('flex:1')} />
          {!applied && (
            <div style={css('display:flex;gap:6px')}>
              <span onClick={() => { r.clear() }} style={css('font-size:11.5px;color:#9a9aae;border:1px solid rgba(255,255,255,.1);padding:6px 9px;border-radius:7px;cursor:pointer')}>Keep all</span>
              <span onClick={r.find} title="Re-detect cuts (reuses the transcript)" style={css('font-size:11.5px;color:#9a9aae;border:1px solid rgba(255,255,255,.1);padding:6px 9px;border-radius:7px;cursor:pointer')}>Re-scan</span>
            </div>
          )}
        </div>
        <div style={css('font-size:11.5px;color:#7a7a8c;margin-top:9px')}>{applied ? `${cuts.length} cut${cuts.length === 1 ? '' : 's'} applied · undo any below.` : `${cuts.length} cut${cuts.length === 1 ? '' : 's'} · nothing is removed until you apply.`}</div>
        {/* Smart Silence (transcript-gap) — additive; reachable after a transcribe-only
            or alongside Retake results. Re-running reflects the latest settings. */}
        {!applied && (
          <div style={css('display:flex;gap:8px;align-items:center;margin-top:11px')}>
            <button onClick={r.findSilences} style={css('font-size:11.5px;color:#c4baff;background:rgba(124,107,255,.12);border:1px solid rgba(124,107,255,.4);padding:6px 11px;border-radius:8px;cursor:pointer;font-family:inherit;font-weight:600')}>Find Silences</button>
            <button onClick={r.openSmartSilenceSettings} style={css('font-size:11.5px;color:#9a9aae;background:none;border:1px solid rgba(255,255,255,.1);padding:6px 11px;border-radius:8px;cursor:pointer;font-family:inherit')}>Smart Silence settings</button>
          </div>
        )}
      </div>

      {/* cut cards */}
      <div style={css('flex:1;min-height:0;overflow-y:auto;padding:10px 12px')}>
        {cuts.length === 0 ? (
          <div style={css('padding:30px 8px;text-align:center;font-size:12px;color:#6e6e85;line-height:1.6')}>{applied ? 'No cuts remain.' : 'No cuts staged — strike words in the Transcript, or Re-scan.'}</div>
        ) : (
          <div style={css('display:flex;flex-direction:column;gap:8px')}>
            {cuts.map((c) => (
              <div key={c.id} style={css('background:#111117;border:1px solid rgba(255,255,255,.07);border-radius:11px;padding:11px 12px')}>
                <div style={css('display:flex;align-items:center;gap:8px')}>
                  <span style={css(`width:6px;height:6px;border-radius:50%;flex:none;background:${c.dot}`)} />
                  <span style={css('font-size:11.5px;font-weight:500;color:#c9c9da')}>{c.kind}</span>
                  <span style={css("font-family:'Geist Mono',monospace;font-size:10.5px;color:#6e6e85")}>{mmssT(c.startS)} → {mmssT(c.endS)}</span>
                  <div style={css('flex:1')} />
                  <span onClick={c.keep} style={css(`font-size:10px;font-weight:600;padding:3px 8px;border-radius:6px;cursor:pointer;${applied ? 'color:#9a9aae;border:1px solid rgba(255,255,255,.12)' : 'color:#ff9b9b;background:rgba(255,155,155,.14);border:1px solid rgba(255,155,155,.3)'}`)}>{applied ? 'Undo' : 'Cut'}</span>
                </div>
                <div style={css('font-size:12.5px;color:#9a9aae;line-height:1.55;margin-top:8px')}>{c.text}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* apply */}
      <div style={css(`flex:none;padding:12px 14px 14px;border-top:1px solid ${HAIR}`)}>
        {applied ? (
          /* The real actions, not a bare "Run again" — after applying you still
             want to find more cuts, sweep silences again, or open either stage's
             settings without leaving the tab. Same set as the idle screen. */
          <>
            <button onClick={r.find} style={css('width:100%;background:#7c6bff;border:none;color:#fff;font-family:inherit;font-size:13.5px;font-weight:650;padding:12px;border-radius:10px;cursor:pointer;box-shadow:0 6px 20px rgba(124,107,255,.28)')}>Find cuts</button>
            <button onClick={r.findSilences} style={css('width:100%;margin-top:8px;background:rgba(124,107,255,.12);border:1px solid rgba(124,107,255,.4);color:#c4baff;font-family:inherit;font-size:13px;font-weight:600;border-radius:10px;padding:11px;cursor:pointer')}>Find Silences</button>
            <div style={css('display:flex;gap:8px;margin-top:8px')}>
              <button onClick={r.openSmartSilenceSettings} style={css('flex:1;background:none;border:1px solid rgba(255,255,255,.1);color:#c9c9da;font-family:inherit;font-size:12px;font-weight:500;border-radius:9px;padding:10px 0;cursor:pointer')}>1 · Smart Silence</button>
              <button onClick={r.openSilenceSettings} style={css('flex:1;background:none;border:1px solid rgba(255,255,255,.1);color:#c9c9da;font-family:inherit;font-size:12px;font-weight:500;border-radius:9px;padding:10px 0;cursor:pointer')}>3 · Silence</button>
            </div>
          </>
        ) : (
          <button onClick={r.execute} disabled={!r.executable} style={css('width:100%;background:#7c6bff;border:none;color:#fff;font-family:inherit;font-size:13.5px;font-weight:600;padding:12px;border-radius:10px;cursor:pointer;box-shadow:0 6px 20px rgba(124,107,255,.28)', !r.executable && 'opacity:.5;cursor:not-allowed;box-shadow:none')}>Apply {r.executable} cut{r.executable === 1 ? '' : 's'}</button>
        )}
        <div style={css('text-align:center;font-size:11px;color:#6e6e85;margin-top:9px')}>Undoable · your original file is never touched</div>
      </div>
    </div>
  )
}
