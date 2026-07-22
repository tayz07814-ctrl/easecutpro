// Modern mobile text editor (0.01) — the new-UI replacement for the desktop
// TextPanel inside the phone "Text" sheet. Same engine wiring (doc-native text
// clips via the shared timeline), restyled to match the other bottom sheets
// (dark cards, purple accents). Adds: upload-your-own-font (→ becomes the default
// text font) and a segmented alignment control. Desktop keeps the original
// TextPanel — this file is mobile-only.

import { useEffect, useRef, useState } from 'react'
import { css } from '../../newui/css'
import { useStore } from '../../store'
import { FONT_OPTIONS } from '@shared/types'
import type { TextClip } from '@shared/types'
import { useSharedEngineSnapshot, getSharedEngine } from '../../timelineEngine'
import { createClip, findClip } from '@shared/timeline/model'
import { secondsToFrames, framesToSeconds } from '@shared/timeline/time'
import * as C from '@shared/timeline/commands'
import type { Clip as DocClip, TextContent, TimelineDocument } from '@shared/timeline/types'
import { defaultTextContent } from '../../docTextClips'
import { addCustomFont, getCustomFontFamilies, getDefaultFont, setDefaultFont, onCustomFontsChange } from '../../customFonts'
import { Icon } from './Icon'

/** Flatten a document text clip to the flat TextClip shape the UI edits. */
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

/** CSS font-family value for a family name (kept out of JSX to avoid nested
 *  template literals inside style objects, which the TSX parser mishandles). */
function quoteFont(fam: string): string {
  return '"' + fam + '", sans-serif'
}

/** Square B / I toggle button. */
function GlyphToggle({ on, italic, onClick, children }: { on: boolean; italic?: boolean; onClick: () => void; children: string }): JSX.Element {
  const border = on ? 'rgba(124,92,255,.55)' : 'rgba(255,255,255,.1)'
  const bg = on ? 'rgba(124,92,255,.18)' : '#101014'
  const color = on ? '#c9b8ff' : '#c6c9d2'
  return (
    <button onClick={onClick} style={css('width:40px;height:40px;border-radius:10px;font-family:inherit;font-size:16px;font-weight:800;cursor:pointer;border:1px solid ' + border + ';background:' + bg + ';color:' + color + (italic ? ';font-style:italic' : ''))}>
      {children}
    </button>
  )
}

const CARD = 'background:#17171b;border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:13px 14px;margin-top:12px'
const CAP = 'font-size:11.5px;font-weight:650;color:#8f8f96;letter-spacing:.3px;text-transform:uppercase;margin-bottom:2px'

function Slider({ label, value, min, max, step, fmt, onChange }: {
  label: string; value: number; min: number; max: number; step: number
  fmt: (v: number) => string; onChange: (v: number) => void
}): JSX.Element {
  return (
    <div style={css('margin-top:12px')}>
      <div style={css('display:flex;justify-content:space-between;align-items:center;margin-bottom:8px')}>
        <span style={css('font-size:12.5px;color:#c6c9d2')}>{label}</span>
        <span style={css("font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:#8f8f96")}>{fmt(value)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ ...css('width:100%;height:22px'), accentColor: '#8c5cff' }} />
    </div>
  )
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }): JSX.Element {
  return (
    <label style={css('display:flex;align-items:center;justify-content:space-between;gap:10px;flex:1;cursor:pointer')}>
      <span style={css('font-size:12.5px;color:#c6c9d2')}>{label}</span>
      <span style={css(`position:relative;width:36px;height:30px;border-radius:9px;overflow:hidden;border:1px solid rgba(255,255,255,.16);background:${value};flex:none`)}>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)}
          style={css('position:absolute;inset:-6px;width:160%;height:160%;border:none;padding:0;background:none;cursor:pointer')} />
      </span>
    </label>
  )
}

