// Verify EXPORT PARITY for doc-mode base-clip transform/speed/volume:
//  (a) documentToProject carries a main-lane clip's speed/gain + metadata
//      (ovScale/ovZoom*/ovX/ovY) onto the SequenceClip export fields, matching the
//      values SequencePreview applies to the base <video>;
//  (b) virtualKeepsToClipSegments threads the owning clipId back so the exporter
//      can look up per-clip effects;
//  (c) the ffmpeg geometry helpers (baseTransformFilter, atempoChain) produce the
//      right filter fragments — and IDENTITY for an untransformed clip, so exports
//      without transforms stay byte-identical.
// Run: npx tsx scripts/verify-timeline-exporttransform.ts

import { documentToProject } from '../src/shared/timeline/bridge'
import { computeKeepRanges, virtualKeepsToClipSegments } from '../src/shared/edit'
import { createTimeline, createTrack, createClip, addTrackToDoc, addClipToDoc } from '../src/shared/timeline/model'
import { FPS_30 } from '../src/shared/timeline/time'
import { baseTransformFilter, atempoChain } from '../src/main/ffmpeg'
import type { Project } from '../src/shared/types'

let ok = true
const check = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) ok = false
}

// --- (a) + (b): doc with a transformed + a plain main-lane clip -----------------
let doc = createTimeline(FPS_30)
doc = addTrackToDoc(doc, createTrack({ kind: 'video', order: 0, id: 'MAIN', isMain: true }))
// clip A: speed 2×, gain 1.5, Size 140%, Ken Burns 100->200%, pan (+10%, -20%)
doc = addClipToDoc(
  doc,
  createClip({
    id: 'A', kind: 'video', trackId: 'MAIN', start: 0, duration: 75,
    sourcePath: 'a.mp4', sourceIn: 0, sourceOut: 5, sourceDuration: 20, srcW: 1920, srcH: 1080, srcFps: 30,
    speed: 2, gain: 1.5,
    metadata: { ovScale: 1.4, ovZoomStart: 1, ovZoomEnd: 2, ovX: 0.1, ovY: -0.2 }
  })
)
// clip B: untransformed (all defaults)
doc = addClipToDoc(
  doc,
  createClip({
    id: 'B', kind: 'video', trackId: 'MAIN', start: 75, duration: 150,
    sourcePath: 'a.mp4', sourceIn: 8, sourceOut: 13, sourceDuration: 20, srcW: 1920, srcH: 1080, srcFps: 30
  })
)

const project = documentToProject(doc, { name: 'P', version: 1 } as unknown as Project)
const seq = project.baseSequence ?? []
const a = seq.find((c) => c.id === 'A')!
const b = seq.find((c) => c.id === 'B')!

check('baseSequence has both clips', seq.length === 2 && !!a && !!b)
check('clip A: speed carried (2)', a.speed === 2)
check('clip A: gain carried (1.5)', a.gain === 1.5)
check('clip A: size <- ovScale (1.4)', a.size === 1.4)
check('clip A: zoomStart/End <- ovZoom (1, 2)', a.zoomStart === 1 && a.zoomEnd === 2)
check('clip A: panX/Y <- ovX/ovY (0.1, -0.2)', a.panX === 0.1 && a.panY === -0.2)
check(
  'clip B: identity defaults (speed 1, gain 1, size 1, zoom 1/1, pan 0/0)',
  b.speed === 1 && b.gain === 1 && b.size === 1 && b.zoomStart === 1 && b.zoomEnd === 1 && b.panX === 0 && b.panY === 0
)

// (b) each kept segment maps back to its owning base clip via clipId
const keeps = computeKeepRanges(project)
const segs = virtualKeepsToClipSegments(project, keeps)
const ids = new Set(seq.map((c) => c.id))
check('segments carry clipId that resolves to a base clip', segs.length > 0 && segs.every((s) => ids.has(s.clipId)))
check('no-cut fold -> one segment per clip, in order', segs.length === 2 && segs[0].clipId === 'A' && segs[1].clipId === 'B')

