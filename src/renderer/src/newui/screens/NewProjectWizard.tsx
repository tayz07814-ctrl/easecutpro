// New Project wizard — shown when the user starts a project. Pick one or more
// video files (imported as one project, clips in sequence) and tick the
// enhancements to run on import. Ticked options process with a combined progress
// bar; nothing ticked opens the editor directly. Auto-zoom is a placeholder
// ("Soon") until the auto-zoom engine lands in a later update.

import { useState } from 'react'
import { css } from '../css'
import { useStore } from '../../store'
import { useSmoothProgress } from '../../useSmoothProgress'
import type { WizardOpts } from '../../store'

type PickedFile = { path: string; name: string }

const ACCENT = '#7c6bff'
const CARD_BG = '#101015'
const HAIR = 'rgba(255,255,255,.08)'

interface OptionDef {
  key: keyof WizardOpts
  icon: string
  title: string
  sub: string
  soon?: boolean
}
const OPTIONS: OptionDef[] = [
  { key: 'cutSilenceBadTakes', icon: '✂️', title: 'Cut silences & bad takes', sub: 'Remove dead air and flubbed takes automatically' },
  { key: 'captions', icon: '💬', title: 'Auto captions', sub: 'Generate styled captions from the transcript' },
  { key: 'autoZoom', icon: '🔍', title: 'Auto zoom', sub: 'AI punch-in zooms on your key moments' }
]

function OptionCard({
  def,
  on,
  onToggle
}: {
  def: OptionDef
  on: boolean
  onToggle: () => void
}): JSX.Element {
  const disabled = !!def.soon
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onToggle}
      style={css(
        'display:flex;align-items:center;gap:12px;width:100%;text-align:left;font-family:inherit;',
        'border-radius:12px;padding:12px 14px;cursor:pointer;transition:all .12s;',
        `background:${CARD_BG};`,
        on ? `border:1.5px solid ${ACCENT};box-shadow:0 0 0 3px rgba(124,107,255,.18)` : `border:1.5px solid ${HAIR}`,
        disabled && 'cursor:default;opacity:.55'
      )}
    >
      <div style={css('font-size:20px;line-height:1;width:26px;text-align:center')}>{def.icon}</div>
      <div style={css('flex:1;min-width:0')}>
        <div style={css('font-size:13.5px;font-weight:600;color:#ededf2;display:flex;align-items:center;gap:7px')}>
          {def.title}
          {def.soon && (
            <span style={css('font-size:9.5px;font-weight:700;letter-spacing:.4px;color:#c4baff;background:rgba(124,107,255,.18);border-radius:5px;padding:2px 6px;text-transform:uppercase')}>
              Soon
            </span>
          )}
        </div>
        <div style={css('font-size:11.5px;color:#8b8ba0;margin-top:2px')}>{def.sub}</div>
      </div>
      {/* check circle */}
      <div
        style={css(
          'width:22px;height:22px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-size:13px;color:#fff;',
          on ? `background:${ACCENT};border:1.5px solid ${ACCENT}` : `background:transparent;border:1.5px solid ${HAIR}`
        )}
      >
        {on ? '✓' : def.soon ? '' : '+'}
      </div>
    </button>
  )
}

