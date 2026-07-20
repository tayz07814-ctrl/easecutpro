import { useState } from 'react'
import { css } from '../css'
import { useStore } from '../../store'

// Batch Processing setup modal (new UI). Opened from the dashboard's "Batch
// processing" button. The creator picks several videos and chooses which
// auto-clean functions to apply, then "Run batch processing" turns each file
// into its OWN project and cleans them one by one (retake + silence today;
// auto-zoom + captions are placeholders for a future update). Progress and the
// finished projects live in the right-hand queue column, not here.

const TITLE = 'font-size:16px;font-weight:650'
const SUB = 'font-size:12.5px;color:#9BA0AC;margin-top:5px;line-height:1.5'
const CLOSE = 'color:#9BA0AC;font-size:15px;padding:4px 8px;border-radius:8px;cursor:pointer;margin:-4px -6px 0 0'
const PURPLE = '#6E6AE8'

interface Pick {
  path: string
  name: string
}

/** One capability card with a toggle. Disabled cards read "Coming soon" and
 *  can't be turned on — the flag still lives in state so the wiring is ready. */
function FnCard({
  title,
  desc,
  on,
  disabled,
  onToggle
}: {
  title: string
  desc: string
  on: boolean
  disabled?: boolean
  onToggle?: () => void
}): JSX.Element {
  return (
    <div
      onClick={disabled ? undefined : onToggle}
      style={css(
        'border-radius:12px;padding:13px 14px;display:flex;align-items:flex-start;gap:11px;' +
          (disabled
            ? 'border:1px solid rgba(255,255,255,.06);opacity:.55;cursor:default'
            : on
              ? `border:1.5px solid ${PURPLE};background:rgba(110,106,232,.07);cursor:pointer`
              : 'border:1px solid rgba(255,255,255,.09);cursor:pointer')
      )}
    >
      <div
        style={css(
          `width:32px;height:18px;border-radius:9px;position:relative;flex:none;margin-top:1px;background:${on && !disabled ? PURPLE : '#3A3E48'}`
        )}
      >
        <div
          style={css(
            on && !disabled
              ? 'position:absolute;right:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff'
              : 'position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#9BA0AC'
          )}
        />
      </div>
      <div style={css('flex:1;min-width:0')}>
        <div style={css('display:flex;align-items:center;gap:8px')}>
          <span style={css(`font-size:13px;font-weight:600;${on && !disabled ? `color:${'#B7B5F4'}` : ''}`)}>{title}</span>
          {disabled && (
            <span
              style={css(
                "font-family:'IBM Plex Mono',monospace;font-size:9.5px;color:#7E8393;background:#22242b;border-radius:5px;padding:2px 6px;letter-spacing:.3px"
              )}
            >
              COMING SOON
            </span>
          )}
        </div>
        <div style={css('font-size:11.5px;color:#9BA0AC;margin-top:4px;line-height:1.45')}>{desc}</div>
      </div>
    </div>
  )
}

