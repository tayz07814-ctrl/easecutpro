// Transcript drawer (left "Transcript" tool) — the redesign's strike-to-cut
// transcript. Words are the SAME transcript the retake engine produces; striking
// a word stages it for cutting (r.selectWord), exactly like the review panel, so
// the cut-card list on the right and the timeline stay in sync. Nothing is
// removed until Execute/Apply. Wired entirely to useRetake — no mock data.

import { useEffect, useRef } from 'react'
import { css } from '../css'
import { useStore } from '../../store'
import { useRetake } from '../data/useRetake'

const HAIR = 'rgba(255,255,255,.06)'
const CHIP = "background:rgba(230,178,106,.14);color:#e6b26a;border:1px solid rgba(230,178,106,.3);border-radius:6px;padding:2px 7px;font-family:'Geist Mono',monospace;font-size:10px;margin:0 4px;white-space:nowrap"
const SEL = 'background:rgba(255,155,155,.22);color:#ff9b9b;border-radius:4px;padding:1px 3px;box-shadow:inset 0 0 0 1px rgba(255,155,155,.4)'
const CUT = 'background:rgba(255,155,155,.13);color:#ff9b9b;border-radius:5px;padding:1px 4px;text-decoration:line-through;text-decoration-color:rgba(255,155,155,.55)'
const SELCUT = 'background:rgba(124,107,255,.28);color:#c4baff;border-radius:4px;padding:1px 3px;box-shadow:inset 0 0 0 1px rgba(124,107,255,.55);text-decoration:line-through;text-decoration-color:rgba(196,186,255,.5)'

const mmss = (s: number): string => {
  const t = Math.max(0, Math.floor(s))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}
const secs = (s: number): string => `${Math.max(0, s).toFixed(1)}s`

// Paragraph tag derived from REAL state (not a fake label): a clip's first
// paragraph → "Take N"; a paragraph that carries staged/filler words → "Filler";
// otherwise "Clean".
function tagOf(kind: 'take' | 'filler' | 'clean', n: number): { label: string; style: string } {
  if (kind === 'take') return { label: `Take ${n}`, style: 'background:rgba(124,107,255,.16);color:#a99bff' }
  if (kind === 'filler') return { label: 'Filler', style: 'background:rgba(230,178,106,.16);color:#e6b26a' }
  return { label: 'Clean', style: 'background:rgba(126,214,166,.14);color:#7ed6a6' }
}

const chipDown = (r: ReturnType<typeof useRetake>, stagedId?: string) => (e: React.MouseEvent): void => {
  e.preventDefault()
  e.stopPropagation()
  if (stagedId) r.toggleChip(stagedId)
}

