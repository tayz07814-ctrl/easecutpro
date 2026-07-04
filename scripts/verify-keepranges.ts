import { computeKeepRanges } from '../src/shared/edit'
import { createEmptyProject } from '../src/shared/project'
const p = createEmptyProject('t')
p.media = { path: 'x', duration: 10, width: 1920, height: 1080, fps: 30, hasAudio: true, hasVideo: true }
// two cuts that leave a 0.1s kept sliver [3.0–3.1] between them
p.manualCuts = [{ start: 0, end: 3 }, { start: 3.1, end: 6 }]
console.log('keeps:', JSON.stringify(computeKeepRanges(p)))
