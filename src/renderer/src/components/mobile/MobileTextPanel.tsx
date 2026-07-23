// Modern mobile text editor (0.01), organised into THREE tabs so it isn't one
// bulky scroll:
//   • Text  — write the text, set its on-screen length, delete.
//   • Font  — font (+ upload your own), alignment, size, bold/italic.
//   • Style — one-tap presets + manual outline / background / shadow.
// Opening the sheet no longer auto-inserts a clip; with nothing selected the Text
// tab composes a draft and commits on "Add to timeline". Same doc-native engine
// wiring as before. Desktop keeps the original TextPanel — this file is mobile-only.

import { useEffect, useRef, useState } from 'react'
import { css } from '../../newui/css'
import { useStore } from '../../store'
import { FONT_OPTIONS } from '@shared/types'
import type { TextClip } from '@shared/types'
import { useSharedEngineSnapshot, getSharedEngine } from '../../timelineEngine'
import { findClip } from '@shared/timeline/model'
import { secondsToFrames, framesToSeconds } from '@shared/timeline/time'
import * as C from '@shared/timeline/commands'
import type { Clip as DocClip, TextContent, TimelineDocument } from '@shared/timeline/types'
import { addDocTexts } from '../../docTextClips'
import { addCustomFont, getCustomFontFamilies, getDefaultFont, setDefaultFont, onCustomFontsChange } from '../../customFonts'
import { TEXT_STYLES } from '../../textStyles'
import { Icon } from './Icon'

type Tab = 'text' | 'font' | 'style'

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
    bgOpacity: t.background.opacity,
    shadowEnabled: t.shadow?.enabled ?? false,
    shadowColor: t.shadow?.color ?? '#000000',
    shadowBlur: t.shadow?.blur ?? 0,
    shadowDx: t.shadow?.dx ?? 0,
    shadowDy: t.shadow?.dy ?? 0
  }
}

/** Map a flat TextClip patch to a document TextContent patch (nested bg/shadow). */
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
  const sh: Partial<NonNullable<TextContent['shadow']>> = {}
  if (p.shadowEnabled !== undefined) sh.enabled = p.shadowEnabled
  if (p.shadowColor !== undefined) sh.color = p.shadowColor
  if (p.shadowBlur !== undefined) sh.blur = p.shadowBlur
  if (p.shadowDx !== undefined) sh.dx = p.shadowDx
  if (p.shadowDy !== undefined) sh.dy = p.shadowDy
  if (Object.keys(sh).length) out.shadow = sh as NonNullable<TextContent['shadow']>
  return out
}

function findDocText(doc: TimelineDocument, id: string | null): DocClip | null {
  if (!id) return null
  const loc = findClip(doc, id)
  return loc && loc.clip.text ? loc.clip : null
}

/** CSS font-family value (kept out of JSX style objects — the TSX parser mishandles
 *  nested template literals inside `style={{…}}`). */
function quoteFont(fam: string): string {
  return '"' + fam + '", sans-serif'
}

const CARD = 'background:#17171b;border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:13px 14px;margin-top:12px'
const CAP = 'font-size:11.5px;font-weight:650;color:#8f8f96;letter-spacing:.3px;text-transform:uppercase;margin-bottom:2px'
const INPUT = 'background:#101014;color:#e7e7ea;border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:11px 10px;font-family:inherit;font-size:13px;box-sizing:border-box;width:100%'

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
      <span style={css('position:relative;width:36px;height:30px;border-radius:9px;overflow:hidden;border:1px solid rgba(255,255,255,.16);flex:none;background:' + value)}>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)}
          style={css('position:absolute;inset:-6px;width:160%;height:160%;border:none;padding:0;background:none;cursor:pointer')} />
      </span>
    </label>
  )
}

function GlyphToggle({ on, italic, onClick, children }: { on: boolean; italic?: boolean; onClick: () => void; children: string }): JSX.Element {
  const border = on ? 'rgba(124,92,255,.55)' : 'rgba(255,255,255,.1)'
  const bg = on ? 'rgba(124,92,255,.18)' : '#101014'
  const color = on ? '#c9b8ff' : '#c6c9d2'
  return (
    <button onClick={onClick} style={css('width:44px;height:44px;border-radius:10px;font-family:inherit;font-size:16px;font-weight:800;cursor:pointer;border:1px solid ' + border + ';background:' + bg + ';color:' + color + (italic ? ';font-style:italic' : ''))}>
      {children}
    </button>
  )
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)}
      style={{ ...css('width:18px;height:18px'), accentColor: '#8c5cff' }} />
  )
}

