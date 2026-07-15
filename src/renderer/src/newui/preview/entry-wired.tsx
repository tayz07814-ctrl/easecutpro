// Dev-only Stage C verification harness. NOT shipped. Seeds a stubbed window.api
// + real Zustand store with realistic data, then mounts a WIRED screen so it can
// be screenshotted / smoke-tested against the real store (not mock data).
import { createRoot } from 'react-dom/client'
import '../../styles.css'
import '../newui.css'
import { useStore } from '../../store'
import { getSharedEngine } from '../../timelineEngine'
import { projectToDocument, normalizeDefaultLanes } from '@shared/timeline/bridge'
import type { Project } from '@shared/types'
import Dashboard from '../screens/Dashboard'
import MobileDashboard from '../screens/MobileDashboard'
import Editor from '../screens/Editor'
import MobileEditor from '../screens/MobileEditor'

const min = 60_000
const svg = (c: string): string =>
  `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='320' height='180'><rect width='320' height='180' fill='%23${c}'/></svg>`

const now = Date.now()
const metas = [
  { id: 'p1', name: 'Morning routine — bedroom take', thumb: svg('2a2d36'), createdAt: 0, updatedAt: now - 36 * min },
  { id: 'p2', name: 'GRWM hook — v2', thumb: svg('26323f'), createdAt: 0, updatedAt: now - 60 * min },
  { id: 'p3', name: 'Kitchen b-roll batch', thumb: svg('2a2d36'), createdAt: 0, updatedAt: now - 90 * min },
  { id: 'p4', name: 'Podcast clip — episode 12', thumb: '', createdAt: 0, updatedAt: now - 3 * 60 * min },
  { id: 'p5', name: 'Meal-prep voiceover', thumb: svg('222831'), createdAt: 0, updatedAt: now - 26 * 60 * min },
  { id: 'p6', name: 'Apartment tour — draft', thumb: svg('242a33'), createdAt: 0, updatedAt: now - 50 * 60 * min }
]

const w = window as unknown as { api: Record<string, unknown>; __calls: string[]; __mainClips?: () => unknown; __engine?: () => unknown }
w.__calls = []
// Test hooks: read the shared engine's main-lane clip order + reach the engine
// itself (drives the SAME beginDrag/updateDrag/endDrag path the timeline uses).
w.__mainClips = () => {
  const doc = getSharedEngine()?.document
  const main = doc?.tracks.find((t) => t.isMain)
  return (main?.clips ?? []).slice().sort((a, b) => a.start - b.start).map((c) => ({ src: c.sourcePath, start: c.start, name: c.name }))
}
w.__engine = () => getSharedEngine()
const rec = (name: string) => (...args: unknown[]): unknown => {
  w.__calls.push(name + ':' + JSON.stringify(args).slice(0, 80))
  if (name === 'listProjects') return Promise.resolve(metas)
  if (name === 'getProject') return Promise.resolve({ id: args[0], name: 'x', project: null })
  if (name === 'createProject') return Promise.resolve({ id: 'new', name: args[0] })
  if (name === 'openMediaDialogMulti') return Promise.resolve([])
  return Promise.resolve()
}
const explicitApi: Record<string, unknown> = {
  listProjects: rec('listProjects'),
  getProject: rec('getProject'),
  createProject: rec('createProject'),
  deleteProjectRecord: rec('deleteProjectRecord'),
  saveProjectRecord: rec('saveProjectRecord'),
  openMediaDialogMulti: rec('openMediaDialogMulti')
}
// Any other engine/media method (waveform, thumbnails, probeMedia…) resolves to
// a harmless empty default so mounting the live TimelinePanel/VideoPreview in the
// harness doesn't throw on an un-stubbed IPC call (these exist in the real env).
w.api = new Proxy(explicitApi, {
  get(target, prop) {
    if (typeof prop !== 'string' || prop === 'then') return undefined
    if (prop in target) return target[prop]
    return (): Promise<unknown> =>
      Promise.resolve(
        prop === 'waveform'
          ? { peaks: new Float32Array(0), sampleRate: 44100, duration: 0 }
          : prop === 'thumbnails'
            ? []
            : null
      )
  }
})

