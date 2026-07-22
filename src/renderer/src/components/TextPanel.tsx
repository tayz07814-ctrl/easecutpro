import { useStore } from '../store'
import { FONT_OPTIONS } from '@shared/types'
import type { TextClip } from '@shared/types'
import { useSharedEngineSnapshot, getSharedEngine } from '../timelineEngine'
import { createClip, findClip } from '@shared/timeline/model'
import { secondsToFrames, framesToSeconds } from '@shared/timeline/time'
import * as C from '@shared/timeline/commands'
import type { Clip as DocClip, TextContent, TimelineDocument } from '@shared/timeline/types'

/** A default styled caption (matches the legacy Add-text defaults). */
function defaultTextContent(): TextContent {
  return {
    text: 'Your text',
    fontFamily: 'Arial Black',
    fontSize: 0.08,
    color: '#ffffff',
    align: 'center',
    bold: true,
    italic: false,
    underline: false,
    strokeWidth: 0.06,
    strokeColor: '#000000',
    background: { enabled: false, color: '#000000', opacity: 0.6, radius: 0.3, padding: 0.3 },
    shadow: { enabled: false, color: '#000000', blur: 0, dx: 0, dy: 0 },
    letterSpacing: 0,
    lineHeight: 1.2
  }
}

/** Flatten a document text clip to the legacy TextClip shape the UI edits. */
function docClipToFlat(c: DocClip, tb: TimelineDocument['timebase']): TextClip | null {
  const t = c.text
  if (!t) return null
  return {
    id: c.id,
    text: t.text,
    start: framesToSeconds(c.start, tb),
    end: framesToSeconds(c.end, tb),
    x: 0.5 + c.transform.x.static,
    y: 0.5 + c.transform.y.static,
    fontFamily: t.fontFamily,
    fontSize: t.fontSize,
    color: t.color,
    align: t.align,
    bold: t.bold,
    italic: t.italic,
    strokeWidth: t.strokeWidth,
    strokeColor: t.strokeColor,
    bgEnabled: t.background.enabled,
    bgColor: t.background.color,
    bgRadius: t.background.radius,
    bgPadding: t.background.padding,
    bgOpacity: t.background.opacity
  }
}

/** Map a flat TextClip patch to a document TextContent patch (nested bg). */
function toContentPatch(p: Partial<TextClip>): Partial<TextContent> {
  const out: Partial<TextContent> = {}
  if (p.text !== undefined) out.text = p.text
  if (p.fontFamily !== undefined) out.fontFamily = p.fontFamily
  if (p.fontSize !== undefined) out.fontSize = p.fontSize
  if (p.color !== undefined) out.color = p.color
  if (p.align !== undefined) out.align = p.align
  if (p.bold !== undefined) out.bold = p.bold
  if (p.italic !== undefined) out.italic = p.italic
  if (p.strokeWidth !== undefined) out.strokeWidth = p.strokeWidth
  if (p.strokeColor !== undefined) out.strokeColor = p.strokeColor
  const bg: Partial<TextContent['background']> = {}
  if (p.bgEnabled !== undefined) bg.enabled = p.bgEnabled
  if (p.bgColor !== undefined) bg.color = p.bgColor
  if (p.bgOpacity !== undefined) bg.opacity = p.bgOpacity
  if (p.bgRadius !== undefined) bg.radius = p.bgRadius
  if (p.bgPadding !== undefined) bg.padding = p.bgPadding
  if (Object.keys(bg).length) out.background = bg as TextContent['background']
  return out
}

function findDocText(doc: TimelineDocument, id: string | null): DocClip | null {
  if (!id) return null
  const loc = findClip(doc, id)
  return loc && loc.clip.text ? loc.clip : null
}