// --- (c) ffmpeg geometry helpers ------------------------------------------------
const W = 1920
const H = 1080

// identity => '' (guarantees untransformed exports are byte-identical)
check('baseTransformFilter identity -> empty, no zoompan', baseTransformFilter(1, 1, 1, 0, 0, W, H, 30, 5).chain === '' && !baseTransformFilter(1, 1, 1, 0, 0, W, H, 30, 5).zoompan)
check('baseTransformFilter pan-only at scale 1 -> empty', baseTransformFilter(1, 1, 1, 0.3, -0.2, W, H, 30, 5).chain === '')

// static zoom-in (Size 200%, centered) => exact crop+scale, no zoompan
const zin = baseTransformFilter(2, 1, 1, 0, 0, W, H, 30, 5)
check(
  'static zoom-in -> centered crop + rescale',
  zin.chain === ',crop=iw/2.000000:ih/2.000000:iw*0.500000*(1-1/2.000000):ih*0.500000*(1-1/2.000000),scale=1920:1080'
)
check('static zoom-in flagged non-zoompan', zin.zoompan === false)

// focal offset: panX +0.5 => fx = 1.0 (crop from the right edge)
const zright = baseTransformFilter(2, 1, 1, 0.5, 0, W, H, 30, 5)
check('pan focal shifts crop origin (fx=1.0)', zright.chain.includes('iw*1.000000*(1-1/2.000000)'))

// shrink (Size 50%) => scale down + black pad at focal position
const shrink = baseTransformFilter(0.5, 1, 1, 0, 0, W, H, 30, 5)
check(
  'shrink -> scale down + centered black pad',
  shrink.chain === ',scale=iw*0.500000:ih*0.500000,pad=1920:1080:(ow-iw)*0.500000:(oh-ih)*0.500000:color=black'
)

// animated Ken Burns (100 -> 200% over 5s @30fps) => zoompan with ramped z + focal x/y
const kb = baseTransformFilter(1, 1, 2, 0, 0, W, H, 30, 5)
check('animated zoom uses per-frame scale+crop (no zoompan)', !kb.chain.includes('zoompan') && kb.zoompan === false)
check(
  'animated zoom ramps z over 5s (t-based, ease-in-out)',
  kb.chain.includes("scale=w='(trunc(") &&
    kb.chain.includes('1.000000+(2.000000-1.000000)*(pow(min(t/5.000000,1),2)*(3-2*min(t/5.000000,1)))')
)
// the crop offset is ANALYTIC (same trunc'd width expression), never in_w-based:
// crop's in_w binds at init on variable-size streams (left-anchor bug).
check(
  'animated zoom keeps analytic focal crop expr',
  kb.chain.includes("-7680)*0.500000)'") && !kb.chain.includes('in_w')
)

// exotic size<1 + Ken Burns can't zoom out -> static fallback (no zoompan)
const shrinkKb = baseTransformFilter(0.5, 1, 2, 0, 0, W, H, 30, 5)
check('animated shrink falls back to static (no zoompan)', !shrinkKb.chain.includes('zoompan') && shrinkKb.chain.includes('pad=') && shrinkKb.zoompan === false)

// atempo chaining (each stage 0.5..2.0)
check('atempoChain(1) -> empty', atempoChain(1) === '')
check('atempoChain(2) -> single', atempoChain(2) === ',atempo=2.000000')
check('atempoChain(4) -> two 2× stages', atempoChain(4) === ',atempo=2.000000,atempo=2.000000')
check('atempoChain(0.25) -> two 0.5× stages', atempoChain(0.25) === ',atempo=0.500000,atempo=0.500000')
check('atempoChain(1.5) -> single', atempoChain(1.5) === ',atempo=1.500000')

console.log(ok ? '\nTIMELINE-EXPORTTRANSFORM OK' : '\nTIMELINE-EXPORTTRANSFORM FAILED')
process.exit(ok ? 0 : 1)