// Build a small transcript matching the design snippet: cut ranges → selected
// word ids; inter-part gaps → staged silences (so the results state renders).
function buildRetakeSeed() {
  const parts = [
    { text: 'You can start talking.', cut: false, gap: 6.7 },
    { text: 'You really think you can make the bed quicker than', cut: true, gap: 0 },
    { text: 'I can finish brushing my teeth?', cut: false, gap: 1.6 },
    { text: 'Don’t tow anything, just leave it rolling.', cut: false, gap: 2.6 },
    { text: 'I’m not just gonna make it, I’m gonna do it in 20 seconds.', cut: false, gap: 0 },
    { text: 'Wait, hold on — let me start that again.', cut: true, gap: 0 }
  ]
  let t = 0
  let wi = 0
  const words: { id: string; text: string; start: number; end: number }[] = []
  const cutIds: string[] = []
  const sils: { id: string; start: number; end: number; action: 'remove' }[] = []
  for (const p of parts) {
    for (const tok of p.text.split(' ')) {
      const w = { id: 'w' + wi++, text: tok, start: +t.toFixed(2), end: +(t + 0.32).toFixed(2) }
      words.push(w)
      if (p.cut) cutIds.push(w.id)
      t += 0.4
    }
    if (p.gap) { sils.push({ id: 's' + sils.length, start: +t.toFixed(2), end: +(t + p.gap).toFixed(2), action: 'remove' }); t += p.gap }
  }
  return { transcript: { words, segments: [{ id: 'seg1', words }] }, cutIds, sils }
}
const rk = buildRetakeSeed()

const seededProject = {
  ...useStore.getState().freshProject(),
  name: 'Morning routine — bedroom take',
  media: { path: 'Bedroom take 3.mp4', duration: 208, width: 1080, height: 1920, hasAudio: true, hasVideo: true, fps: 30 },
  transcript: rk.transcript,
  playhead: 41.2
} as unknown as Project

// ?docbase=1 → reproduce a clip DRAGGED onto the timeline: the base lives ONLY in
// the timeline document; the legacy media/baseSequence fields are empty (as after
// setTimelineDoc). Retake must still find the base via the doc.
const docOnlyProject = {
  ...(useStore.getState().freshProject()),
  name: 'Dragged clip project',
  media: undefined,
  baseSequence: undefined,
  transcript: undefined,
  timeline: normalizeDefaultLanes(projectToDocument(seededProject))
} as unknown as Project
const useDocBase = new URLSearchParams(location.search).get('docbase') === '1'
;(window as unknown as { __job?: () => unknown }).__job = () => useStore.getState().job
useStore.setState({
  user: { id: 'u', email: 'tayz07814@gmail.com' },
  batchJobs: [{ projectId: 'p3', name: 'Kitchen b-roll batch', status: 'processing', step: 'Uploading media…' }],
  view: 'editor',
  currentProjectId: 'p1',
  project: useDocBase ? docOnlyProject : seededProject,
  saveState: 'saved',
  canUndo: true,
  canRedo: false,
  selectedWordIds: new Set(rk.cutIds),
  stagedSilences: rk.sils,
  stagedSilenceSel: new Set(rk.sils.map((s) => s.id)),
  showSilenceSettings: new URLSearchParams(location.search).get('sil') === '1',
  mediaUrl: new URLSearchParams(location.search).get('media') === '1' ? './seedvid.mp4' : null,
  vadSilenceSettings: { speechThreshold: 0.8, minGapS: 1.0, padBeforeS: 0.1, padAfterS: 0.07, edgeTrimS: 0, removeBreaths: false, breathDb: -30 },
  library: [
    { id: 'l1', path: 'seed-base', name: 'Bedroom take 3.mp4', kind: 'video', duration: 208, width: 1080, height: 1920, fps: 30, hasAudio: true, hasVideo: true },
    { id: 'l2', path: 'seed-2', name: 'Bedroom take 2.mp4', kind: 'video', duration: 171, width: 1080, height: 1920, fps: 30, hasAudio: true, hasVideo: true }
  ]
})

const screen = new URLSearchParams(location.search).get('screen') || '1a'
const MAP: Record<string, () => JSX.Element> = { '1a': Dashboard, '1b': Editor, '1a-m': MobileDashboard, '1b-m': MobileEditor }
const Comp = MAP[screen] || Dashboard
createRoot(document.getElementById('root') as HTMLElement).render(
  <div id="screen" style={screen === '1b' || screen === '1b-m' ? { height: '100vh' } : undefined}>
    <Comp />
  </div>
)
