// Compact Smart Silence settings — the standalone Smart Silence Cleaner controls
// (mode cards + 3 creator sliders + 3 toggles + collapsed Advanced + a live SVG
// preview/stats) folded into a right-panel-sized modal. It EDITS the store's
// persisted `smartSilenceSettings` live, so "Find Silences" (runSmartSilence) uses
// the chosen values and re-running reflects any change. Reuses the existing
// smartSilence/ui components verbatim — no second engine, no changed numbers.
//
// Opened from SpeechCleanerPanel ("Smart Silence settings"). Mounted next to the
// existing SilenceSettingsModal in Editor / MobileEditor.

import { useMemo, useState } from 'react'
import { css } from '../css'
import { useStore } from '../../store'
import type { SilenceSettings, Word } from '../../smartSilence/types'
import { planSilence } from '../../smartSilence/engine'
import { allPresets, getPreset } from '../../smartSilence/presets'
import {
  applyBreathSlider,
  applyPauseSlider,
  applySpeedSlider,
  copySettings,
  toSliders
} from '../../smartSilence/settings'
import { sampleWords, SAMPLE_DURATION_MS } from '../../smartSilence/sampleData'
import { SCOPED_CSS, T } from '../../smartSilence/ui/theme'
import { ModeCard } from '../../smartSilence/ui/ModeCard'
import { CreatorSlider } from '../../smartSilence/ui/CreatorSlider'
import { ToggleRow } from '../../smartSilence/ui/ToggleRow'
import { AdvancedPanel } from '../../smartSilence/ui/AdvancedPanel'
import { TimelinePreview } from '../../smartSilence/ui/TimelinePreview'
import { StatsPanel } from '../../smartSilence/ui/StatsPanel'

type ParamKey =
  | 'minGapMs'
  | 'targetPauseMs'
  | 'sentencePauseMs'
  | 'commaPauseMs'
  | 'mergeGapMs'
  | 'padBeforeMs'
  | 'padAfterMs'

/** Which preset (if any) the current settings exactly match — else 'custom'. */
function detectPreset(s: SilenceSettings): string {
  for (const p of allPresets()) {
    if (p.id === 'custom') continue
    const ps = p.settings
    if (
      ps.minGapMs === s.minGapMs &&
      ps.targetPauseMs === s.targetPauseMs &&
      ps.sentencePauseMs === s.sentencePauseMs &&
      ps.commaPauseMs === s.commaPauseMs &&
      ps.mergeGapMs === s.mergeGapMs &&
      ps.padBeforeMs === s.padBeforeMs &&
      ps.padAfterMs === s.padAfterMs &&
      ps.keepSentenceFlow === s.keepSentenceFlow &&
      ps.removeFillers === s.removeFillers &&
      ps.smartSilence === s.smartSilence
    ) {
      return p.id
    }
  }
  return 'custom'
}

export default function SmartSilenceSettingsModal(): JSX.Element | null {
  const show = useStore((s) => s.showSmartSilenceSettings)
  // Fresh mount per open (below) keeps the slider thumbs + active card in sync with
  // the persisted store settings each time it's opened.
  return show ? <Inner /> : null
}

