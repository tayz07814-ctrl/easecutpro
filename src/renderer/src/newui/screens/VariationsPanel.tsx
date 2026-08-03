// Variations — arrange the source video from a creator-supplied clip list.
//
// The creator uploads (or pastes) a JSON file of source ranges; the ARRAY ORDER
// is the edit order. Applying it REPLACES the main lane with exactly that
// arrangement in one undoable edit, so re-applying is idempotent rather than
// cumulative.

import { useRef, useState } from 'react'
import { css } from '../css'
import { useStore } from '../../store'
import { getSharedEngine } from '../../timelineEngine'
import { mainTrackId, findTrack } from '@shared/timeline/model'
import { framesToSeconds } from '@shared/timeline/time'
import { parseVariation, variationDuration, VARIATION_EXAMPLE, type Variation } from '@shared/variations'
import { VARIATION_LENGTHS, DEFAULT_VARIATION_LENGTH } from '@shared/aiVariations'

/** Source length used to clamp ranges. `project.media` is empty on doc-native
 *  projects, so fall back to the main lane's own source duration; 0 disables
 *  clamping rather than silently rejecting every clip. */
function sourceDurationS(mediaDuration: number): number {
  if (mediaDuration > 0) return mediaDuration
  const doc = getSharedEngine()?.document
  if (!doc) return 0
  const id = mainTrackId(doc)
  const clip = (id ? findTrack(doc, id)?.clips ?? [] : []).find((c) => !!c.sourcePath && !!c.sourceDuration)
  return clip?.sourceDuration ? framesToSeconds(clip.sourceDuration, doc.timebase) : 0
}

const BTN_PRIMARY =
  'width:100%;background:#7c6bff;border:none;color:#fff;font-family:inherit;font-size:13.5px;font-weight:650;border-radius:10px;padding:12px;cursor:pointer;box-shadow:0 6px 20px rgba(124,107,255,.28)'
const BTN_GHOST =
  'width:100%;margin-top:8px;background:none;border:1px solid rgba(255,255,255,.1);color:#c9c9da;font-family:inherit;font-size:12.5px;font-weight:500;border-radius:9px;padding:10px 0;cursor:pointer'

function fmt(s: number): string {
  const m = Math.floor(s / 60)
  const r = s - m * 60
  return m > 0 ? `${m}:${r.toFixed(1).padStart(4, '0')}` : `${r.toFixed(2)}s`
}