export default function TranscriptDrawer({ width }: { width: number }): JSX.Element {
  const r = useRetake()
  const fillerWords = useStore((s) => s.fillerWords)
  const fillerSet = new Set(fillerWords.map((w) => w.toLowerCase()))
  const isFiller = (t: string): boolean => fillerSet.has(t.trim().toLowerCase().replace(/[.,!?;:]/g, ''))

  const isMarked = r.isSelected
  const applyWord = (id: string): void => r.selectWord(id, true)
  const drag = useRef<{ active: boolean; anchor: string | null; add: boolean; moved: boolean; done: Set<string> }>({
    active: false, anchor: null, add: true, moved: false, done: new Set()
  })
  const paint = (id: string): void => {
    const d = drag.current
    if (d.done.has(id)) return
    d.done.add(id)
    if (d.add ? !isMarked(id) : isMarked(id)) applyWord(id)
  }
  useEffect(() => {
    const up = (): void => {
      const d = drag.current
      if (d.active && !d.moved && d.anchor) applyWord(d.anchor)
      d.active = false; d.anchor = null; d.moved = false; d.done = new Set()
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const strikeFillers = (): void => {
    for (const seg of r.segments) for (const w of seg.words) if (isFiller(w.text) && !r.isSelected(w.id)) r.selectWord(w.id, true)
  }

  // struck (staged) count across the transcript, for the footer.
  let struck = 0
  for (const seg of r.segments) for (const w of seg.words) if (r.isSelected(w.id)) struck++

  const bounds = r.clipBounds
  const clipOf = (startS: number): number => {
    let idx = 0
    for (let i = 0; i < bounds.length; i++) if (startS >= bounds[i].startS - 0.01) idx = i
    return idx
  }
  let lastClip = -1

  const empty = r.segments.length === 0

  return (
    <div style={css(`width:${width}px;flex:none;min-width:0;border-right:1px solid ${HAIR};background:#0a0a0d;display:flex;flex-direction:column;overflow:hidden`)}>
      <div style={css(`padding:14px 16px 12px;border-bottom:1px solid ${HAIR};flex:none`)}>
        <div style={css('display:flex;align-items:center;gap:8px')}>
          <div style={css('font-size:13.5px;font-weight:600;letter-spacing:-.01em')}>Transcript</div>
          <div style={css('flex:1')} />
          <span style={css("font-family:'Geist Mono',monospace;font-size:10px;color:#6e6e85")}>{empty ? '—' : `${r.wordCount || struck || ''}${struck ? ' struck' : ' words'}`.trim() || 'words'}</span>
        </div>
        <div style={css('font-size:11.5px;color:#7a7a8c;margin-top:4px;line-height:1.45')}>Strike out words to cut them from the video. Double-click a word to play it.</div>
        <div style={css('display:flex;gap:6px;margin-top:11px')}>
          <span onClick={strikeFillers} style={css('font-size:11.5px;color:#d6d6e4;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);padding:6px 10px;border-radius:7px;cursor:pointer')}>Strike fillers</span>
          <span onClick={r.clear} style={css('font-size:11.5px;color:#9a9aae;border:1px solid rgba(255,255,255,.1);padding:6px 10px;border-radius:7px;cursor:pointer')}>Restore all</span>
        </div>
      </div>

      {empty ? (
        <div style={css('flex:1;min-height:0;display:grid;place-items:center;padding:24px;text-align:center')}>
          <div>
            <div style={css('font-size:12.5px;color:#9a9aae;line-height:1.6;max-width:220px;margin:0 auto')}>No transcript yet. Run the Speech cleaner (AI tools → Speech cleaner) to transcribe and find cuts.</div>
            <button onClick={r.find} style={css('margin-top:14px;background:#7c6bff;border:none;color:#fff;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:9px 16px;cursor:pointer')}>Transcribe &amp; find cuts</button>
          </div>
        </div>
      ) : (
        <div style={css('flex:1;min-height:0;overflow-y:auto;padding:14px 16px 20px;display:flex;flex-direction:column;gap:16px;font-size:13.5px;line-height:1.85;letter-spacing:-.005em;color:#c9c9da')}>
          {r.segments.map((seg, si) => {
            const startS = seg.words[0]?.start ?? 0
            const ci = bounds.length > 1 ? clipOf(startS) : 0
            const newClip = bounds.length > 1 && ci !== lastClip
            lastClip = ci
            const hasFiller = seg.words.some((w) => isFiller(w.text) || r.isSelected(w.id))
            const tag = tagOf(newClip || si === 0 ? 'take' : hasFiller ? 'filler' : 'clean', ci + 1)
            return (
              <div key={seg.id}>
                <div style={css('display:flex;align-items:center;gap:8px;margin-bottom:6px')}>
                  <span style={css("font-family:'Geist Mono',monospace;font-size:10px;color:#6e6e85")}>{mmss(startS)}</span>
                  <span style={css(`font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:20px;${tag.style}`)}>{tag.label}</span>
                </div>
                <p style={css('margin:0')}>
                  {seg.words.map((w) => {
                    const chip = r.chipAfter.get(w.id)
                    const sel = r.isSelected(w.id)
                    const cut = r.isDeleted(w.id)
                    return (
                      <span key={w.id}>
                        <span
                          onMouseDown={(e) => {
                            e.preventDefault()
                            if (e.detail >= 2) { applyWord(w.id); r.seekWord(w.start); drag.current.active = false; return }
                            drag.current = { active: true, anchor: w.id, add: !isMarked(w.id), moved: false, done: new Set() }
                          }}
                          onMouseEnter={() => {
                            const d = drag.current
                            if (!d.active) return
                            if (w.id !== d.anchor) { if (!d.moved && d.anchor) paint(d.anchor); d.moved = true }
                            paint(w.id)
                          }}
                          style={css(sel ? (cut ? SELCUT : SEL) : cut ? CUT : 'cursor:pointer;border-radius:4px;padding:1px 3px')}
                        >
                          {w.text}
                        </span>{' '}
                        {chip && <span onMouseDown={chipDown(r, chip.stagedId)} style={css(CHIP)}>{chip.durS}s</span>}
                        {chip && ' '}
                      </span>
                    )
                  })}
                </p>
              </div>
            )
          })}
        </div>
      )}

      <div style={css(`flex:none;padding:12px 14px 14px;border-top:1px solid ${HAIR};display:flex;align-items:center;gap:10px`)}>
        <span style={css('font-size:11.5px;color:#8b8ba0')}>{struck === 0 ? 'No words struck' : `${struck} word${struck === 1 ? '' : 's'} struck`}</span>
        <div style={css('flex:1')} />
        <span style={css('font-size:11.5px;color:#7ed6a6')}>−{secs(r.timeSavedS)}</span>
      </div>
    </div>
  )
}