export default function MobileTextPanel(): JSX.Element {
  const project = useStore((s) => s.project)
  const playhead = useStore((s) => s.project.playhead)
  const addTextLegacy = useStore((s) => s.addText)
  const updateTextLegacy = useStore((s) => s.updateText)
  const removeTextLegacy = useStore((s) => s.removeText)
  const selectedTextId = useStore((s) => s.selectedTextId)
  const snap = useSharedEngineSnapshot()
  const fileRef = useRef<HTMLInputElement>(null)
  const [, force] = useState(0)
  const [busy, setBusy] = useState(false)
  // Re-render when the custom-font list / default changes.
  useEffect(() => onCustomFontsChange(() => force((n) => n + 1)), [])

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
    const clipObj = createClip({
      kind: 'text',
      trackId,
      start: secondsToFrames(playhead, tb),
      duration: secondsToFrames(3, tb),
      name: 'Text',
      text: defaultTextContent()
    })
    clipObj.transform = { ...clipObj.transform, y: { static: 0.3 } }
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

  async function onFontFile(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const f = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!f) return
    setBusy(true)
    try {
      const family = await addCustomFont(f)
      setDefaultFont(family) // uploading a font makes it the default text font
      if (clip) set({ fontFamily: family })
    } catch {
      /* bad font — ignore quietly */
    } finally {
      setBusy(false)
    }
  }

  const customFonts = getCustomFontFamilies()
  const defaultFont = getDefaultFont()
  const fontList = Array.from(new Set([...FONT_OPTIONS, ...customFonts, clip?.fontFamily].filter(Boolean))) as string[]
  const isDefaultFont = !!clip && clip.fontFamily === defaultFont

  const selectStyle = css('flex:1;min-width:0;background:#101014;color:#e7e7ea;border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:11px 10px;font-family:inherit;font-size:13px;-webkit-appearance:none;appearance:none')

  return (
    <div style={css('flex:1;min-height:0;overflow:auto;padding:2px 16px 26px')}>
      <input ref={fileRef} type="file" accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2" onChange={onFontFile} style={{ display: 'none' }} />

      <div style={css('display:flex;gap:8px;margin-top:4px')}>
        <button onClick={addText} disabled={!hasMedia}
          style={css(`flex:1;display:flex;align-items:center;justify-content:center;gap:7px;background:linear-gradient(100deg,#7c5cff,#a468ff);border:none;color:#fff;font-family:inherit;font-size:13.5px;font-weight:700;border-radius:12px;padding:12px 0;box-shadow:0 5px 16px rgba(140,92,255,.3);opacity:${hasMedia ? 1 : 0.5};cursor:${hasMedia ? 'pointer' : 'default'}`)}>
          <Icon name="text" size={17} /> Add text
        </button>
        {clip && (
          <button onClick={del} style={css('flex:none;background:rgba(255,90,90,.12);border:1px solid rgba(255,90,90,.3);color:#ff9a9a;font-family:inherit;font-size:13px;font-weight:600;border-radius:12px;padding:0 16px;cursor:pointer')}>
            <Icon name="trash" size={17} />
          </button>
        )}
      </div>

      {!clip ? (
        <p style={css('color:#8f8f96;font-size:13px;line-height:1.6;margin-top:16px')}>
          Add a text overlay, then drag it in the preview to position it. Select a text block (here or on the timeline) to edit it.
        </p>
      ) : (
        <>
          <textarea
            value={clip.text}
            onChange={(e) => set({ text: e.target.value })}
            spellCheck={false}
            rows={2}
            placeholder="Type your text…"
            style={css('width:100%;margin-top:14px;background:#101014;color:#fff;border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:12px;font-family:inherit;font-size:15px;line-height:1.4;resize:none;box-sizing:border-box')}
          />

          {/* Font */}
          <div style={css(CARD)}>
            <div style={css(CAP)}>Font</div>
            <div style={css('display:flex;gap:8px;align-items:center;margin-top:9px')}>
              <select value={clip.fontFamily} onChange={(e) => set({ fontFamily: e.target.value })} style={{ ...selectStyle, fontFamily: quoteFont(clip.fontFamily) }}>
                {fontList.map((f) => <option key={f} value={f} style={{ fontFamily: quoteFont(f) }}>{f}</option>)}
              </select>
              <button onClick={() => fileRef.current?.click()} disabled={busy} title="Upload a font"
                style={css(`flex:none;display:flex;align-items:center;gap:6px;background:rgba(124,92,255,.16);border:1px solid rgba(124,92,255,.34);color:#c9b8ff;font-family:inherit;font-size:12.5px;font-weight:650;border-radius:10px;padding:11px 12px;cursor:${busy ? 'default' : 'pointer'};opacity:${busy ? 0.6 : 1}`)}>
                <Icon name="import" size={16} /> {busy ? '…' : 'Font'}
              </button>
              <div style={css('display:flex;gap:6px')}>
                <GlyphToggle on={clip.bold} onClick={() => set({ bold: !clip.bold })}>B</GlyphToggle>
                <GlyphToggle on={clip.italic} italic onClick={() => set({ italic: !clip.italic })}>I</GlyphToggle>
              </div>
            </div>
            <label style={css('display:flex;align-items:center;gap:9px;margin-top:11px;cursor:pointer')}>
              <input type="checkbox" checked={isDefaultFont}
                onChange={(e) => { if (e.target.checked) setDefaultFont(clip.fontFamily) }}
                style={{ ...css('width:17px;height:17px'), accentColor: '#8c5cff' }} />
              <span style={css('font-size:12.5px;color:#c6c9d2')}>Use this font as the default for new text and captions</span>
            </label>
          </div>

          {/* Alignment + size */}
          <div style={css(CARD)}>
            <div style={css(CAP)}>Style</div>
            <div style={css('display:flex;gap:6px;background:#101014;border:1px solid rgba(255,255,255,.07);border-radius:11px;padding:4px;margin-top:9px')}>
              {(['left', 'center', 'right'] as const).map((a) => (
                <button key={a} onClick={() => set({ align: a })}
                  style={css(`flex:1;border:none;border-radius:8px;padding:9px 0;font-family:inherit;font-size:12.5px;font-weight:600;text-transform:capitalize;cursor:pointer;background:${clip.align === a ? 'linear-gradient(100deg,#7c5cff,#a468ff)' : 'transparent'};color:${clip.align === a ? '#fff' : '#b9b9c0'}`)}>{a}</button>
              ))}
            </div>
            <Slider label="Size" value={Math.round(clip.fontSize * 300)} min={6} max={180} step={1}
              fmt={(v) => `${v}`} onChange={(v) => set({ fontSize: Math.max(0.02, Math.min(0.6, v / 300)) })} />
            <div style={css('display:flex;gap:16px;margin-top:14px')}>
              <ColorField label="Text" value={clip.color} onChange={(v) => set({ color: v })} />
            </div>
          </div>

          {/* Outline */}
          <div style={css(CARD)}>
            <div style={css(CAP)}>Outline</div>
            <Slider label="Thickness" value={Math.round(clip.strokeWidth * 100)} min={0} max={25} step={1}
              fmt={(v) => `${v}`} onChange={(v) => set({ strokeWidth: v / 100 })} />
            <div style={css('display:flex;gap:16px;margin-top:14px')}>
              <ColorField label="Colour" value={clip.strokeColor} onChange={(v) => set({ strokeColor: v })} />
            </div>
          </div>

          {/* Background */}
          <div style={css(CARD)}>
            <label style={css('display:flex;align-items:center;justify-content:space-between;cursor:pointer')}>
              <span style={css('font-size:13px;font-weight:600;color:#e7e7ea')}>Background</span>
              <input type="checkbox" checked={clip.bgEnabled} onChange={(e) => set({ bgEnabled: e.target.checked })}
                style={{ ...css('width:18px;height:18px'), accentColor: '#8c5cff' }} />
            </label>
            {clip.bgEnabled && (
              <>
                <div style={css('display:flex;gap:16px;margin-top:13px')}>
                  <ColorField label="Colour" value={clip.bgColor} onChange={(v) => set({ bgColor: v })} />
                </div>
                <Slider label="Opacity" value={Math.round(clip.bgOpacity * 100)} min={0} max={100} step={5}
                  fmt={(v) => `${v}%`} onChange={(v) => set({ bgOpacity: v / 100 })} />
                <Slider label="Radius" value={Math.round(clip.bgRadius * 100)} min={0} max={120} step={5}
                  fmt={(v) => `${v}`} onChange={(v) => set({ bgRadius: v / 100 })} />
                <Slider label="Padding" value={Math.round(clip.bgPadding * 100)} min={0} max={120} step={5}
                  fmt={(v) => `${v}`} onChange={(v) => set({ bgPadding: v / 100 })} />
              </>
            )}
          </div>

          {/* Timing */}
          <div style={css(CARD)}>
            <div style={css(CAP)}>Timing</div>
            <div style={css('display:flex;gap:12px;margin-top:10px')}>
              <label style={css('flex:1;display:flex;flex-direction:column;gap:6px')}>
                <span style={css('font-size:12px;color:#8f8f96')}>Start (s)</span>
                <input type="number" min={0} step={0.1} value={clip.start.toFixed(1)}
                  onChange={(e) => set({ start: Math.max(0, Number(e.target.value)) })}
                  style={css('background:#101014;color:#e7e7ea;border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:10px;font-family:inherit;font-size:13px;box-sizing:border-box;width:100%')} />
              </label>
              <label style={css('flex:1;display:flex;flex-direction:column;gap:6px')}>
                <span style={css('font-size:12px;color:#8f8f96')}>End (s)</span>
                <input type="number" min={0} step={0.1} value={clip.end.toFixed(1)}
                  onChange={(e) => set({ end: Math.max(clip.start + 0.2, Number(e.target.value)) })}
                  style={css('background:#101014;color:#e7e7ea;border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:10px;font-family:inherit;font-size:13px;box-sizing:border-box;width:100%')} />
              </label>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