export default function NewProjectWizard({ onClose }: { onClose: () => void }): JSX.Element {
  const startImportWizard = useStore((s) => s.startImportWizard)
  const wizardJob = useStore((s) => s.wizardJob)
  const jobPct = useStore((s) => s.job.percent)

  const [files, setFiles] = useState<PickedFile[]>([])
  const [opts, setOpts] = useState<WizardOpts>({ cutSilenceBadTakes: true, captions: false, autoZoom: false })
  const [busy, setBusy] = useState(false)

  const processing = busy || !!wizardJob
  // Combined bar: current engine's own 0-100 mapped into its slice of the wizard.
  const target = wizardJob ? Math.min(100, wizardJob.base + wizardJob.span * (jobPct / 100)) : busy ? 4 : 0
  const shownPct = Math.round(useSmoothProgress(processing, target))

  async function pickFiles(): Promise<void> {
    const picked = await window.api.openMediaDialogMulti()
    if (picked?.length) {
      setFiles((prev) => {
        const seen = new Set(prev.map((f) => f.path))
        return [...prev, ...picked.filter((p) => !seen.has(p.path))]
      })
    }
  }
  function removeFile(path: string): void {
    setFiles((prev) => prev.filter((f) => f.path !== path))
  }
  function toggle(key: keyof WizardOpts): void {
    setOpts((o) => ({ ...o, [key]: !o[key] }))
  }
  async function proceed(): Promise<void> {
    if (!files.length || processing) return
    setBusy(true)
    try {
      await startImportWizard(files, opts)
      // On success the store switches view → editor and this modal unmounts.
    } catch {
      setBusy(false)
    }
  }

  const anyOpt = opts.cutSilenceBadTakes || opts.captions || opts.autoZoom
  const ctaLabel = anyOpt ? 'Enhance & open editor' : 'Create project'

  return (
    <div
      onClick={processing ? undefined : onClose}
      style={css(
        'position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center;padding:24px;',
        'background:rgba(8,8,10,.66);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)'
      )}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={css(
          'width:100%;max-width:540px;max-height:calc(100vh - 48px);overflow:auto;',
          'background:#0a0a0d;border:1px solid rgba(255,255,255,.09);border-radius:18px;',
          'box-shadow:0 30px 80px rgba(0,0,0,.6);padding:22px 22px 20px;font-family:inherit'
        )}
      >
        {/* header */}
        <div style={css('display:flex;align-items:flex-start;justify-content:space-between;gap:10px')}>
          <div>
            <div style={css('font-size:17px;font-weight:650;color:#ededf2')}>New project</div>
            <div style={css('font-size:12px;color:#8b8ba0;margin-top:3px')}>
              Import your footage and pick what to auto-apply. You can change everything later.
            </div>
          </div>
          {!processing && (
            <div onClick={onClose} style={css('color:#9a9aae;font-size:20px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:8px')}>
              ×
            </div>
          )}
        </div>

        {processing ? (
          <div style={css('padding:34px 6px 18px')}>
            <div style={css('font-size:13px;font-weight:600;color:#ededf2;margin-bottom:14px')}>
              {wizardJob?.label ?? 'Preparing…'}
            </div>
            <div style={css('height:10px;border-radius:6px;background:#141419;overflow:hidden')}>
              <div
                style={css(
                  `width:${shownPct}%;height:100%;border-radius:6px;transition:width .18s ease-out;`,
                  `background:linear-gradient(90deg,${ACCENT},#a99bff)`
                )}
              />
            </div>
            <div style={css('display:flex;justify-content:space-between;margin-top:9px')}>
              <span style={css('font-size:11.5px;color:#8b8ba0')}>This can take a minute for longer videos…</span>
              <span style={css("font-size:12px;font-weight:600;color:#c4baff;font-family:'Geist Mono',monospace")}>{shownPct}%</span>
            </div>
          </div>
        ) : (
          <>
            {/* file picker */}
            <div style={css('margin-top:18px')}>
              <button
                type="button"
                onClick={() => void pickFiles()}
                style={css(
                  'width:100%;font-family:inherit;font-size:13px;font-weight:600;color:#c9c9da;cursor:pointer;',
                  'background:rgba(124,107,255,.08);border:1.5px dashed rgba(124,107,255,.5);border-radius:12px;padding:16px'
                )}
              >
                ＋ {files.length ? 'Add more video files' : 'Select video file(s)'}
              </button>
              {files.length > 0 && (
                <div style={css('margin-top:10px;display:flex;flex-direction:column;gap:6px')}>
                  {files.map((f, i) => (
                    <div
                      key={f.path}
                      style={css(
                        'display:flex;align-items:center;gap:10px;background:#101015;border:1px solid rgba(255,255,255,.06);',
                        'border-radius:9px;padding:8px 11px'
                      )}
                    >
                      <span style={css("font-size:10px;color:#7c6bff;font-weight:700;font-family:'Geist Mono',monospace;width:16px")}>{i + 1}</span>
                      <span style={css('flex:1;min-width:0;font-size:12.5px;color:#d6d6e4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')}>{f.name}</span>
                      <span onClick={() => removeFile(f.path)} style={css('color:#8b8ba0;font-size:15px;cursor:pointer;line-height:1;padding:0 2px')}>×</span>
                    </div>
                  ))}
                  {files.length > 1 && (
                    <div style={css('font-size:11px;color:#8b8ba0;margin-top:2px')}>
                      {files.length} clips will be placed on one timeline, in this order.
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* enhancement options */}
            <div style={css('margin-top:20px;display:flex;flex-direction:column;gap:9px')}>
              <div style={css('font-size:11px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;color:#71718a;margin-bottom:1px')}>
                Enhance on import
              </div>
              {OPTIONS.map((def) => (
                <OptionCard key={def.key} def={def} on={opts[def.key]} onToggle={() => toggle(def.key)} />
              ))}
            </div>

            {/* footer */}
            <div style={css('display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:22px')}>
              <button
                type="button"
                onClick={onClose}
                style={css('font-family:inherit;font-size:13px;font-weight:600;color:#c9c9da;background:transparent;border:none;cursor:pointer;padding:10px 14px')}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!files.length}
                onClick={() => void proceed()}
                style={css(
                  'font-family:inherit;font-size:13px;font-weight:650;color:#fff;border:none;border-radius:11px;padding:11px 20px;',
                  files.length
                    ? `background:${ACCENT};cursor:pointer;box-shadow:0 6px 20px rgba(124,107,255,.35)`
                    : 'background:#191920;color:#6e6e85;cursor:not-allowed'
                )}
              >
                {ctaLabel} →
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