function Placeholder({ text }: { text: string }): JSX.Element {
  return <p style={css('color:#8f8f96;font-size:13px;line-height:1.6;margin-top:20px;text-align:center')}>{text}</p>
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
  const [tab, setTab] = useState<Tab>('text')
  const [draft, setDraft] = useState('')
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

  function addFromDraft(): void {
    const text = draft.trim() || 'Your text'
    if (!docMode) {
      addTextLegacy()
      setDraft('')
      return
    }
    // Manual text drops in the CENTER (0.5); captions own the lower third (0.85),
    // so a fresh text never lands on top of the caption line.
    addDocTexts([{ text, startS: playhead, endS: playhead + 3, y: 0.5 }], true)
    setDraft('')
    setTab('font') // straight to styling the new clip
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
    e.target.value = ''
    if (!f) return
    setBusy(true)
    try {
      const family = await addCustomFont(f)
      setDefaultFont(family)
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

  const tabs: [Tab, string][] = [['text', 'Text'], ['font', 'Font'], ['style', 'Style']]

  return (
    <div style={css('flex:1;min-height:0;display:flex;flex-direction:column')}>
      <input ref={fileRef} type="file" accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2" onChange={onFontFile} style={{ display: 'none' }} />

      {/* Tab bar */}
      <div style={css('flex:none;display:flex;gap:6px;padding:6px;margin:2px 16px 4px;background:#101014;border:1px solid rgba(255,255,255,.07);border-radius:12px')}>
        {tabs.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            style={css('flex:1;border:none;border-radius:9px;padding:9px 0;font-family:inherit;font-size:13px;font-weight:650;cursor:pointer;' + (tab === id ? 'background:linear-gradient(100deg,#7c5cff,#a468ff);color:#fff' : 'background:transparent;color:#b9b9c0'))}>
            {label}
          </button>
        ))}
      </div>

      <div style={css('flex:1;min-height:0;overflow:auto;padding:2px 16px 26px')}>
        {/* ---- TEXT ---- */}
        {tab === 'text' && (
          clip ? (
            <>
              <textarea value={clip.text} onChange={(e) => set({ text: e.target.value })} spellCheck={false} rows={3}
                placeholder="Type your text…"
                style={css('width:100%;margin-top:8px;background:#101014;color:#fff;border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:12px;font-family:inherit;font-size:16px;line-height:1.4;resize:none;box-sizing:border-box')} />
              <div style={css(CARD)}>
                <Slider label="Length on screen" value={Math.max(0.3, clip.end - clip.start)} min={0.3} max={30} step={0.1}
                  fmt={(v) => v.toFixed(1) + 's'} onChange={(v) => set({ end: clip.start + v })} />
              </div>
              <button onClick={del} style={css('width:100%;margin-top:14px;background:rgba(255,90,90,.12);border:1px solid rgba(255,90,90,.3);color:#ff9a9a;font-family:inherit;font-size:13.5px;font-weight:600;border-radius:12px;padding:12px 0;cursor:pointer')}>
                Delete text
              </button>
            </>
          ) : (
            <>
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} rows={3} autoFocus
                placeholder="Type your text…"
                style={css('width:100%;margin-top:8px;background:#101014;color:#fff;border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:12px;font-family:inherit;font-size:16px;line-height:1.4;resize:none;box-sizing:border-box')} />
              <button onClick={addFromDraft} disabled={!hasMedia}
                style={css('width:100%;margin-top:14px;display:flex;align-items:center;justify-content:center;gap:7px;background:linear-gradient(100deg,#7c5cff,#a468ff);border:none;color:#fff;font-family:inherit;font-size:14px;font-weight:700;border-radius:12px;padding:13px 0;box-shadow:0 5px 16px rgba(140,92,255,.3);cursor:pointer;opacity:' + (hasMedia ? '1' : '0.5'))}>
                <Icon name="plus" size={17} /> Add to timeline
              </button>
              <Placeholder text="Write your text, then tap Add. You can restyle it in the Font and Style tabs." />
            </>
          )
        )}

        {/* ---- FONT ---- */}
        {tab === 'font' && (
          !clip ? <Placeholder text="Add a text on the Text tab first, then style its font here." /> : (
            <>
              <div style={css(CARD)}>
                <div style={css(CAP)}>Font</div>
                <div style={css('display:flex;gap:8px;align-items:center;margin-top:9px')}>
                  <select value={clip.fontFamily} onChange={(e) => set({ fontFamily: e.target.value })} style={{ ...selectStyle, fontFamily: quoteFont(clip.fontFamily) }}>
                    {fontList.map((f) => <option key={f} value={f} style={{ fontFamily: quoteFont(f) }}>{f}</option>)}
                  </select>
                  <button onClick={() => fileRef.current?.click()} disabled={busy} title="Upload a font"
                    style={css('flex:none;display:flex;align-items:center;gap:6px;background:rgba(124,92,255,.16);border:1px solid rgba(124,92,255,.34);color:#c9b8ff;font-family:inherit;font-size:12.5px;font-weight:650;border-radius:10px;padding:11px 12px;cursor:pointer;opacity:' + (busy ? '0.6' : '1'))}>
                    <Icon name="import" size={16} /> {busy ? '…' : 'Font'}
                  </button>
                </div>
                <label style={css('display:flex;align-items:center;gap:9px;margin-top:11px;cursor:pointer')}>
                  <Toggle on={isDefaultFont} onChange={(v) => { if (v) setDefaultFont(clip.fontFamily) }} />
                  <span style={css('font-size:12.5px;color:#c6c9d2')}>Use this font as the default for new text and captions</span>
                </label>
              </div>

              <div style={css(CARD)}>
                <div style={css(CAP)}>Alignment</div>
                <div style={css('display:flex;gap:6px;background:#101014;border:1px solid rgba(255,255,255,.07);border-radius:11px;padding:4px;margin-top:9px')}>
                  {(['left', 'center', 'right'] as const).map((a) => (
                    <button key={a} onClick={() => set({ align: a })}
                      style={css('flex:1;border:none;border-radius:8px;padding:9px 0;font-family:inherit;font-size:12.5px;font-weight:600;text-transform:capitalize;cursor:pointer;' + (clip.align === a ? 'background:linear-gradient(100deg,#7c5cff,#a468ff);color:#fff' : 'background:transparent;color:#b9b9c0'))}>{a}</button>
                  ))}
                </div>
                <Slider label="Size" value={Math.round(clip.fontSize * 300)} min={6} max={180} step={1}
                  fmt={(v) => String(v)} onChange={(v) => set({ fontSize: Math.max(0.02, Math.min(0.6, v / 300)) })} />
                <div style={css('display:flex;gap:8px;margin-top:14px')}>
                  <GlyphToggle on={clip.bold} onClick={() => set({ bold: !clip.bold })}>B</GlyphToggle>
                  <GlyphToggle on={clip.italic} italic onClick={() => set({ italic: !clip.italic })}>I</GlyphToggle>
                </div>
              </div>
            </>
          )
        )}

        {/* ---- STYLE ---- */}
        {tab === 'style' && (
          !clip ? <Placeholder text="Add a text on the Text tab first, then pick a style here." /> : (
            <>
              <div style={css(CARD)}>
                <div style={css(CAP)}>Presets</div>
                <div style={css('display:flex;flex-wrap:wrap;gap:8px;margin-top:10px')}>
                  {TEXT_STYLES.map((s) => (
                    <button key={s.id} onClick={() => set(s.patch)}
                      style={css('flex:1;min-width:82px;border:1px solid rgba(255,255,255,.1);background:#101014;border-radius:10px;padding:10px 6px;cursor:pointer')}>
                      <div style={css('height:26px;display:grid;place-items:center;margin-bottom:6px;border-radius:6px;background:' + (s.id === 'boxed' ? '#000' : 'transparent'))}>
                        <span style={css('font-size:14px;font-weight:800;color:' + (s.id === 'yellow' ? '#ffe14d' : '#fff') + (s.id === 'outline' || s.id === 'pop' || s.id === 'yellow' ? ';-webkit-text-stroke:1px #000' : '') + (s.id === 'shadow' || s.id === 'pop' ? ';text-shadow:0 2px 3px rgba(0,0,0,.85)' : '') + (s.id === 'boxed' ? ';background:#000;padding:0 6px;border-radius:3px' : ''))}>Aa</span>
                      </div>
                      <div style={css('font-size:11.5px;font-weight:600;color:#c6c9d2;text-align:center')}>{s.label}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div style={css(CARD)}>
                <div style={css('display:flex;gap:16px')}>
                  <ColorField label="Text colour" value={clip.color} onChange={(v) => set({ color: v })} />
                </div>
              </div>

              <div style={css(CARD)}>
                <div style={css(CAP)}>Outline</div>
                <Slider label="Thickness" value={Math.round(clip.strokeWidth * 100)} min={0} max={25} step={1}
                  fmt={(v) => String(v)} onChange={(v) => set({ strokeWidth: v / 100 })} />
                <div style={css('display:flex;gap:16px;margin-top:14px')}>
                  <ColorField label="Colour" value={clip.strokeColor} onChange={(v) => set({ strokeColor: v })} />
                </div>
              </div>

              <div style={css(CARD)}>
                <label style={css('display:flex;align-items:center;justify-content:space-between;cursor:pointer')}>
                  <span style={css('font-size:13px;font-weight:600;color:#e7e7ea')}>Background</span>
                  <Toggle on={clip.bgEnabled} onChange={(v) => set({ bgEnabled: v })} />
                </label>
                {clip.bgEnabled && (
                  <>
                    <div style={css('display:flex;gap:16px;margin-top:13px')}>
                      <ColorField label="Colour" value={clip.bgColor} onChange={(v) => set({ bgColor: v })} />
                    </div>
                    <Slider label="Opacity" value={Math.round(clip.bgOpacity * 100)} min={0} max={100} step={5}
                      fmt={(v) => v + '%'} onChange={(v) => set({ bgOpacity: v / 100 })} />
                    <Slider label="Radius" value={Math.round(clip.bgRadius * 100)} min={0} max={120} step={5}
                      fmt={(v) => String(v)} onChange={(v) => set({ bgRadius: v / 100 })} />
                    <Slider label="Padding" value={Math.round(clip.bgPadding * 100)} min={0} max={120} step={5}
                      fmt={(v) => String(v)} onChange={(v) => set({ bgPadding: v / 100 })} />
                  </>
                )}
              </div>

              <div style={css(CARD)}>
                <label style={css('display:flex;align-items:center;justify-content:space-between;cursor:pointer')}>
                  <span style={css('font-size:13px;font-weight:600;color:#e7e7ea')}>Shadow</span>
                  <Toggle on={!!clip.shadowEnabled} onChange={(v) => set({ shadowEnabled: v })} />
                </label>
                {clip.shadowEnabled && (
                  <>
                    <div style={css('display:flex;gap:16px;margin-top:13px')}>
                      <ColorField label="Colour" value={clip.shadowColor || '#000000'} onChange={(v) => set({ shadowColor: v })} />
                    </div>
                    <Slider label="Blur" value={Math.round((clip.shadowBlur ?? 0) * 100)} min={0} max={40} step={1}
                      fmt={(v) => String(v)} onChange={(v) => set({ shadowBlur: v / 100 })} />
                    <Slider label="Offset X" value={Math.round((clip.shadowDx ?? 0) * 100)} min={-20} max={20} step={1}
                      fmt={(v) => String(v)} onChange={(v) => set({ shadowDx: v / 100 })} />
                    <Slider label="Offset Y" value={Math.round((clip.shadowDy ?? 0) * 100)} min={-20} max={20} step={1}
                      fmt={(v) => String(v)} onChange={(v) => set({ shadowDy: v / 100 })} />
                  </>
                )}
              </div>
            </>
          )
        )}
      </div>
    </div>
  )
}
