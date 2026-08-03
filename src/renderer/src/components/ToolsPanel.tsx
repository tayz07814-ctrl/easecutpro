import { useStore } from '../store'
import { IS_NEW_UI } from '../platform'
import TranscriptPanel from './TranscriptPanel'
import BasicPanel from './BasicPanel'
import OstPanel from './OstPanel'
import TextPanel from './TextPanel'
import OverlayPanel from './OverlayPanel'

// Tab IDs and handlers are unchanged; only the display labels are refreshed under
// the redesigned UI (VITE_NEW_EASECUT_UI). Legacy labels stay put when the flag is off.
const TABS: { id: 'transcript' | 'basic' | 'text' | 'ost' | 'overlays'; label: string }[] = [
  { id: 'transcript', label: IS_NEW_UI ? 'AI Cut' : 'Cut Lord' },
  { id: 'basic', label: IS_NEW_UI ? 'Edit' : 'Basic' },
  { id: 'text', label: 'Text' },
  { id: 'overlays', label: 'Overlays' },
  { id: 'ost', label: IS_NEW_UI ? 'Audio' : 'OST' }
]

export default function ToolsPanel(): JSX.Element {
  const tab = useStore((s) => s.toolsTab)
  const setTab = useStore((s) => s.setToolsTab)

  return (
    <div className="tools-panel">
      <div className="tools-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={'tools-tab' + (tab === t.id ? ' active' : '')}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="tools-body">
        {tab === 'transcript' && <TranscriptPanel />}
        {tab === 'basic' && <BasicPanel />}
        {tab === 'text' && <TextPanel />}
        {tab === 'overlays' && <OverlayPanel />}
        {tab === 'ost' && <OstPanel />}
      </div>
    </div>
  )
}
