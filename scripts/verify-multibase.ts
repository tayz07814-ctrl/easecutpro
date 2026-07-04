// Verify the multi-clip base layout helpers (Stage 0/2 foundation).
// Run: npx tsx scripts/verify-multibase.ts
import { isMultiBase, sequenceLayout, computeBaseKeepRanges, baseTimelineDuration } from '../src/shared/edit'
import type { Project, SequenceClip, Word } from '../src/shared/types'

const w = (id: string, t: string, s: number, e: number, deleted = false): Word => ({ id, text: t, start: s, end: e, deleted })
const clip = (id: string, inS: number, outS: number, words?: Word[]): SequenceClip => ({
  id, sourcePath: id + '.mp4', name: id, sourceIn: inS, sourceOut: outS, sourceDuration: outS + 2,
  hasAudio: true, srcW: 1080, srcH: 1920, fps: 30,
  transcript: words ? { segments: [], words } : undefined
})

// Stage 7 model: clips are RAW (cleaning is project-level, not per-clip). So the
// layout uses full clip lengths: c1=10, c2=20, c3=5 -> total 35.
const c1 = clip('c1', 0, 10)
const c2 = clip('c2', 0, 20)
const c3 = clip('c3', 0, 5)
const base = (extra: Partial<Project>): Project => ({ baseSequence: [c1, c2, c3], magnet: true, ...(extra as any) } as Project)

let ok = true
const check = (name: string, cond: boolean): void => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) ok = false }

// isMultiBase: true when baseSequence set + no media; FALSE when media set (editSequenceClip case)
check('isMultiBase true (baseSequence, no media)', isMultiBase(base({ media: undefined })) === true)
check('isMultiBase FALSE when media set (per-clip edit routes to single-clip UI)',
  isMultiBase(base({ media: { path: 'x', duration: 20, width: 1, height: 1, fps: 30, hasAudio: true, hasVideo: true } })) === false)

const lay = sequenceLayout(base({ media: undefined }))
console.log('  layout:', lay.items.map((it) => `${it.clip.id}@${it.offset.toFixed(2)}(len ${it.len.toFixed(2)})`).join('  '), '| total', lay.total.toFixed(2))
check('c1 offset 0', Math.abs(lay.items[0].offset - 0) < 0.01)
check('c1 len 10', Math.abs(lay.items[0].len - 10) < 0.01)
check('c2 offset == c1.len (glued)', Math.abs(lay.items[1].offset - lay.items[0].len) < 0.01)
check('c2 len 20 (raw, full length)', Math.abs(lay.items[1].len - 20) < 0.01)
check('c3 offset == c1+c2 (glued)', Math.abs(lay.items[2].offset - (lay.items[0].len + lay.items[1].len)) < 0.01)
check('total == 35 (full lengths)', Math.abs(lay.total - 35) < 0.01)
check('baseTimelineDuration == 35 (virtual full lengths)', Math.abs(baseTimelineDuration(base({ media: undefined })) - 35) < 0.01)

const keeps = computeBaseKeepRanges(base({ media: undefined }))
console.log('  base keep ranges:', keeps.length, 'covering', keeps.reduce((s, k) => s + (k.end - k.start), 0).toFixed(2) + 's')
check('base keep ranges cover the full total (glued, no gaps)',
  Math.abs(keeps.reduce((s, k) => s + (k.end - k.start), 0) - lay.total) < 0.05)

// Magnet OFF + laneStart free positions -> sequenceLayout (and therefore export/
// preview, which iterate its items) must be ordered left-to-right by laneStart.
const c1b = { ...clip('c1', 0, 10), laneStart: 20 }
const c2b = { ...clip('c2', 0, 8), laneStart: 0 }
const c3b = { ...clip('c3', 0, 5), laneStart: 12 }
const off = sequenceLayout({ baseSequence: [c1b, c2b, c3b], magnet: false } as Project)
console.log('  magnet-off order:', off.items.map((it) => it.clip.id).join(' -> '))
check('magnet-off orders by laneStart (export/preview follow the arrangement)',
  off.items.map((it) => it.clip.id).join(',') === 'c2,c3,c1')
check('magnet-off keeps the gaps (c3 offset == its laneStart 12)', Math.abs(off.items[1].offset - 12) < 0.01)

console.log(ok ? '\nMULTIBASE OK' : '\nMULTIBASE FAILED')
process.exit(ok ? 0 : 1)
