// Smart Silence Cleaner — the page.
//
// Self-contained. Falls back to a built-in demo transcript when no `words` are
// passed, so it renders stand-alone. Selecting a mode card moves the sliders to
// match (to_sliders); moving any slider / toggle / advanced value switches the
// mode to Custom. Everything recomputes purely — no audio, no rendering.
//
// Mount with:
//   import { SmartSilenceCleaner } from '@renderer/smartSilence/ui/SmartSilenceCleaner'

import { useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { EdlRow, SilenceSettings, Word } from '../types'
import { edlRows } from '../types'
import { planSilence } from '../engine'
import { allPresets, DEFAULT_PRESET_ID, getPreset } from '../presets'
import {
  applyBreathSlider,
  applyPauseSlider,
  applySpeedSlider,
  copySettings,
  toSliders,
} from '../settings'
import { SAMPLE_DURATION_MS, sampleWords } from '../sampleData'
import { MONO, SCOPED_CSS, T } from './theme'
import { ModeCard } from './ModeCard'
import { CreatorSlider } from './CreatorSlider'
import { ToggleRow } from './ToggleRow'
import { TimelinePreview } from './TimelinePreview'
import { StatsPanel } from './StatsPanel'
import { ExportPreview } from './ExportPreview'
import { AdvancedPanel } from './AdvancedPanel'

type ParamKey =
  | 'minGapMs'
  | 'targetPauseMs'
  | 'sentencePauseMs'
  | 'commaPauseMs'
  | 'mergeGapMs'
  | 'padBeforeMs'
  | 'padAfterMs'

export interface SmartSilenceCleanerProps {
  /** Transcript words (ms timestamps). Falls back to a demo transcript. */
  words?: Word[]
  /** Media length (ms). Defaults to the last word's end / demo length. */
  durationMs?: number
  /** Called with the EDL rows (seconds for FFmpeg) when Apply is pressed. */
  onApply?: (rows: EdlRow[]) => void
}

function Panel({
  children,
  style,
}: {
  children: ReactNode
  style?: CSSProperties
}): JSX.Element {
  return (
    <div
      style={{
        background: T.panel,
        border: `1px solid ${T.border}`,
        borderRadius: 14,
        padding: 18,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

export function SmartSilenceCleaner({ words, durationMs, onApply }: SmartSilenceCleanerProps): JSX.Element {
  const usingSample = !words || words.length === 0
  const effWords = useMemo<Word[]>(() => (usingSample ? sampleWords() : (words as Word[])), [usingSample, words])
  const effDuration = durationMs !== undefined ? durationMs : usingSample ? SAMPLE_DURATION_MS : undefined

  const [presetId, setPresetId] = useState<string>(DEFAULT_PRESET_ID)
  const [settings, setSettings] = useState<SilenceSettings>(() => copySettings(getPreset(DEFAULT_PRESET_ID).settings))
  const [sliders, setSliders] = useState<[number, number, number]>(() => toSliders(getPreset(DEFAULT_PRESET_ID).settings))
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const plan = useMemo(() => planSilence(effWords, settings, effDuration), [effWords, settings, effDuration])

  // -- handlers ------------------------------------------------------------
  const selectPreset = (id: string): void => {
    const p = getPreset(id)
    setSettings(copySettings(p.settings))
    setSliders(toSliders(p.settings))
    setPresetId(p.id)
  }

  const onPause = (v: number): void => {
    setSettings(applyPauseSlider(settings, v))
    setSliders([v, sliders[1], sliders[2]])
    setPresetId('custom')
  }
  const onSpeed = (v: number): void => {
    setSettings(applySpeedSlider(settings, v))
    setSliders([sliders[0], v, sliders[2]])
    setPresetId('custom')
  }
  const onBreath = (v: number): void => {
    setSettings(applyBreathSlider(settings, v))
    setSliders([sliders[0], sliders[1], v])
    setPresetId('custom')
  }

  const onToggle = (field: 'smartSilence' | 'keepSentenceFlow' | 'removeFillers', val: boolean): void => {
    setSettings(copySettings(settings, { [field]: val }))
    setPresetId('custom')
  }

  const onParam = (key: ParamKey, value: number): void => {
    const ns = copySettings(settings, { [key]: value })
    setSettings(ns)
    setSliders(toSliders(ns))
    setPresetId('custom')
  }

  const apply = (): void => onApply?.(edlRows(plan))

  const cutCount = plan.cuts.length

  return (
    <div
      className="ssc-root"
      style={{
        background: T.pageBg,
        color: T.text,
        minHeight: '100%',
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        fontSize: 14,
        overflowX: 'hidden',
      }}
    >
      <style>{SCOPED_CSS}</style>
      <div style={{ maxWidth: 1000, margin: '0 auto', padding: '26px 20px 120px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* header */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 22 }}>🔇</span>
            <h1 style={{ margin: 0, fontSize: 21, fontWeight: 700, letterSpacing: -0.2 }}>Smart Silence Cleaner</h1>
          </div>
          <p style={{ margin: 0, fontSize: 13, color: T.textDim, lineHeight: 1.5 }}>
            Remove awkward dead air while keeping your speech natural. Pick a mode, fine-tune to taste, and see the result instantly.
          </p>
        </div>

        {/* mode cards */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))',
            gap: 12,
          }}
        >
          {allPresets().map((p) => (
            <ModeCard key={p.id} preset={p} selected={presetId === p.id} onSelect={() => selectPreset(p.id)} />
          ))}
        </div>

        {/* live timeline */}
        <Panel>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>Preview</div>
          <TimelinePreview words={effWords} plan={plan} />
        </Panel>

        {/* controls + stats */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
            gap: 16,
            alignItems: 'start',
          }}
        >
          <Panel style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Fine-tune</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <CreatorSlider
                label="Pacing"
                leftLabel="Keep more pauses"
                rightLabel="Remove more pauses"
                value={sliders[0]}
                onChange={onPause}
              />
              <CreatorSlider
                label="Conversation speed"
                leftLabel="Relaxed"
                rightLabel="Fast"
                value={sliders[1]}
                onChange={onSpeed}
              />
              <CreatorSlider
                label="Breathing room"
                leftLabel="Natural breathing"
                rightLabel="Minimal breathing"
                value={sliders[2]}
                onChange={onBreath}
              />
            </div>

            <div style={{ height: 1, background: T.hair }} />

            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
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
          </Panel>

          <Panel>
            <StatsPanel stats={plan.stats} />
          </Panel>
        </div>

        {/* export preview */}
        <ExportPreview stats={plan.stats} />

        {/* advanced */}
        <AdvancedPanel open={advancedOpen} onToggle={() => setAdvancedOpen((o) => !o)} settings={settings} onParam={onParam} />
      </div>

      {/* apply footer */}
      <div
        style={{
          position: 'sticky',
          bottom: 0,
          background: 'linear-gradient(to top, rgba(13,13,18,0.98), rgba(13,13,18,0.86) 60%, rgba(13,13,18,0))',
          borderTop: `1px solid ${T.hair}`,
          padding: '14px 20px',
        }}
      >
        <div
          style={{
            maxWidth: 1000,
            margin: '0 auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ fontSize: 12, color: T.textDim }}>
            <span style={{ fontFamily: MONO, color: T.text }}>{cutCount}</span> cut{cutCount === 1 ? '' : 's'}
            {' · saves '}
            <span style={{ fontFamily: MONO, color: T.green }}>{plan.stats.percentRemoved.toFixed(0)}%</span>
            {' · '}
            <span style={{ color: getPreset(presetId).editable ? T.accent : T.textDim }}>{getPreset(presetId).title}</span>
          </div>
          <button
            type="button"
            className="ssc-btn"
            onClick={apply}
            style={{
              background: T.accent,
              color: '#fff',
              border: 'none',
              borderRadius: 11,
              padding: '12px 26px',
              fontSize: 14,
              fontWeight: 650,
              fontFamily: 'inherit',
              cursor: 'pointer',
              boxShadow: T.accentGlow,
            }}
          >
            Apply — remove {plan.stats.percentRemoved.toFixed(0)}% silence
          </button>
        </div>
      </div>
    </div>
  )
}

export default SmartSilenceCleaner
