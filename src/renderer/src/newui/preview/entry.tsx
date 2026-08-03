// Dev-only preview harness for Stage A parity screenshots. NOT shipped.
// Renders one design screen (?screen=1a|1b|1c) with mock data so it can be
// screenshotted and pixel-diffed against the ground-truth design render.
import { createRoot } from 'react-dom/client'
import '../newui.css'
import Dashboard from '../screens/Dashboard'
import Editor from '../screens/Editor'
import RetakeStates from '../screens/RetakeStates'

const screen = new URLSearchParams(location.search).get('screen') || '1a'

const MAP: Record<string, () => JSX.Element> = {
  '1a': Dashboard,
  '1b': Editor,
  '1c': RetakeStates
}

// The editor fills the viewport; other screens are content-height.
const fullHeight = screen === '1b'
const Comp = MAP[screen] || Dashboard
const root = createRoot(document.getElementById('root') as HTMLElement)
root.render(
  <div id="screen" style={fullHeight ? { height: '100vh' } : undefined}>
    <Comp />
  </div>
)