function Inner(): JSX.Element {
  const close = useStore((s) => s.setShowSmartSilenceSettings)
  const settings = useStore((s) => s.smartSilenceSettings) // source of truth (persisted)
  const setStore = useStore((s) => s.setSmartSilenceSettings)
  const transcript = useStore((s) => s.project.transcript)

  // UI-only state — the actual values live in the store (committed on every change).
  const [sliders, setSliders] = useState<[number, number, number]>(() => toSliders(settings))
  const [presetId, setPresetId] = useState<string>(() => detectPreset(settings))
  const [advancedOpen, setAdvancedOpen] = useState(false)

  // Live preview on the REAL transcript when present; else the demo transcript.
  const words = useMemo<Word[]>(() => {
    const ws = transcript?.words ?? []
    return ws.length ? ws.map((w) => ({ startMs: w.start * 1000, endMs: w.end * 1000, text: w.text })) : sampleWords()
  }, [transcript])
  const duration = useMemo<number>(() => {
    const ws = transcript?.words ?? []
    return ws.length ? ws[ws.length - 1].end * 1000 : SAMPLE_DURATION_MS
  }, [transcript])
  const usingSample = (transcript?.words?.length ?? 0) === 0
  const plan = useMemo(() => planSilence(words, settings, duration), [words, settings, duration])

  // -- handlers (mirror SmartSilenceCleaner; commit straight to the store) --------
  const selectPreset = (id: string): void => {
    const p = getPreset(id)
    setStore(copySettings(p.settings))
    setSliders(toSliders(p.settings))
    setPresetId(p.id)
  }
  const onPause = (v: number): void => {
    setStore(applyPauseSlider(settings, v))
    setSliders([v, sliders[1], sliders[2]])
    setPresetId('custom')
  }
  const onSpeed = (v: number): void => {
    setStore(applySpeedSlider(settings, v))
    setSliders([sliders[0], v, sliders[2]])
    setPresetId('custom')
  }
  const onBreath = (v: number): void => {
    setStore(applyBreathSlider(settings, v))
    setSliders([sliders[0], sliders[1], v])
    setPresetId('custom')
  }
  const onToggle = (field: 'smartSilence' | 'keepSentenceFlow' | 'removeFillers', val: boolean): void => {
    setStore(copySettings(settings, { [field]: val }))
    setPresetId('custom')
  }
  const onParam = (key: ParamKey, value: number): void => {
    const ns = copySettings(settings, { [key]: value })
    setStore(ns)
    setSliders(toSliders(ns))
    setPresetId('custom')
  }

  const cutCount = plan.cuts.length

  return (
    <div onClick={() => close(false)} style={css('position:fixed;inset:0;background:rgba(8,8,10,.55);display:grid;place-items:center;z-index:1000')}>
      <div
        className="ssc-root"
        onClick={(e) => e.stopPropagation()}
        style={css(
          `width:460px;max-width:94vw;max-height:90vh;overflow-y:auto;border-radius:12px;padding:20px;box-shadow:0 24px 64px rgba(0,0,0,.6);background:${T.pageBg};border:1px solid ${T.border};color:${T.text};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`
        )}
      >
        <style>{SCOPED_CSS}</style>

        {/* header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 18 }}>🔇</span>
              <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: -0.2 }}>Smart Silence settings</span>
            </div>
            <span style={{ fontSize: 12, color: T.textDim, lineHeight: 1.5 }}>
              <b style={{ color: T.text, fontWeight: 600 }}>Step 1</b> of Find cuts — picks <i>which</i> pauses get cut, using the transcript. How tight each cut lands is set in <b style={{ color: T.text, fontWeight: 600 }}>Silence settings</b>. On its own, <b style={{ color: T.text, fontWeight: 600 }}>Find Silences</b> still uses these values for the cuts themselves.
            </span>
          </div>
          <div onClick={() => close(false)} style={css('color:#9a9aae;font-size:15px;padding:4px 8px;border-radius:8px;cursor:pointer;margin:-4px -6px 0 0')}>✕</div>
        </div>

        {/* mode cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(128px, 1fr))', gap: 9, marginTop: 16 }}>
          {allPresets().map((p) => (
            <ModeCard key={p.id} preset={p} selected={presetId === p.id} onSelect={() => selectPreset(p.id)} />
          ))}
        </div>

        {/* live preview */}
        <div style={{ background: T.panel, border: `1px solid ${T.border}`, borderRadius: 12, padding: 14, marginTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>Preview</span>
            <span style={{ fontSize: 10.5, color: T.textMute }}>{usingSample ? 'demo transcript' : 'your transcript'}</span>
          </div>
          <TimelinePreview words={words} plan={plan} />
        </div>

        {/* creator sliders */}
        <div style={{ background: T.panel, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16, marginTop: 14, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <CreatorSlider label="Pacing" leftLabel="Keep more pauses" rightLabel="Remove more pauses" value={sliders[0]} onChange={onPause} />
          <CreatorSlider label="Conversation speed" leftLabel="Relaxed" rightLabel="Fast" value={sliders[1]} onChange={onSpeed} />
          <CreatorSlider label="Breathing room" leftLabel="Natural breathing" rightLabel="Minimal breathing" value={sliders[2]} onChange={onBreath} />

          <div style={{ height: 1, background: T.hair }} />

          {/* toggles */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <ToggleRow
              label="Smart Silence"
              description="Natural, punctuation-aware pacing. Off = simple gap-based trimming."
              checked={settings.smartSilence}
              onChange={(v) => onToggle('smartSilence', v)}
            />
            <div style={{ opacity: settings.smartSilence ? 1 : 0.5, transition: 'opacity .12s ease' }}>
              <ToggleRow
                label="Keep Sentence Flow"
                description="Keep longer pauses after sentences and commas."
                checked={settings.keepSentenceFlow}
                onChange={(v) => onToggle('keepSentenceFlow', v)}
              />
            </div>
            <ToggleRow
              label="Remove Filler Words"
              description="Delete uh, um, you know… and close the gap around them."
              checked={settings.removeFillers}
              onChange={(v) => onToggle('removeFillers', v)}
            />
          </div>
        </div>

        {/* advanced (collapsed) */}
        <div style={{ marginTop: 14 }}>
          <AdvancedPanel open={advancedOpen} onToggle={() => setAdvancedOpen((o) => !o)} settings={settings} onParam={onParam} />
        </div>

        {/* stats */}
        <div style={{ background: T.panel, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16, marginTop: 14 }}>
          <StatsPanel stats={plan.stats} />
        </div>

        {/* footer */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 18 }}>
          <span style={{ fontSize: 11.5, color: T.textDim }}>
            <span style={{ color: T.text, fontWeight: 600 }}>{cutCount}</span> cut{cutCount === 1 ? '' : 's'} · saves{' '}
            <span style={{ color: T.green, fontWeight: 600 }}>{plan.stats.percentRemoved.toFixed(0)}%</span>
          </span>
          <div style={{ flex: 1 }} />
          <span onClick={() => selectPreset('balanced')} style={css('font-size:12.5px;color:#9a9aae;cursor:pointer;padding:8px 12px;border-radius:9px')}>Reset to Balanced</span>
          <button onClick={() => close(false)} style={css('background:#7c6bff;border:none;color:#fff;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:9px 18px;cursor:pointer')}>Done</button>
        </div>
        <div style={{ fontSize: 11, color: T.textMute, marginTop: 10, lineHeight: 1.45 }}>
          Saved automatically. Run <b style={{ color: T.textDim }}>Find cuts</b> or <b style={{ color: T.textDim }}>Find Silences</b> to stage these cuts for review — nothing is removed until you Apply.
        </div>
      </div>
    </div>
  )
}
