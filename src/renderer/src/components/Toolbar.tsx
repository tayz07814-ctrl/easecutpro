import { useStore } from '../store'
import { IS_WEB } from '../platform'
import ProjectTitle from './ProjectTitle'

export default function Toolbar(): JSX.Element {
  const s = useStore()
  // A base exists if there's a single media OR a multi-clip sequence — the
  // transcribe/silence/export actions handle both (they combine the sequence
  // audio transparently for a montage).
  const hasBase = !!s.project.media || ((s.project.baseSequence?.length ?? 0) > 0)
  const tools = s.tools

  return (
    <div className="toolbar">
      <button onClick={s.goHome} title="Back to your projects">‹ Projects</button>
      <ProjectTitle />
      <div className="sep" />

      <div className="group">
        <button onClick={s.importMedia} title="Import video/audio">⬇ Import</button>
        <button onClick={s.load} disabled={s.job.active}>Open</button>
        <button onClick={s.save} disabled={!hasBase}>Save</button>
      </div>

      <div className="sep" />

      <div className="group">
        <button onClick={s.undo} disabled={!s.canUndo} title="Undo (Ctrl+Z)">↶ Undo</button>
        <button onClick={s.redo} disabled={!s.canRedo} title="Redo (Ctrl+Shift+Z)">↷ Redo</button>
      </div>

      <div className="sep" />

      {/* Manual transcribe + model selector: Electron desktop app only. On the web
          version FastCut / ProCut transcribe automatically (Parakeet / whisper-1). */}
      {!IS_WEB && (
      <div className="group">
        <button
          className="primary"
          onClick={s.transcribe}
          disabled={!hasBase || s.job.active}
          title={tools?.whisper && tools?.whisperModel ? 'Transcribe with whisper.cpp' : 'Whisper not installed'}
        >
          📝 {s.project.transcript ? 'Re-transcribe' : 'Transcribe'}
        </button>
        {s.openaiAvailable && (
          <select
            value={s.transcribeBackend}
            onChange={(e) => s.setTranscribeBackend(e.target.value as 'local' | 'openai')}
            disabled={s.job.active}
            title="Transcription engine. Local whisper (offline, free, verbatim — recommended) or OpenAI whisper-1 (cloud, verbatim). Both keep repeats so Smart Cut can find them."
          >
            <option value="local">Local (offline) · recommended</option>
            <option value="openai">Cloud whisper-1</option>
          </select>
        )}
        {!(s.transcribeBackend === 'openai' && s.openaiAvailable) && s.whisperModels.length > 0 && (
          <select
            value={s.whisperModel}
            onChange={(e) => s.setWhisperModel(e.target.value)}
            disabled={s.job.active}
            title="Local whisper model — larger = more accurate, smaller = faster."
          >
            <option value="">
              Auto{s.whisperModels.find((m) => m.best) ? ` (${s.whisperModels.find((m) => m.best)!.name})` : ''}
            </option>
            {s.whisperModels.map((m) => (
              <option key={m.name} value={m.name}>
                {m.label}
                {m.best ? ' ★' : ''}
              </option>
            ))}
          </select>
        )}
      </div>
      )}

      <div className="sep" />

      <div className="group">
        <button
          onClick={() => { s.setToolsTab('silence'); s.detectSilence() }}
          disabled={!hasBase || s.job.active}
        >
          🔇 Detect silence
        </button>
        <button onClick={s.removeAllSilence} disabled={!s.project.silences.length}>
          Remove all gaps
        </button>
      </div>

      <div className="sep" />

      <div className="group">
        <button
          className={s.project.magnet ? 'toggle on' : 'toggle'}
          onClick={s.toggleMagnet}
          title="Magnet snapping"
        >
          🧲 Magnet {s.project.magnet ? 'On' : 'Off'}
        </button>
        <button
          onClick={() => {
            // Split an overlay clip under the playhead, else split the base track.
            const ok = s.splitAtPlayhead() || s.splitBaseAtPlayhead() || s.splitSequenceAtPlayhead()
            if (!ok)
              useStore.setState({
                job: { active: false, percent: 0, message: 'Move the playhead inside a clip/base segment to split' }
              })
          }}
          disabled={!hasBase}
          title="Split at the playhead (base or overlay clip)"
        >
          ✂ Split
        </button>
        <label className="zoom">
          Zoom
          <input
            type="range"
            min={10}
            max={300}
            value={s.project.pxPerSec}
            onChange={(e) => s.setZoom(Number(e.target.value))}
          />
        </label>
      </div>

      <div className="spacer" />

      <div className="group">
        <span className={`badge ${tools?.whisper && tools?.whisperModel ? 'ok' : 'warn'}`}>
          {tools?.whisper && tools?.whisperModel ? 'Whisper ✓' : 'Whisper: stub'}
        </span>
        <span className={`badge ${tools?.ffmpeg ? 'ok' : 'err'}`}>
          {tools?.ffmpeg ? 'ffmpeg ✓' : 'ffmpeg ✗'}
        </span>
        <button onClick={() => s.setShowSettings(true)} title="Settings & shortcuts">⚙</button>
        <button className="primary" onClick={() => s.setShowExportModal(true)} disabled={!hasBase || s.job.active}>
          ⬆ Export
        </button>
      </div>
    </div>
  )
}
