// Verify the virtual-timeline foundation (Stage 7a): a multi-clip base is edited
// as ONE continuous timeline (project-level transcript/cuts in montage time),
// and montage keeps map back to concrete clip source segments for export.
// Run: npx tsx scripts/verify-virtual-timeline.ts
import { computeKeepRanges, baseTimelineDuration, virtualToClip, virtualKeepsToClipSegments } from '../src/shared/edit'
import type { Project, SequenceClip, Word } from '../src/shared/types'

const clip = (id: string, inS: number, outS: number): SequenceClip => ({
  id, sourcePath: id + '.mp4', name: id, sourceIn: inS, sourceOut: outS, sourceDuration: outS + 5,
  hasAudio: true, srcW: 1080, srcH: 1920, fps: 30
})
// c1 virtual [0,10); c2 virtual [10,30) (full length 20, sourceIn 5)
const clips = [clip('c1', 0, 10), clip('c2', 5, 25)]
const w = (id: string, t: string, s: number, e: number, deleted = false): Word => ({ id, text: t, start: s, end: e, deleted })
// montage transcript (virtual time); one deleted word at virtual [12,13]
const project = {
  baseSequence: clips, magnet: true, silences: [], manualCuts: [], keepOverrides: [], silencePadding: 0,
  transcript: { segments: [], words: [w('1', 'keep', 3, 5), w('2', 'cut', 12, 13, true), w('3', 'keep', 20, 24)] }
} as unknown as Project

let ok = true
const check = (n: string, c: boolean): void => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) ok = false }

check('baseTimelineDuration = 30 (virtual, full lengths)', Math.abs(baseTimelineDuration(project) - 30) < 0.01)

const keeps = computeKeepRanges(project)
console.log('  montage keeps:', keeps.map((k) => `[${k.start.toFixed(1)},${k.end.toFixed(1)}]`).join(' '))
check('computeKeepRanges works on the montage (>=2 ranges, cut removed)', keeps.length >= 2)
const kept = keeps.reduce((s, k) => s + (k.end - k.start), 0)
check('kept ≈ 30 - 1.2 (word 0.1-padded both sides)', Math.abs(kept - 28.8) < 0.05)

// virtual time -> clip source
const vc = virtualToClip(project, 12)
console.log('  virtualToClip(12):', vc && `${vc.clip.id}@${vc.sourceTime}`)
check('virtual 12 -> c2 source 7 (12-10+5)', !!vc && vc.clip.id === 'c2' && Math.abs(vc.sourceTime - 7) < 0.01)

// montage keeps -> concrete clip source segments (export)
const segs = virtualKeepsToClipSegments(project, keeps)
console.log('  export segments:', segs.map((s) => `${s.sourcePath}[${s.in.toFixed(1)},${s.out.toFixed(1)}]`).join(' '))
const c2removed = !segs.some((s) => s.sourcePath === 'c2.mp4' && s.in < 8.0 && s.out > 7.0) // the cut c2[6.9,8.1]
check('export splits at clip boundary + drops the cut region (c2 ~7s removed)', c2removed)
check('first segment is all of c1 [0,10]', segs[0].sourcePath === 'c1.mp4' && Math.abs(segs[0].in) < 0.01 && Math.abs(segs[0].out - 10) < 0.01)

console.log(ok ? '\nVIRTUAL-TIMELINE OK' : '\nVIRTUAL-TIMELINE FAILED')
process.exit(ok ? 0 : 1)