export default function TextPanel(): JSX.Element {
  const project = useStore((s) => s.project)
  const playhead = useStore((s) => s.project.playhead)
  const addTextLegacy = useStore((s) => s.addText)
  const updateTextLegacy = useStore((s) => s.updateText)
  const removeTextLegacy = useStore((s) => s.removeText)
  const selectedTextId = useStore((s) => s.selectedTextId)
  const snap = useSharedEngineSnapshot()
  const docMode = !!project.timeline && !!snap?.doc
  const hasMedia = !!project.media || ((project.baseSequence?.length ?? 0) > 0) || docMode

  const docSel = docMode ? snap!.interaction.selection[0] ?? null : null
  const docClip = docMode ? findDocText(snap!.doc, docSel) : null
  const clip: TextClip | null = docMode
    ? docClip
      ? docClipToFlat(docClip, snap!.doc.timebase)
      : null
    : (project.texts ?? []).find((t) => t.id === selectedTextId) ?? null

  function addText(): void {
    if (!docMode) {
      addTextLegacy()
      return
    }
    const engine = getSharedEngine()
    if (!engine) return
    const doc = engine.document
    const tb = doc.timebase
    // Reuse an existing text lane, else spawn one at the top.
    const existing = doc.tracks.find((t) => t.kind === 'text' && !t.isMain)
    const cmds = []
    let trackId: string
    if (existing) {
      trackId = existing.id
    } else {
      const order = Math.min(0, ...doc.tracks.map((t) => t.order)) - 1
      trackId = `txt-${Date.now().toString(36)}`
      cmds.push(C.addTrack('text', { id: trackId, order }))
    }
    const start = secondsToFrames(playhead, tb)
    const clipObj = createClip({
      kind: 'text',
      trackId,
      start,
      duration: secondsToFrames(3, tb),
      name: 'Text',
      text: defaultTextContent()
    })
    clipObj.transform = { ...clipObj.transform, y: { static: 0.3 } } // lower third
    cmds.push(C.addClip(clipObj))
    engine.batch('Add text', cmds)
    engine.select([clipObj.id])
  }

  const set = (patch: Partial<TextClip>): void => {
    if (!clip) return
    if (docMode && docClip) {
      const engine = getSharedEngine()
      if (!engine) return
      const content = toContentPatch(patch)
      if (Object.keys(content).length) engine.dispatch(C.setClipText(docClip.id, content))
      if (patch.x !== undefined || patch.y !== undefined) {
        engine.dispatch(
          C.setClipTransform(docClip.id, {
            x: patch.x !== undefined ? patch.x - 0.5 : undefined,
            y: patch.y !== undefined ? patch.y - 0.5 : undefined
          })
        )
      }
      if (patch.start !== undefined) engine.dispatch(C.moveClip(docClip.id, docClip.trackId, secondsToFrames(patch.start, snap!.doc.timebase)))
      if (patch.end !== undefined) engine.dispatch(C.trimClipOut(docClip.id, secondsToFrames(patch.end, snap!.doc.timebase)))
      return
    }
    updateTextLegacy(clip.id, patch)
  }

  const del = (): void => {
    if (!clip) return
    if (docMode) getSharedEngine()?.deleteSelection(false)
    else removeTextLegacy(clip.id)
  }

  return (
    <div className="tool-content">
      <div className="row" style={{ marginBottom: 10 }}>
        <button className="primary" onClick={addText} disabled={!hasMedia}>＋ Add text</button>
        {clip && <button className="danger" onClick={del}>🗑 Delete</button>}
      </div>

      {!clip ? (
        <p className="muted small">
          Add a text overlay, then position it by dragging in the preview. Select a text block
          (here or on the timeline) to edit it.
        </p>
      ) : (
        <>
          <textarea
            className="filler-input"
            rows={2}
            value={clip.text}
            onChange={(e) => set({ text: e.target.value })}
            spellCheck={false}
          />

          <div className="row" style={{ gap: 6, marginBottom: 8 }}>
            <select value={clip.fontFamily} onChange={(e) => set({ fontFamily: e.target.value })} style={{ flex: 1 }}>
              {FONT_OPTIONS.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
            <button className={'mini' + (clip.bold ? ' on toggle' : '')} onClick={() => set({ bold: !clip.bold })}>B</button>
            <button className={'mini' + (clip.italic ? ' on toggle' : '')} onClick={() => set({ italic: !clip.italic })}><i>I</i></button>
          </div>

          <div className="slider-grid">
            <label className="slider-row">
              <span className="slabel">Size</span>
              {/* Familiar point-like size numbers (default ~24) instead of a % of
                  the frame, which read as an unrecognizable "universal" size. */}
              <input type="range" min={6} max={180} step={1}
                value={Math.round(clip.fontSize * 300)}
                onChange={(e) => set({ fontSize: Math.max(0.02, Math.min(0.6, Number(e.target.value) / 300)) })} />
              <span className="val">{Math.round(clip.fontSize * 300)}</span>
            </label>
          </div>
          <div className="field-grid">
            <label>Color<input type="color" value={clip.color} onChange={(e) => set({ color: e.target.value })} /></label>
          </div>
          <div className="row" style={{ gap: 6, margin: '6px 0' }}>
            {(['left', 'center', 'right'] as const).map((a) => (
              <button key={a} className={'mini' + (clip.align === a ? ' on toggle' : '')} onClick={() => set({ align: a })}>{a}</button>
            ))}
          </div>

          <h4>Outline</h4>
          <div className="field-grid">
            <label>Thickness<input type="range" min={0} max={25} step={1}
              value={Math.round(clip.strokeWidth * 100)} onChange={(e) => set({ strokeWidth: Number(e.target.value) / 100 })} /></label>
            <label>Color<input type="color" value={clip.strokeColor} onChange={(e) => set({ strokeColor: e.target.value })} /></label>
          </div>

          <h4>
            <label className="inline-check">
              <input type="checkbox" checked={clip.bgEnabled} onChange={(e) => set({ bgEnabled: e.target.checked })} /> Background
            </label>
          </h4>
          {clip.bgEnabled && (
            <div className="field-grid">
              <label>Color<input type="color" value={clip.bgColor} onChange={(e) => set({ bgColor: e.target.value })} /></label>
              <label>Opacity<input type="range" min={0} max={100} step={5}
                value={Math.round(clip.bgOpacity * 100)} onChange={(e) => set({ bgOpacity: Number(e.target.value) / 100 })} /></label>
              <label>Radius<input type="range" min={0} max={120} step={5}
                value={Math.round(clip.bgRadius * 100)} onChange={(e) => set({ bgRadius: Number(e.target.value) / 100 })} /></label>
              <label>Padding<input type="range" min={0} max={120} step={5}
                value={Math.round(clip.bgPadding * 100)} onChange={(e) => set({ bgPadding: Number(e.target.value) / 100 })} /></label>
            </div>
          )}

          <h4>Timing</h4>
          <div className="field-grid">
            <label>Start<input type="number" min={0} step={0.1} value={clip.start.toFixed(1)}
              onChange={(e) => set({ start: Math.max(0, Number(e.target.value)) })} />s</label>
            <label>End<input type="number" min={0} step={0.1} value={clip.end.toFixed(1)}
              onChange={(e) => set({ end: Math.max(clip.start + 0.2, Number(e.target.value)) })} />s</label>
          </div>
        </>
      )}
    </div>
  )
}
