import { useState } from 'react'
import { useStore } from '../store'
import { mediaSrc, IS_CLOUD } from '../platform'
import { useSharedEngineSnapshot } from '../timelineEngine'
import { docSourceToEdited } from '../docTime'
import type { OverlayAnimation, OverlayOccurrence, OverlayPosition } from '@shared/types'

const POSITIONS: OverlayPosition[] = [
  'top_center', 'center', 'bottom_center', 'top_left', 'top_right', 'bottom_left', 'bottom_right'
]
const ANIMS: OverlayAnimation[] = ['none', 'pop', 'fade']
const OCCURRENCES: { value: OverlayOccurrence; label: string }[] = [
  { value: 'every', label: 'every mention' },
  { value: 'first', label: 'first mention only' },
  { value: 'last', label: 'last mention only' }
]
// On-screen size presets (percent of the position preset's default scale).
const SIZES: { value: number; label: string }[] = [
  { value: 60, label: 'Small' },
  { value: 80, label: 'Medium' },
  { value: 100, label: 'Default' },
  { value: 130, label: 'Large' },
  { value: 160, label: 'XL' }
]

function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Author overlay images + natural-language placement rules; run AI placement. */
export default function OverlayPanel(): JSX.Element {
  const assets = useStore((s) => s.project.overlayAssets ?? [])
  const rules = useStore((s) => s.project.overlayRules ?? [])
  const library = useStore((s) => s.library)
  const job = useStore((s) => s.job)
  const hasTranscript = useStore((s) => (s.project.transcript?.segments?.length ?? 0) > 0)
  const overlayLog = useStore((s) => s.overlayLog)
  const [logCopied, setLogCopied] = useState(false)
  // true once the creator has run Generate/Suggest this session — gates the status
  // line so it shows the overlay job's message (not a stale unrelated one on mount).
  const [ranOp, setRanOp] = useState(false)
  const addOverlayAsset = useStore((s) => s.addOverlayAsset)
  const updateOverlayRule = useStore((s) => s.updateOverlayRule)
  const removeOverlayAsset = useStore((s) => s.removeOverlayAsset)
  const generateOverlays = useStore((s) => s.generateOverlays)
  const clearGeneratedOverlays = useStore((s) => s.clearGeneratedOverlays)

  // Suggest (proactive review flow)
  const suggestions = useStore((s) => s.overlaySuggestions)
  const suggestOverlays = useStore((s) => s.suggestOverlays)
  const acceptSuggestions = useStore((s) => s.acceptSuggestions)
  const dismissSuggestion = useStore((s) => s.dismissSuggestion)
  const clearSuggestions = useStore((s) => s.clearSuggestions)
  const setPlayhead = useStore((s) => s.setPlayhead)
  const setPlaying = useStore((s) => s.setPlaying)
  const hasTimeline = useStore((s) => !!s.project.timeline)
  const snap = useSharedEngineSnapshot()
  const doc = hasTimeline ? snap?.doc : undefined

  const used = new Set(assets.map((a) => a.libraryItemId))
  const images = library.filter((i) => i.kind === 'image' && !used.has(i.id))
  const ruleFor = (id: string) => rules.find((r) => r.overlayId === id)
  const assetById = (id: string) => assets.find((a) => a.id === id)
  const seek = (srcStart: number): void => {
    setPlayhead(hasTimeline ? docSourceToEdited(doc, srcStart) : srcStart)
    setPlaying(true)
  }

  return (
    <div className="overlay-panel">
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>🎬 Auto B-roll</div>
      <p className="muted small">
        Import b-roll images in the Media Library, then press <b>Auto B-roll</b> — Gemma looks at
        each image and the video and proposes where it fits. Tune each one's size and position
        below. Placed on overlay track 1 — drag or delete after.
      </p>

      {/* One-click entry: adds every imported image as an overlay, then runs Gemma
          placement. Visible as soon as ANY image exists (added or not), so the
          creator never has to hunt for a hidden button behind a two-step add. */}
      {(images.length > 0 || assets.length > 0) && (
        <button
          className="primary"
          style={{ width: '100%', marginBottom: 12, padding: '11px 0', fontSize: 13, fontWeight: 600 }}
          disabled={job.active || !hasTranscript}
          title={hasTranscript ? 'Add your images and let Gemma place each as b-roll where it fits' : 'Needs a transcript — run Find Retakes & Silence or Transcribe first'}
          onClick={() => {
            setRanOp(true)
            // auto-add any imported images not yet added as overlays, then place
            for (const img of images) addOverlayAsset(img.id)
            void suggestOverlays()
          }}
        >
          {job.active ? '⏳ Placing b-roll…' : '🎬 Auto B-roll'}
        </button>
      )}
      {!hasTranscript && (images.length > 0 || assets.length > 0) && (
        <p className="muted small" style={{ marginTop: -6 }}>
          Run <b>Find Retakes &amp; Silence</b> (or Transcribe) first — Gemma reads the transcript to know where each image belongs.
        </p>
      )}

      {images.length > 0 && (
        <div className="ov-add-row">
          {images.map((i) => (
            <button
              key={i.id}
              className="ov-add"
              title={`Add ${i.name} as an overlay`}
              disabled={assets.length >= 10}
              onClick={() => addOverlayAsset(i.id)}
            >
              {i.thumb ? <img src={i.thumb} alt="" /> : <span>🖼</span>}
              <span className="ov-add-name">+ {i.name}</span>
            </button>
          ))}
        </div>
      )}
      {assets.length === 0 && images.length === 0 && (
        <p className="muted small">No overlay images yet — import images in the Media Library first.</p>
      )}

      {assets.map((a) => {
        const r = ruleFor(a.id)
        if (!r) return null
        return (
          <div key={a.id} className="ov-rule">
            <div className="ov-rule-head">
              {a.file ? <img className="ov-thumb" src={mediaSrc(a.file)} alt="" /> : null}
              <input
                className="ov-name"
                value={r.name}
                onChange={(e) => updateOverlayRule(a.id, { name: e.target.value })}
              />
              <button className="ov-del" title="Remove overlay" onClick={() => removeOverlayAsset(a.id)}>✕</button>
            </div>
            {a.description ? <div className="ov-desc" title="What the AI sees in this image">👁 {a.description}</div> : null}
            <textarea
              className="ov-instr"
              placeholder={`Optional — matches the name "${r.name}" by itself. Or describe it: show this when I talk about bloating, my stomach feeling lighter…`}
              value={r.instruction}
              onChange={(e) => updateOverlayRule(a.id, { instruction: e.target.value })}
            />
            <div className="ov-opts">
              <label>
                Shows on
                <select
                  value={r.occurrence ?? 'every'}
                  onChange={(e) => updateOverlayRule(a.id, { occurrence: e.target.value as OverlayOccurrence })}
                >
                  {OCCURRENCES.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </label>
              <label>
                Position
                <select
                  value={r.position}
                  onChange={(e) => updateOverlayRule(a.id, { position: e.target.value as OverlayPosition })}
                >
                  {POSITIONS.map((p) => (
                    <option key={p} value={p}>{p.replace(/_/g, ' ')}</option>
                  ))}
                </select>
              </label>
              <label>
                Size
                <select
                  value={r.sizePct ?? 100}
                  onChange={(e) => updateOverlayRule(a.id, { sizePct: Number(e.target.value) })}
                >
                  {SIZES.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </label>
              <label>
                Duration
                <input
                  type="number"
                  min={1}
                  max={8}
                  step={0.5}
                  value={r.durationSeconds}
                  onChange={(e) => updateOverlayRule(a.id, { durationSeconds: Number(e.target.value) || 3 })}
                />
              </label>
              <label>
                Animation
                <select
                  value={r.animation}
                  onChange={(e) => updateOverlayRule(a.id, { animation: e.target.value as OverlayAnimation })}
                >
                  {ANIMS.map((x) => (
                    <option key={x} value={x}>{x}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        )
      })}

      {assets.length > 0 && (
        <div className="ov-actions">
          <button
            className="ov-suggest-btn"
            disabled={job.active || !hasTranscript}
            title={hasTranscript ? 'Match each overlay by its name/instruction to the transcript and place them directly (no vision)' : 'Needs a transcript first'}
            onClick={() => { setRanOp(true); void generateOverlays() }}
          >
            ✨ Place by name
          </button>
          <button disabled={job.active} onClick={() => clearGeneratedOverlays()}>
            Clear placed
          </button>
        </div>
      )}

      {/* Feedback line: the new editor has no global status bar, so surface the
          overlay job's progress/result (and any guard message / error) here — else
          a run that finds nothing or hits "transcribe first" looks like a dead button. */}
      {ranOp && job.message && (
        <p className={`ov-status${job.active ? ' busy' : ''}`} role="status">
          {job.active ? '⏳ ' : ''}{job.message}
        </p>
      )}

      {suggestions.length > 0 && (
        <div className="ov-suggest">
          <div className="ov-suggest-head">
            <span><b>{suggestions.length}</b> suggestion{suggestions.length > 1 ? 's' : ''} — review &amp; accept</span>
            <span className="ov-suggest-bulk">
              <button className="primary small" disabled={job.active} onClick={() => acceptSuggestions()}>Accept all</button>
              <button className="small" onClick={() => clearSuggestions()}>Dismiss all</button>
            </span>
          </div>
          {suggestions.map((s) => {
            const isLabel = s.kind === 'label'
            const a = assetById(s.overlayId)
            const conf = Math.round(s.confidence * 100)
            return (
              <div key={s.id} className="ov-sugg-card">
                <button className="ov-sugg-seek" title="Preview this moment" onClick={() => seek(s.start)}>
                  {isLabel ? <span className="ov-sugg-ic">📝</span> : a?.file ? <img src={mediaSrc(a.file)} alt="" /> : <span className="ov-sugg-ic">🖼</span>}
                  <span className="ov-sugg-time">▶ {mmss(s.start)}</span>
                </button>
                <div className="ov-sugg-body">
                  <div className="ov-sugg-title">
                    <b>{isLabel ? s.label : a?.name ?? 'Overlay'}</b>
                    {isLabel && <span className="ov-sugg-tag">auto-label</span>}
                    <span className={`ov-sugg-conf ${conf >= 75 ? 'hi' : conf >= 55 ? 'mid' : 'lo'}`}>{conf}%</span>
                  </div>
                  <div className="ov-sugg-why">{s.reason || '—'}</div>
                  <div className="ov-sugg-quote">“{s.sentence}”</div>
                </div>
                <div className="ov-sugg-acts">
                  <button className="primary small" disabled={job.active} title={isLabel ? 'Place this text label' : 'Place this overlay'} onClick={() => acceptSuggestions([s.id])}>✓</button>
                  <button className="small" title="Dismiss" onClick={() => dismissSuggestion(s.id)}>✕</button>
                </div>
              </div>
            )
          })}
        </div>
      )}
      {assets.length > 0 && !hasTranscript && (
        <p className="muted small">
          No transcript yet — run {IS_CLOUD ? '✂ ProCut or 📝 Transcribe' : '⚡ FastCut, ✂ ProCut or 📝 Transcribe'} first so the AI knows when you say things.
        </p>
      )}
      {assets.length > 0 && hasTranscript && IS_CLOUD && (
        <p className="muted small">
          Overlays are matched by AI (understands paraphrases &amp; negation), with keyword matching as an offline fallback.
        </p>
      )}

      {overlayLog.length > 0 && (
        <details className="ov-log">
          <summary>Last run · {overlayLog.length} log lines</summary>
          <div className="ov-log-head">
            <button
              type="button"
              className="ov-log-copy"
              onClick={async () => {
                const text = overlayLog.join('\n')
                try {
                  await navigator.clipboard.writeText(text)
                } catch {
                  // clipboard API blocked (insecure ctx / permission) — fall back to a
                  // hidden textarea + execCommand so copy still works.
                  const ta = document.createElement('textarea')
                  ta.value = text
                  ta.style.position = 'fixed'
                  ta.style.opacity = '0'
                  document.body.appendChild(ta)
                  ta.select()
                  try { document.execCommand('copy') } catch { /* give up silently */ }
                  document.body.removeChild(ta)
                }
                setLogCopied(true)
                window.setTimeout(() => setLogCopied(false), 1500)
              }}
            >
              {logCopied ? '✓ Copied' : 'Copy log'}
            </button>
          </div>
          <pre>{overlayLog.join('\n')}</pre>
        </details>
      )}
    </div>
  )
}