export default function BatchProcessingModal(): JSX.Element | null {
  const show = useStore((s) => s.showBatchModal)
  const setShow = useStore((s) => s.setShowBatchModal)
  const runBatchProcessing = useStore((s) => s.runBatchProcessing)

  const [files, setFiles] = useState<Pick[]>([])
  const [retakeSilence, setRetakeSilence] = useState(true)
  const [autoZoom, setAutoZoom] = useState(false)
  const [captions, setCaptions] = useState(false)

  if (!show) return null

  const close = (): void => {
    setShow(false)
    setFiles([])
  }

  const addFiles = async (): Promise<void> => {
    const picked = await window.api.openMediaDialogMulti()
    if (picked.length) {
      // De-dupe by path so a second pick appends rather than replacing.
      setFiles((cur) => {
        const seen = new Set(cur.map((f) => f.path))
        return [...cur, ...picked.filter((p) => !seen.has(p.path))]
      })
    }
  }
  const removeFile = (path: string): void => setFiles((cur) => cur.filter((f) => f.path !== path))

  const run = (): void => {
    if (!files.length) return
    void runBatchProcessing(files, { retakeSilence, autoZoom, captions })
    close()
  }

  const runnable = files.length > 0 && retakeSilence

  return (
    <div
      onClick={close}
      style={css('position:fixed;inset:0;background:rgba(10,11,14,.55);display:grid;place-items:center;z-index:1000')}
      className="ec-newui"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={css(
          'width:520px;max-width:94vw;max-height:88vh;overflow-y:auto;background:#1E2026;border:1px solid rgba(255,255,255,.1);border-radius:12px;box-shadow:0 24px 64px rgba(0,0,0,.6);padding:22px'
        )}
      >
        {/* header */}
        <div style={css('display:flex;align-items:flex-start;justify-content:space-between')}>
          <div>
            <div style={css(TITLE)}>Batch processing</div>
            <div style={css(SUB)}>
              Pick several videos and we’ll create a project for each, then clean them one by one. Open them to
              review, or export the whole batch at once.
            </div>
          </div>
          <div onClick={close} style={css(CLOSE)}>
            ✕
          </div>
        </div>

        {/* file picker */}
        <div style={css('margin-top:18px')}>
          <div style={css('display:flex;align-items:center;justify-content:space-between;margin-bottom:10px')}>
            <span style={css('font-size:12.5px;font-weight:600;color:#E9EAEE')}>
              Files to process{files.length ? ` · ${files.length}` : ''}
            </span>
            <button
              onClick={() => void addFiles()}
              style={css(
                'background:none;border:1px solid rgba(255,255,255,.14);color:#C6C9D2;font-family:inherit;font-size:12px;font-weight:500;border-radius:9px;padding:7px 13px;cursor:pointer'
              )}
            >
              ＋ Add videos
            </button>
          </div>
          {files.length === 0 ? (
            <div
              onClick={() => void addFiles()}
              style={css(
                'border:1.5px dashed rgba(255,255,255,.13);border-radius:12px;padding:26px 14px;text-align:center;cursor:pointer'
              )}
            >
              <div style={css('font-size:13px;color:#C6C9D2;font-weight:550')}>Select videos</div>
              <div style={css('font-size:11.5px;color:#686E7B;margin-top:5px')}>Choose two or more clips to batch-clean</div>
            </div>
          ) : (
            <div
              style={css(
                'display:flex;flex-direction:column;gap:6px;max-height:180px;overflow-y:auto;border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:8px'
              )}
            >
              {files.map((f, i) => (
                <div
                  key={f.path}
                  style={css('display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:8px;background:#191B20')}
                >
                  <span
                    style={css(
                      "font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:#7E8393;width:22px;flex:none"
                    )}
                  >
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span
                    style={css('flex:1;min-width:0;font-size:12.5px;color:#E9EAEE;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}
                  >
                    {f.name}
                  </span>
                  <span
                    onClick={() => removeFile(f.path)}
                    style={css('color:#9BA0AC;font-size:13px;cursor:pointer;padding:2px 6px;border-radius:6px;flex:none')}
                  >
                    ✕
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* functions */}
        <div style={css('margin-top:20px')}>
          <div style={css('font-size:12.5px;font-weight:600;color:#E9EAEE;margin-bottom:10px')}>Functions</div>
          <div style={css('display:flex;flex-direction:column;gap:10px')}>
            <FnCard
              title="Retake & silence cleaning"
              desc="Removes retakes, false starts and dead-air pauses — the same engine as “Find Retakes & Silence.”"
              on={retakeSilence}
              onToggle={() => setRetakeSilence((v) => !v)}
            />
            <FnCard
              title="Auto zoom"
              desc="Adds dynamic punch-in zooms on emphasis. Arriving in a future update."
              on={autoZoom}
              disabled
              onToggle={() => setAutoZoom((v) => !v)}
            />
            <FnCard
              title="Generate captions"
              desc="Burns styled captions from the transcript. Arriving in a future update."
              on={captions}
              disabled
              onToggle={() => setCaptions((v) => !v)}
            />
          </div>
        </div>

        {/* footer */}
        <div style={css('display:flex;align-items:center;margin-top:22px')}>
          <span style={css('font-size:11.5px;color:#7E8393')}>
            {files.length ? `${files.length} project${files.length > 1 ? 's' : ''} will be created` : 'No files selected yet'}
          </span>
          <div style={css('flex:1')} />
          <span onClick={close} style={css('font-size:12.5px;color:#C6C9D2;cursor:pointer;padding:8px 14px;border-radius:9px')}>
            Cancel
          </span>
          <button
            onClick={run}
            disabled={!runnable}
            style={css(
              'border:none;color:#fff;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:9px 18px;margin-left:8px;' +
                (runnable
                  ? `background:${PURPLE};cursor:pointer;box-shadow:0 6px 20px rgba(110,106,232,.35)`
                  : 'background:#33343c;color:#6b7180;cursor:not-allowed')
            )}
          >
            Run batch processing
          </button>
        </div>
      </div>
    </div>
  )
}
