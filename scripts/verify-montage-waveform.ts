/* Pure-logic test for the stitched montage waveform (virtual time). */
import { stitchMontageWaveform, baseTimelineDuration } from '../src/shared/edit'
import type { Project, SequenceClip, Waveform } from '../src/shared/types'

const clip = (id: string, src: string, sourceIn: number, sourceOut: number): SequenceClip =>
  ({ id, name: id, sourcePath: src, sourceIn, sourceOut, hasAudio: true } as SequenceClip)

// c1: source 'a' [0,4] (len 4); c2: source 'b' [2,5] (len 3). Virtual total = 7.
const project = { baseSequence: [clip('c1', 'a', 0, 4), clip('c2', 'b', 2, 5)] } as Project

const wave = (pps: number, n: number, f: (i: number) => number): Waveform => ({
  peaksPerSec: pps,
  peaks: Array.from({ length: n }, (_, i) => f(i))
})

let ok = true
const check = (name: string, cond: boolean): void => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) ok = false }

// Source 'a' peak[i] = i ; source 'b' peak[i] = 1000+i (10 peaks/sec, 10s each).
const sources: Record<string, Waveform | undefined> = {
  a: wave(10, 100, (i) => i),
  b: wave(10, 100, (i) => 1000 + i)
}

check('baseTimelineDuration == 7 (virtual)', Math.abs(baseTimelineDuration(project) - 7) < 1e-6)

const wf = stitchMontageWaveform(project, sources)
if (!wf) { console.log('  FAIL  stitch returned null'); process.exit(1) }
console.log('  peaksPerSec:', wf.peaksPerSec, '| length:', wf.peaks.length)
check('peaksPerSec inherited from source (10)', wf.peaksPerSec === 10)
check('length == 40 + 30', wf.peaks.length === 70)
// c1 span [0,4): stitched[i] == a.peaks[i] == i
check('c1 start peak == a[0]', wf.peaks[0] === 0)
check('c1 end peak == a[39]', wf.peaks[39] === 39)
// c2 span [4,7): stitched[40+j] == b.peaks[round((2 + j/10)*10)] == b.peaks[20+j] == 1020+j
check('c2 start peak == b[20] (sourceIn=2)', wf.peaks[40] === 1020)
check('c2 end peak == b[49]', wf.peaks[69] === 1049)

// Missing source -> that clip's span is flat 0, still non-null overall.
const partial = stitchMontageWaveform(project, { a: sources.a, b: undefined })
check('partial: non-null when one source known', !!partial)
check('partial: c2 span filled with 0', !!partial && partial.peaks.slice(40).every((p) => p === 0))

// No sources at all -> null (nothing to draw yet).
check('null when no source waveforms known', stitchMontageWaveform(project, {}) === null)
// Empty sequence -> null.
check('null for empty sequence', stitchMontageWaveform({ baseSequence: [] } as Project, sources) === null)

console.log(ok ? 'MONTAGE-WAVEFORM OK' : 'MONTAGE-WAVEFORM FAILED')
process.exit(ok ? 0 : 1)