export default function VariationsPanel(): JSX.Element {
  const applyVariation = useStore((s) => s.applyVariation)
  const generate = useStore((s) => s.generateVariations)
  const ai = useStore((s) => s.aiVariations)
  const aiWarnings = useStore((s) => s.aiVariationWarnings)
  const busy = useStore((s) => s.aiVariationsBusy)
  const mediaDuration = useStore((s) => s.project.media?.duration ?? 0)
  const fileRef = useRef<HTMLInputElement>(null)

  const [count, setCount] = useState(3)
  const [lengthS, setLengthS] = useState<number>(DEFAULT_VARIATION_LENGTH)
  const [variation, setVariation] = useState<Variation | null>(null)
  const [error, setError] = useState<string>('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [applied, setApplied] = useState(false)
  const [paste, setPaste] = useState(false)
  const [text, setText] = useState('')

  const load = (raw: string, fallbackName?: string): void => {
    const res = parseVariation(raw, sourceDurationS(mediaDuration), fallbackName)
    setError(res.error ?? '')
    setWarnings(res.warnings)
    setVariation(res.variation)
    setApplied(false)
  }

  const onFile = (f: File | null | undefined): void => {
    if (!f) return
    f.text()
      .then((raw) => load(raw, f.name.replace(/\.json$/i, '')))
      .catch((e) => {
        setError(`Couldn’t read that file (${(e as Error).message})`)
        setVariation(null)
      })
  }

  const apply = (): void => {
    if (!variation) return
    applyVariation(variation)
    setApplied(true)
  }

  const total = variation ? variationDuration(variation) : 0

  return (
    <div style={css('flex:1;min-height:0;overflow-y:auto;padding:14px 14px 18px')}>
      <div style={css('font-size:12px;color:#8b8ba0;line-height:1.5')}>
        Cut your video into a new running order — lead with the hook, reorder sections, repeat a moment. Let the AI cast it, or upload your own clip list.
      </div>

      {/* AI casting — the transcript goes to the judge, which picks hook / intro /
          problem / selling point / CTA and sequences them. */}
      <div style={css('margin-top:14px;background:#0f0f14;border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:12px')}>
        <div style={css('font-size:12.5px;color:#ededf2;font-weight:600')}>Let AI build it</div>
        <div style={css('font-size:11px;color:#8b8ba0;margin-top:4px;line-height:1.5')}>Reads your transcript and arranges hook, intro, problem, selling point and CTA.</div>
        <div style={css('display:flex;gap:8px;align-items:center;margin-top:11px')}>
          <select
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            disabled={busy}
            style={css("flex:1;min-width:0;background:#0a0a0e;border:1px solid rgba(255,255,255,.12);color:#c9c9da;font-family:inherit;font-size:12px;border-radius:8px;padding:9px 8px;cursor:pointer;outline:none")}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>{n} variation{n === 1 ? '' : 's'}</option>
            ))}
          </select>
          {/* How long each variation should run. Seconds of SPEECH, which is what
              the model actually controls by picking more or fewer sections. */}
          <select
            value={lengthS}
            onChange={(e) => setLengthS(Number(e.target.value))}
            disabled={busy}
            title="Roughly how long each variation should run"
            style={css("flex:1;min-width:0;background:#0a0a0e;border:1px solid rgba(255,255,255,.12);color:#c9c9da;font-family:inherit;font-size:12px;border-radius:8px;padding:9px 8px;cursor:pointer;outline:none")}
          >
            {VARIATION_LENGTHS.map((s) => (
              <option key={s} value={s}>~{s}s each</option>
            ))}
          </select>
        </div>
        <div style={css('display:flex;margin-top:8px')}>
          <button
            onClick={() => void generate(count, lengthS)}
            disabled={busy}
            style={css(
              'flex:1;background:#7c6bff;border:none;color:#fff;font-family:inherit;font-size:12.5px;font-weight:650;border-radius:9px;padding:10px;cursor:pointer',
              busy ? 'opacity:.55;cursor:default' : ''
            )}
          >
            {busy ? 'Casting…' : 'Generate'}
          </button>
        </div>
      </div>

      {/* Generated set — pick one to load it into the preview below. */}
      {ai.length > 0 && (
        <div style={css('margin-top:12px;display:flex;flex-direction:column;gap:5px')}>
          {ai.map((g, i) => {
            const on = variation?.name === g.name
            return (
              <div
                key={i}
                onClick={() => { setVariation(g); setError(''); setWarnings([]); setApplied(false) }}
                style={css(
                  'display:flex;align-items:center;gap:9px;border-radius:9px;padding:9px 11px;cursor:pointer;border:1px solid',
                  on ? 'border-color:#7c6bff;background:rgba(124,107,255,.12)' : 'border-color:rgba(255,255,255,.08);background:#0f0f14'
                )}
              >
                <span style={css(`flex:1;min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${on ? '#c4baff' : '#c9c9da'};${on ? 'font-weight:600' : ''}`)}>{g.name}</span>
                <span style={css("font-family:'Geist Mono',monospace;font-size:10.5px;color:#8b8ba0;flex:none")}>{g.clips.length} · {fmt(variationDuration(g))}</span>
              </div>
            )
          })}
        </div>
      )}

      {aiWarnings.length > 0 && (
        <div style={css('margin-top:10px;font-size:11px;color:#e8c98a;background:rgba(232,201,138,.07);border:1px solid rgba(232,201,138,.22);border-radius:9px;padding:9px 11px;line-height:1.55')}>
          {aiWarnings.map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </div>
      )}

      <div style={css('margin-top:16px;border-top:1px solid rgba(255,255,255,.07);padding-top:14px;font-size:11px;color:#6e6e85')}>Or bring your own</div>

      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        onChange={(e) => {
          onFile(e.target.files?.[0])
          e.target.value = '' // let the same file be picked again after an edit
        }}
        style={css('display:none')}
      />

      <button onClick={() => fileRef.current?.click()} style={css(BTN_PRIMARY, 'margin-top:14px')}>Upload variation JSON</button>
      <button onClick={() => setPaste((v) => !v)} style={css(BTN_GHOST)}>{paste ? 'Hide paste box' : 'Paste JSON instead'}</button>

      {paste && (
        <div style={css('margin-top:10px')}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            placeholder={VARIATION_EXAMPLE}
            style={css(
              "width:100%;height:150px;resize:vertical;background:#0a0a0e;border:1px solid rgba(255,255,255,.1);border-radius:9px;color:#c9c9da;font-family:'Geist Mono',monospace;font-size:11px;line-height:1.5;padding:10px;outline:none"
            )}
          />
          <button
            onClick={() => text.trim() && load(text, 'Pasted')}
            style={css(BTN_GHOST, 'margin-top:6px', text.trim() ? '' : 'opacity:.45;cursor:default')}
          >
            Read pasted JSON
          </button>
        </div>
      )}

      {error && (
        <div style={css('margin-top:12px;font-size:11.5px;color:#ffb4b4;background:rgba(255,91,110,.09);border:1px solid rgba(255,91,110,.28);border-radius:9px;padding:9px 11px;line-height:1.5')}>
          {error}
        </div>
      )}

      {variation && (
        <>
          <div style={css('display:flex;align-items:baseline;justify-content:space-between;margin-top:16px')}>
            <span style={css('font-size:12.5px;color:#ededf2;font-weight:600')}>{variation.name || 'Variation'}</span>
            <span style={css("font-family:'Geist Mono',monospace;font-size:11px;color:#a99bff")}>{variation.clips.length} · {fmt(total)}</span>
          </div>

          {/* Ordered preview — the number is the POSITION IN THE EDIT, the range is
              where it comes from in the source, so an out-of-order list reads clearly. */}
          <div style={css('margin-top:9px;display:flex;flex-direction:column;gap:4px')}>
            {variation.clips.map((c, i) => (
              <div key={i} style={css('display:flex;align-items:center;gap:9px;background:#0f0f14;border:1px solid rgba(255,255,255,.07);border-radius:8px;padding:7px 10px')}>
                <span style={css("font-family:'Geist Mono',monospace;font-size:10.5px;color:#5c5c70;flex:none;width:16px")}>{i + 1}</span>
                <span style={css('flex:1;min-width:0;font-size:11.5px;color:#c9c9da;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')}>{c.name || 'Clip'}</span>
                <span style={css("font-family:'Geist Mono',monospace;font-size:10.5px;color:#8b8ba0;flex:none")}>{c.start.toFixed(2)}–{c.end.toFixed(2)}s</span>
              </div>
            ))}
          </div>

          {warnings.length > 0 && (
            <div style={css('margin-top:11px;font-size:11px;color:#e8c98a;background:rgba(232,201,138,.07);border:1px solid rgba(232,201,138,.22);border-radius:9px;padding:9px 11px;line-height:1.55')}>
              {warnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
          )}

          <button onClick={apply} style={css(BTN_PRIMARY, 'margin-top:12px')}>
            {applied ? 'Re-apply arrangement' : `Apply ${variation.clips.length} clip${variation.clips.length === 1 ? '' : 's'}`}
          </button>
          <div style={css('margin-top:8px;font-size:11px;color:#6e6e85;line-height:1.5')}>
            Replaces the main video track and clears any existing cuts, so your clips play exactly as listed — pauses and all. Undo (⌘Z) puts it back.
          </div>
        </>
      )}

      {!variation && !error && (
        <div style={css('margin-top:18px;border-top:1px solid rgba(255,255,255,.07);padding-top:14px')}>
          <div style={css('font-size:11.5px;color:#8b8ba0;margin-bottom:7px')}>Expected format</div>
          <pre style={css("margin:0;background:#0a0a0e;border:1px solid rgba(255,255,255,.07);border-radius:9px;padding:10px;overflow-x:auto;font-family:'Geist Mono',monospace;font-size:10.5px;line-height:1.55;color:#8b8ba0")}>{VARIATION_EXAMPLE}</pre>
          <div style={css('font-size:10.5px;color:#5c5c70;margin-top:8px;line-height:1.55')}>
            A bare array works too — <span style={css("font-family:'Geist Mono',monospace")}>[[5,8],[1,3]]</span>. Times are seconds from the start of your source video.
          </div>
        </div>
      )}
    </div>
  )
}
