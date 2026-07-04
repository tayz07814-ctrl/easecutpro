import { useStore } from '../store'
import TranscriptPanel from './TranscriptPanel'
import BasicPanel from './BasicPanel'
import SilencePanel from './SilencePanel'
import OstPanel from './OstPanel'
import TextPanel from './TextPanel'
import OverlayPanel from './OverlayPanel'

const TABS: { id: 'transcript' | 'basic' | 'text' | 'silence' | 'ost' | 'overlays'; label: string }[] = [
  { id: 'transcript', label: 'Cut Lord' },
  { id: 'basic', label: 'Basic' },
  { id: 'text', label: 'Text' },
  { id: 'overlays', label: 'Overlays' },
  { id: 'silence', label: 'Silence' },
  { id: 'ost', label: 'OST' }
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
        {tab === 'silence' && <SilencePanel />}
        {tab === 'ost' && <OstPanel />}
      </div>
    </div>
  )
}
