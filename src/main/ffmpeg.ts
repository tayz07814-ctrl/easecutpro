import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { tmpdir, homedir, cpus } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises'
import { existsSync, writeFileSync } from 'fs'
import { FFMPEG, FFPROBE } from './binaries'
import { computeKeepRanges, virtualKeepsToClipSegments, stitchMontageWaveform, baseClipSpans } from '../shared/edit'
import type {
  MediaInfo,
  SilenceRegion,
  Project,
  Waveform,
  Thumb,
  ExportSettings,
  TextOverlayImage,
  SequenceClip
} from '../shared/types'

const execFileP = promisify(execFile)

/** Pass a filtergraph to ffmpeg SAFELY. A graph with hundreds of cut segments
 *  (one trim per keep) overruns the OS command-line length limit passed inline —
 *  `spawn` fails with ENAMETOOLONG before ffmpeg even starts (Windows ~32K). For a
 *  large graph, write it to a temp file and use `-filter_complex_script`; short
 *  graphs stay inline (byte-identical to before). Returns the args + the temp file
 *  path to clean up afterwards ('' when inline). */
async function filterComplexArgs(fc: string): Promise<{ args: string[]; file: string }> {
  if (fc.length <= 6000) return { args: ['-filter_complex', fc], file: '' }
  const file = join(tmpdir(), `easecut-fc-${randomUUID()}.txt`)
  await writeFile(file, fc, 'utf8')
  return { args: ['-filter_complex_script', file], file }
}

/** Probe a media file for duration / resolution / fps / streams. */
export async function probe(path: string): Promise<MediaInfo> {
  const { stdout } = await execFileP(FFPROBE, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    path
  ], { maxBuffer: 1024 * 1024 * 16 })

  const data = JSON.parse(stdout)
  const streams: any[] = data.streams ?? []
  const v = streams.find((s) => s.codec_type === 'video')
  const a = streams.find((s) => s.codec_type === 'audio')

  let fps = 30
  if (v?.avg_frame_rate && v.avg_frame_rate !== '0/0') {
    const [n, d] = v.avg_frame_rate.split('/').map(Number)
    if (d) fps = n / d
  }

  // Rotation metadata (phone clips): ffmpeg auto-rotates on decode, so every
  // consumer of these dimensions (canvas choice in combineClips/exportProject,
  // the renderer's aspect math) needs the DISPLAY size, not the stored size.
  // A portrait iPhone .mov stores 1920x1080 + a -90° display matrix; reporting
  // it landscape picked a landscape canvas and pillarboxed the export.
  let width = v?.width ?? 0
  let height = v?.height ?? 0
  let rotation = 0
  const sd = (v?.side_data_list ?? []).find((s: any) => typeof s?.rotation === 'number')
  if (sd) rotation = Number(sd.rotation)
  else if (v?.tags?.rotate != null) rotation = Number(v.tags.rotate) || 0
  if (Math.abs(((rotation % 360) + 360) % 360) % 180 === 90) {
    ;[width, height] = [height, width]
  }

  return {
    path,
    duration: parseFloat(data.format?.duration ?? '0'),
    width,
    height,
    fps,
    hasVideo: !!v,
    hasAudio: !!a
  }
}

/** Extract a 16kHz mono WAV (what whisper.cpp expects) next to a temp path. */
export async function extractAudioWav(path: string): Promise<string> {
  const out = join(tmpdir(), `easecut-${randomUUID()}.wav`)
  await execFileP(FFMPEG, [
    '-y',
    '-i', path,
    '-vn',
    // Align audio to the VIDEO timeline: phone .mov files often delay the audio
    // stream (start_time > 0); without this the WAV is shifted earlier, so VAD/
    // transcription cut the wrong place. first_pts=0 pads the leading offset with
    // silence (no-op when the streams already start at 0).
    '-af', 'aresample=async=1:first_pts=0',
    '-ar', '16000',
    '-ac', '1',
    '-c:a', 'pcm_s16le',
    out
  ], { maxBuffer: 1024 * 1024 * 16 })
  return out
}

/** Extract the audio stream as an .m4a (AAC 48k stereo) for BROWSER-side decode —
 *  the on-device exporter pulls this (~1.5MB/min) instead of the full video, which
 *  over a tunnel is 50-100x more data and routinely times out. Transcoded (not
 *  stream-copied) so first_pts=0 re-aligns phone .mov delayed audio to the video
 *  timeline and the result is always decodable by decodeAudioData. */
export async function extractAudioM4a(path: string): Promise<string> {
  const out = join(tmpdir(), `easecut-${randomUUID()}.m4a`)
  await execFileP(FFMPEG, [
    '-y',
    '-i', path,
    '-vn',
    '-af', 'aresample=async=1:first_pts=0',
    '-ar', '48000',
    '-ac', '2',
    '-c:a', 'aac',
    '-b:a', '192k',
    out
  ], { maxBuffer: 1024 * 1024 * 16 })
  return out
}

/**
 * Decode audio to mono 8kHz PCM and reduce to amplitude peaks for a waveform.
 * Streams stdout so memory stays bounded even for long files.
 */
export function extractWaveform(path: string, peaksPerSec = 60): Promise<Waveform> {
  return new Promise((resolve, reject) => {
    const sampleRate = 8000
    const proc = spawn(FFMPEG, [
      '-i', path,
      '-vn',
      // Align to the video timeline (pad a delayed audio stream's leading gap)
      // so the displayed waveform sits under the right frames. See extractAudioWav.
      '-af', 'aresample=async=1:first_pts=0',
      '-ac', '1',
      '-ar', String(sampleRate),
      '-f', 's16le',
      'pipe:1'
    ])
    const bucket = Math.max(1, Math.round(sampleRate / peaksPerSec))
    const peaks: number[] = []
    let cur = 0
    let count = 0
    let leftover: Buffer | null = null
    let err = ''

    proc.stdout.on('data', (chunk: Buffer) => {
      let buf = chunk
      if (leftover) {
        buf = Buffer.concat([leftover, chunk])
        leftover = null
      }
      const n = Math.floor(buf.length / 2)
      for (let i = 0; i < n; i++) {
        const a = Math.abs(buf.readInt16LE(i * 2))
        if (a > cur) cur = a
        if (++count >= bucket) {
          peaks.push(cur / 32768)
          cur = 0
          count = 0
        }
      }
      if (buf.length % 2 === 1) leftover = Buffer.from([buf[buf.length - 1]])
    })
    proc.stderr.on('data', (d: Buffer) => {
      err += d.toString()
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (count > 0) peaks.push(cur / 32768)
      if (code === 0 || peaks.length > 0) resolve({ peaksPerSec, peaks })
      else reject(new Error(`waveform failed (${code}): ${err.slice(-400)}`))
    })
  })
}

/**
 * Extract evenly-spaced JPEG thumbnails as base64 data URLs for the filmstrip.
 */
export async function extractThumbnails(
  path: string,
  intervalSec = 2,
  height = 72
): Promise<Thumb[]> {
  const dir = join(tmpdir(), `easecut-th-${randomUUID()}`)
  await mkdir(dir, { recursive: true })
  try {
    // A big interval means "just one preview frame" (overlay clips). `fps=1/N`
    // with a huge N now yields ZERO frames in current ffmpeg, so grab a single
    // frame explicitly instead.
    const single = intervalSec >= 60
    await execFileP(
      FFMPEG,
      single
        ? ['-y', '-i', path, '-frames:v', '1', '-vf', `scale=-1:${height}`, '-q:v', '5', join(dir, 'th_0001.jpg')]
        : ['-y', '-i', path, '-vf', `fps=1/${intervalSec},scale=-1:${height}`, '-q:v', '5', join(dir, 'th_%04d.jpg')],
      { maxBuffer: 1024 * 1024 * 16 }
    )
    const files = (await readdir(dir)).filter((f) => f.endsWith('.jpg')).sort()
    const out: Thumb[] = []
    for (let i = 0; i < files.length; i++) {
      const b = await readFile(join(dir, files[i]))
      out.push({ time: i * intervalSec, url: `data:image/jpeg;base64,${b.toString('base64')}` })
    }
    return out
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}


/**
 * Export: concat the kept ranges of the base media into a single output.
 * Uses the filter_complex trim+concat approach (frame-accurate, re-encodes).
 * Overlay tracks are composited on top via overlay filters.
 */
const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)

/**
 * WOBBLE-FREE animated zoom (Ken Burns) — per-frame `scale` + focal `crop`.
 *
 * Why not zoompan: it rounds its internally-scaled width and the crop position
 * INDEPENDENTLY every frame, so the visible window's centre alternates a
 * fraction of a pixel left/right during a zoom — the exact shimmy users see on
 * slow pushes (measured on a line pattern: 37 direction reversals per 90 frames
 * linear, 12 after easing+truncation — and ZERO with this chain).
 *
 * Here every frame is Lanczos-scaled to its exact per-frame size (t-based
 * expression, so source fps doesn't matter) and the crop position derives from
 * the frame's REAL size — the centre cannot alternate, only step monotonically,
 * and the K× supersample turns the residual symmetric breathing sub-pixel.
 * K is capped so the supersampled long edge stays ≤ 8192 (K=1 at 4K, where
 * native pixels are already sub-perceptual).
 */
function animatedZoomChain(zExpr: string, fx: number, fy: number, W: number, H: number): string {
  const F6 = (n: number): string => n.toFixed(6)
  const K = Math.max(1, Math.min(4, Math.floor(8192 / Math.max(W, H))))
  const KW = even(W * K)
  const KH = even(H * K)
  // The per-frame width, EXACTLY as the scale filter computes it (same trunc),
  // so the crop offset below can never overrun the real frame. crop's in_w/in_h
  // bind at init with variable-size streams (a centred '(in_w-out_w)/2' quietly
  // became a LEFT anchor — measured 120px drift instead of 24), so the offsets
  // are computed analytically from the same t-expression instead.
  const wT = `(trunc(${KW}*(${zExpr})/2)*2)`
  const hT = `(trunc(${KH}*(${zExpr})/2)*2)`
  const parts: string[] = []
  if (K > 1) parts.push(`scale=${KW}:${KH}:flags=lanczos+accurate_rnd`)
  parts.push(`scale=w='${wT}':h='${hT}':eval=frame:flags=lanczos+accurate_rnd`)
  parts.push(`crop=${KW}:${KH}:x='max(0,(${wT}-${KW})*${F6(fx)})':y='max(0,(${hT}-${KH})*${F6(fy)})'`)
  if (K > 1) parts.push(`scale=${W}:${H}:flags=lanczos+accurate_rnd`)
  return parts.join(',')
}

/** Smoothstep-eased progress over `spanSec` using stream time `t` (valid after
 *  the per-clip setpts=PTS-STARTPTS reset; fps-independent). Linear ramps read
 *  as mechanical — ease-in-out is what makes zooms feel like butter. */
function easedProgressT(spanSec: number): string {
  const P = `min(t/${Math.max(0.05, spanSec).toFixed(6)},1)`
  return `(pow(${P},2)*(3-2*${P}))`
}

/** Chain `atempo` filters to reach `speed` (each stage handles 0.5..2.0), for
 *  per-clip speed on the audio side. Returns '' at 1× so the graph is unchanged.
 *  Exported for the export-transform verify harness. */
export function atempoChain(speed: number): string {
  if (!(speed > 0) || Math.abs(speed - 1) < 1e-3) return ''
  let s = speed
  const factors: number[] = []
  while (s > 2 + 1e-6) {
    factors.push(2)
    s /= 2
  }
  while (s < 0.5 - 1e-6) {
    factors.push(0.5)
    s *= 2
  }
  factors.push(s)
  return factors.map((f) => `,atempo=${f.toFixed(6)}`).join('')
}

/**
 * Base-clip Size/Zoom/Pan as a filter fragment applied AFTER the WxH contain-fit,
 * matching SequencePreview's CSS `scale(size*(zoomStart..zoomEnd))` about the focal
 * origin `(0.5+panX, 0.5+panY)`. Returns '' for an untransformed clip so exports
 * without transforms stay byte-identical.
 *
 * Geometry from the CSS transform: output pixel q shows source pixel
 * `origin + (q-origin)/S`, so a zoom-in (S>=1) is a crop of a W/S × H/S window at
 * the focal point, scaled back to WxH; a shrink (S<1) scales down and pads black at
 * the focal position. An animated zoom uses the jitter-free `zoompanStage` with the
 * focal point encoded in its x/y expressions.
 *
 * Returns `{ chain, zoompan }`: `chain` is the filter fragment ('' for identity),
 * and `zoompan` flags the animated path so the caller can rebuild PTS afterwards —
 * zoompan emits a timebase that a downstream `fps` filter misreads (frame-count
 * explosion), so its output needs a frame-index setpts before conforming.
 * Exported for the export-transform verify harness.
 */
export function baseTransformFilter(
  size: number,
  zoomStart: number,
  zoomEnd: number,
  panX: number,
  panY: number,
  W: number,
  H: number,
  fps: number,
  spanSec: number
): { chain: string; zoompan: boolean } {
  const fx = 0.5 + panX
  const fy = 0.5 + panY
  const s0 = size * Math.max(1, zoomStart)
  const s1 = size * Math.max(1, zoomEnd)
  const eps = 1e-3
  const F = (n: number): string => n.toFixed(6)
  const animated = Math.abs(zoomEnd - zoomStart) > eps
  // Static scale S -> crop (zoom-in) or scale+pad (shrink). Identity near 1.
  const staticX = (S: number): string => {
    if (Math.abs(S - 1) < eps) return ''
    if (S > 1) {
      return (
        `,crop=iw/${F(S)}:ih/${F(S)}:iw*${F(fx)}*(1-1/${F(S)}):ih*${F(fy)}*(1-1/${F(S)}),` +
        `scale=${W}:${H}`
      )
    }
    return `,scale=iw*${F(S)}:ih*${F(S)},pad=${W}:${H}:(ow-iw)*${F(fx)}:(oh-ih)*${F(fy)}:color=black`
  }
  if (!animated) return { chain: staticX(s0), zoompan: false }
  // Animated Ken Burns. zoompan needs zoom>=1 throughout; guaranteed when size>=1
  // (zoomStart/End are >=1). The exotic size<1 + Ken Burns case can't zoom out, so
  // fall back to a static render at the start scale.
  if (Math.min(s0, s1) >= 1 - eps) {
    const zExpr = `${F(s0)}+(${F(s1)}-${F(s0)})*${easedProgressT(spanSec)}`
    // zoompan:false — this chain keeps source PTS/frame-rate (the caller's
    // normal speed/fps tail applies), unlike zoompan's resampled output.
    return { chain: ',' + animatedZoomChain(zExpr, fx, fy, W, H), zoompan: false }
  }
  return { chain: staticX(s0), zoompan: false }
}

/** Run ffmpeg with time= progress parsing; resolves on exit 0. */
function runFfmpegProgress(args: string[], totalDur: number, onProgress?: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args)
    let err = ''
    proc.stderr.on('data', (d) => {
      const s = d.toString()
      err += s
      const m = /time=(\d+):(\d+):([\d.]+)/.exec(s)
      if (m && totalDur > 0 && onProgress) {
        const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
        onProgress(Math.min(100, Math.round((t / totalDur) * 100)))
      }
    })
    proc.on('error', reject)
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg concat failed: ' + err.slice(-600)))))
  })
}

/** Concatenate trimmed segments (scale/pad to a common canvas, with audio) into one
 *  temp file. The optional per-seg `speed`/`gain`/`size`/`zoom*`/`pan*` fields carry
 *  doc-mode base-clip transforms into the render; when all are absent (legacy montage
 *  / flatten) the produced filter graph is byte-identical to before. */
async function concatSegmentsToFile(
  segs: {
    sourcePath: string
    in: number
    out: number
    hasAudio: boolean
    isImage?: boolean
    speed?: number
    gain?: number
    size?: number
    zoomStart?: number
    zoomEnd?: number
    panX?: number
    panY?: number
  }[],
  target: { w: number; h: number; fps?: number },
  onProgress?: (pct: number) => void,
  outPath?: string
): Promise<string> {
  const W = even(target.w || 1920)
  const H = even(target.h || 1080)
  // Output frame grid = the (probed) source rate when the caller supplies one,
  // 30 otherwise. A 60fps source conformed to 30 halves its motion smoothness;
  // a 24fps film clip conformed to 30 judders. Clamped to a sane range — VFR
  // phone .mov avg_frame_rate can report nonsense. The segDur pinning below is
  // rate-agnostic: it only needs every segment quantized to the SAME grid.
  const FPS = target.fps && target.fps >= 10 && target.fps <= 120 ? Number(target.fps.toFixed(3)) : 30
  const inArgs: string[] = []
  const seg: string[] = []
  const order: string[] = []
  let idx = 0
  let totalDur = 0
  for (const s of segs) {
    const ci = idx
    // A still image must be LOOPED (and time-bounded) so it fills its duration.
    if (s.isImage) inArgs.push('-loop', '1', '-t', Math.max(0.1, s.out - s.in).toFixed(3), '-i', s.sourcePath)
    else inArgs.push('-i', s.sourcePath)
    idx++
    const inS = s.isImage ? 0 : Math.max(0, s.in)
    const outS = s.isImage ? Math.max(0.1, s.out - s.in) : Math.max(inS + 0.05, s.out)
    const spanSec = outS - inS
    const speed = typeof s.speed === 'number' && s.speed > 0 ? s.speed : 1
    const gain = typeof s.gain === 'number' ? s.gain : 1
    // Output length folds speed (edited length = source span / speed).
    totalDur += spanSec / speed
    // Per-clip Size/Zoom/Pan on the WxH fitted frame ('' when identity).
    const { chain: xform, zoompan } = baseTransformFilter(
      s.size ?? 1,
      s.zoomStart ?? 1,
      s.zoomEnd ?? 1,
      s.panX ?? 0,
      s.panY ?? 0,
      W,
      H,
      FPS,
      spanSec
    )
    // Speed + framerate conform. Two shapes:
    //  - zoompan already resamples to FPS but emits a timebase that a plain `fps`
    //    filter misreads (frame-count explosion), so rebuild PTS from the frame
    //    index (safe: zoompan output IS FPS) folding speed in, then conform.
    //  - static/identity frames keep their source fps + clean PTS, so scale PTS by
    //    speed (no-op at 1×) and let `fps` conform the source rate, preserving the
    //    real duration for non-30fps sources.
    const tail = zoompan
      ? `,setpts=N/${(FPS * speed).toFixed(6)}/TB,fps=${FPS}`
      : `${Math.abs(speed - 1) > 1e-3 ? `,setpts=PTS/${speed.toFixed(6)}` : ''},fps=${FPS}`
    // A spatial transform (crop/scale/zoompan/pad) re-derives the pixel aspect, so
    // re-assert square pixels — the concat filter rejects segments with mixed SAR.
    // Only for transformed segs, so the untransformed graph stays byte-identical.
    const sar = xform !== '' ? ',setsar=1' : ''
    // A/V DRIFT AT EVERY CUT (the .mov lip-sync bug): `trim` keeps whole FRAMES,
    // so a segment's video snaps to the source frame grid, while `atrim` cuts at
    // exact SAMPLES. Each segment therefore ends up with slightly different video
    // and audio lengths, and `concat` SUMS that difference across cuts — twenty
    // cuts drift by up to twenty frame-periods, and worse on variable-frame-rate
    // phone .mov where the frame period isn't even constant.
    //
    // So pin BOTH streams of every segment to the same length: segDur, the
    // intended edited length quantized to the output frame grid. Every segment is
    // then equal-length in both streams and concat has nothing to accumulate.
    // Mirrors the on-device exporter's per-clip window alignment (localExport.ts
    // renderAudio).
    //
    // Both sides pad-then-cut, because a segment can come up SHORT as well as
    // long — the last clip of a source runs out of frames/samples before segDur,
    // and padding only one side would just move the mismatch. `tpad` clones the
    // final frame / `apad` appends silence, indefinitely; the following trim is
    // what bounds them. Video is already conformed to FPS by `tail`, so its trim
    // yields exactly segFrames frames.
    const segFrames = Math.max(1, Math.round((spanSec / speed) * FPS))
    const segDur = (segFrames / FPS).toFixed(6)
    seg.push(
      `[${ci}:v]trim=start=${inS.toFixed(3)}:end=${outS.toFixed(3)},setpts=PTS-STARTPTS,` +
        `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1` +
        `${xform}${tail}${sar},tpad=stop=-1:stop_mode=clone,trim=duration=${segDur},setpts=PTS-STARTPTS[v${ci}]`
    )
    if (s.hasAudio) {
      // Align the audio to the VIDEO timeline FIRST (pad a delayed-audio stream's
      // leading offset) and only THEN trim — otherwise the trim strips the offset
      // and the audio runs ~0.7s ahead of the video (lip-sync drift on phone .mov).
      // Then per-clip speed (atempo) and volume (gain), both no-ops at their defaults.
      const vol = Math.abs(gain - 1) > 1e-3 ? `,volume=${Math.max(0, gain).toFixed(6)}` : ''
      seg.push(
        `[${ci}:a]aresample=async=1:first_pts=0,atrim=start=${inS.toFixed(3)}:end=${outS.toFixed(3)},` +
          `asetpts=PTS-STARTPTS${atempoChain(speed)}${vol},` +
          `apad,atrim=duration=${segDur},asetpts=PTS-STARTPTS[a${ci}]`
      )
      order.push(`[v${ci}][a${ci}]`)
    } else {
      // Silent bed matches the (sped) video length so concat stays A/V-aligned.
      inArgs.push('-f', 'lavfi', '-t', segDur, '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
      const ai = idx
      idx++
      seg.push(`[${ai}:a]apad,atrim=duration=${segDur},asetpts=PTS-STARTPTS[a${ci}]`)
      order.push(`[v${ci}][a${ci}]`)
    }
  }
  const fc = `${seg.join(';')};${order.join('')}concat=n=${segs.length}:v=1:a=1[outv][outa]`
  const out = outPath || join(tmpdir(), `ec-seq-${randomUUID()}.mp4`)
  const { args: fca, file: fcFile } = await filterComplexArgs(fc)
  const args = [
    '-y', ...inArgs,
    ...fca,
    '-map', '[outv]', '-map', '[outa]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
    out
  ]
  try {
    await runFfmpegProgress(args, totalDur, onProgress)
  } finally {
    if (fcFile) await rm(fcFile).catch(() => undefined)
  }
  return out
}

/**
 * Concatenate ONLY the audio of the segments into one 16 kHz mono WAV. Used for
 * transcription / silence detection, which don't need video — this skips the
 * (slow) per-clip scale+re-encode of the full combine, so a montage is ready to
 * transcribe far faster (the big mobile-latency win). The audio timeline still
 * matches the montage/virtual timeline (each clip's [in,out] laid end to end), so
 * word timings map back correctly.
 */
async function concatAudioToFile(
  segs: { sourcePath: string; in: number; out: number; hasAudio: boolean }[],
  onProgress?: (pct: number) => void,
  outPath?: string
): Promise<string> {
  const inArgs: string[] = []
  const filt: string[] = []
  const order: string[] = []
  let idx = 0
  let totalDur = 0
  segs.forEach((s, li) => {
    const inS = Math.max(0, s.in)
    const outS = Math.max(inS + 0.05, s.out)
    totalDur += outS - inS
    if (s.hasAudio) {
      const ci = idx
      inArgs.push('-i', s.sourcePath)
      idx++
      filt.push(
        `[${ci}:a]aresample=async=1:first_pts=0,atrim=start=${inS.toFixed(3)}:end=${outS.toFixed(3)},` +
          `asetpts=PTS-STARTPTS,aformat=sample_rates=16000:channel_layouts=mono[a${li}]`
      )
    } else {
      inArgs.push('-f', 'lavfi', '-t', (outS - inS).toFixed(3), '-i', 'anullsrc=channel_layout=mono:sample_rate=16000')
      const ci = idx
      idx++
      filt.push(`[${ci}:a]asetpts=PTS-STARTPTS[a${li}]`)
    }
    order.push(`[a${li}]`)
  })
  const fc = `${filt.join(';')};${order.join('')}concat=n=${segs.length}:v=0:a=1[outa]`
  const out = outPath || join(tmpdir(), `ec-seq-${randomUUID()}.wav`)
  const { args: fca, file: fcFile } = await filterComplexArgs(fc)
  const args = ['-y', ...inArgs, ...fca, '-map', '[outa]', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', out]
  try {
    await runFfmpegProgress(args, totalDur, onProgress)
  } finally {
    if (fcFile) await rm(fcFile).catch(() => undefined)
  }
  return out
}

/**
 * Combine sequence clips (each trimmed to [sourceIn,sourceOut]) into ONE base file,
 * so the whole thing can be transcribed / silence-detected / edited as a single video.
 * Returns the path to the combined file (in a persistent cache dir).
 *
 * `audioOnly` produces a fast 16 kHz mono WAV (no video re-encode) for the
 * transcribe / silence pipelines; the default full combine is used for "Flatten".
 */
export async function combineClips(
  clips: SequenceClip[],
  onProgress?: (pct: number) => void,
  outDir?: string,
  audioOnly = false
): Promise<string> {
  if (!clips.length) throw new Error('No clips to combine')
  const segs = clips.map((c) => ({
    sourcePath: c.sourcePath,
    in: Math.max(0, c.sourceIn),
    out: Math.max(c.sourceIn + 0.05, c.sourceOut),
    hasAudio: c.hasAudio,
    isImage: c.isImage
  }))
  const dir = outDir || join(homedir(), '.easecutpro', 'combined')
  await mkdir(dir, { recursive: true })
  if (audioOnly) {
    const outA = join(dir, `combined-${randomUUID()}.wav`)
    return concatAudioToFile(segs, onProgress, outA)
  }
  // Target canvas = the FIRST clip's REAL dimensions. The renderer's stored
  // srcW/srcH default to 1920x1080 when the browser couldn't probe the file —
  // flattening a PORTRAIT phone video into that landscape canvas produced a
  // tiny pillar-boxed export. Probe the actual file and trust it first.
  let target: { w: number; h: number; fps?: number } = { w: clips[0].srcW || 0, h: clips[0].srcH || 0 }
  try {
    const info = await probe(clips[0].sourcePath)
    if (info.width && info.height) target = { w: info.width, h: info.height, fps: info.fps }
  } catch {
    /* fall back to the stored fields */
  }
  if (!target.w || !target.h) target = { w: 1920, h: 1080, fps: target.fps }
  const out = join(dir, `combined-${randomUUID()}.mp4`)
  return concatSegmentsToFile(segs, target, onProgress, out)
}

/** EXPORT-PLAN DEBUG DUMP (non-destructive) — writes ~/.easecutpro/export/debug-*.json
 *  capturing which base clips survive the cut→segment mapping and, for any that
 *  don't, whether their span held transcript words. Confirms/refutes the residue-drop
 *  (wordless-keep removal) eating real clips. Never throws, never alters the export. */
async function writeExportDebug(
  pathChosen: 'montage' | 'single',
  project: Project,
  keeps: { start: number; end: number }[],
  spans: ReturnType<typeof baseClipSpans>,
  coveredClipIds: Set<string>
): Promise<void> {
  try {
    const tw = project.transcript?.words ?? []
    const wordsIn = (a: number, b: number): number => tw.filter((w) => !w.deleted && (w.start + w.end) / 2 > a && (w.start + w.end) / 2 < b).length
    const clips = spans.map((s) => ({
      id: s.clip.id, sourcePath: s.clip.sourcePath, vStart: Number(s.vStart.toFixed(3)), vEnd: Number(s.vEnd.toFixed(3)),
      covered: coveredClipIds.has(s.clip.id), transcript_words_in_span: wordsIn(s.vStart, s.vEnd)
    }))
    const missing = clips.filter((c) => !c.covered)
    const dump = {
      mode: 'export_plan', path_chosen: pathChosen, created: new Date().toISOString(),
      project_media_set: !!project.media, base_sequence_count: project.baseSequence?.length ?? 0,
      protect_silences: (project.silences ?? []).filter((s) => s.protect && s.action === 'remove').length,
      total_transcript_words: tw.length, deleted_words: tw.filter((w) => w.deleted).length,
      keeps_count: keeps.length, total_kept_s: Number(keeps.reduce((n, k) => n + (k.end - k.start), 0).toFixed(3)),
      keeps: keeps.map((k) => ({ start: Number(k.start.toFixed(3)), end: Number(k.end.toFixed(3)) })),
      clips, missing_clips: missing,
      likely_cause: !missing.length
        ? 'no base clips missing at this stage'
        : missing.every((c) => c.transcript_words_in_span === 0)
          ? 'RESIDUE-DROP: every missing clip has ZERO transcript words in its span — the wordless-keep drop removed real clips'
          : 'some missing clips HAVE words — NOT the residue-drop; keep/segment mapping issue'
    }
    const dir = join(homedir(), '.easecutpro', 'export')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(dump, null, 2), 'utf8')
    console.log(`[export-debug] ${pathChosen}: keeps=${keeps.length} clips=${clips.length} missing=${missing.length}`)
  } catch (e) {
    console.warn('[export-debug] dump failed:', (e as Error).message)
  }
}

export async function exportProject(
  project: Project,
  outPath: string,
  settings: ExportSettings | undefined,
  textOverlays: TextOverlayImage[] | undefined,
  onProgress?: (pct: number) => void
): Promise<string> {
  // Montage mode: pre-concat the base sequence into one file, then run the normal
  // single-base pipeline on it (overlays / text / music / zoom all still apply).
  // Multi-clip base: pre-concat into one file, then run the normal single-base
  // pipeline. `&& !project.media` matters — during a per-clip edit `media` is set
  // (baseSequence still non-empty) and export must write that single clip, not the
  // whole montage. Iterate sequenceLayout order so reordered/free-moved clips
  // export exactly as arranged on the timeline.
  let cameFromMontage = false
  if (project.baseSequence && project.baseSequence.length > 0 && !project.media) {
    cameFromMontage = true
    const seq = project.baseSequence
    // Probe the first clip for the canvas + frame grid rather than trusting the
    // renderer's stored srcW/srcH (default 1920x1080 when the browser couldn't
    // probe — the same portrait-pillarbox bug combineClips already fixed) —
    // and pass the real fps so the montage isn't force-conformed to 30.
    let target: { w: number; h: number; fps?: number } = { w: seq[0].srcW || 1920, h: seq[0].srcH || 1080 }
    try {
      const info = await probe(seq[0].sourcePath)
      if (info.width && info.height) target = { w: info.width, h: info.height, fps: info.fps }
    } catch {
      /* fall back to the stored fields */
    }
    // Virtual montage: apply the project-level cuts (transcript words + silences)
    // in montage time, then map the kept ranges back to concrete clip SOURCE
    // segments (split at clip boundaries) to concatenate. The stitched montage
    // waveform (same shared stitcher the renderer uses) lets cut edges snap to
    // energy valleys — export seams land exactly where the preview's do.
    let seqWave: Waveform | null = null
    try {
      const sources: Record<string, Waveform | undefined> = {}
      for (const path of Array.from(new Set(seq.map((c) => c.sourcePath)))) {
        sources[path] = await extractWaveform(path)
      }
      seqWave = stitchMontageWaveform(project, sources)
    } catch {
      seqWave = null // no waveform -> classic edge placement
    }
    const keeps = computeKeepRanges(project, seqWave)
    // Map each kept segment back to its base clip so per-clip transform/speed/gain
    // ride into the concat. Undefined for legacy montage clips (no doc transform)
    // -> identity, so those exports are unchanged.
    const byId = new Map<string, SequenceClip>(seq.map((c) => [c.id, c]))
    const rawSegs = virtualKeepsToClipSegments(project, keeps)
    const segs = rawSegs.map((s) => {
      const c = byId.get(s.clipId)
      return {
        sourcePath: s.sourcePath,
        in: s.in,
        out: s.out,
        hasAudio: s.hasAudio,
        isImage: s.isImage,
        speed: c?.speed,
        gain: c?.gain,
        size: c?.size,
        zoomStart: c?.zoomStart,
        zoomEnd: c?.zoomEnd,
        panX: c?.panX,
        panY: c?.panY
      }
    })
    // EXPORT-PLAN DUMP (non-destructive): which base clips survived into the render
    // and, for any that DIDN'T, whether their span held transcript words — so a
    // "missing clips" export can be diagnosed server-side (esp. residue-drop eating
    // a wordless montage clip). Never throws; never alters the export.
    await writeExportDebug('montage', project, keeps, baseClipSpans(project), new Set(rawSegs.map((s) => s.clipId)))
    if (!segs.length) throw new Error('Nothing to export (all montage clips cut)')
    const seqTemp = await concatSegmentsToFile(segs, target, (p) => onProgress?.(Math.round(p * 0.45)))
    const info = await probe(seqTemp)
    project = {
      ...project,
      media: {
        path: seqTemp,
        duration: info.duration,
        width: info.width,
        height: info.height,
        fps: info.fps,
        hasAudio: info.hasAudio,
        hasVideo: info.hasVideo
      },
      baseSequence: undefined,
      transcript: undefined,
      silences: [],
      baseSplits: [],
      manualCuts: [],
      keepOverrides: []
    }
    const orig = onProgress
    onProgress = orig ? (p: number) => orig(45 + Math.round(p * 0.55)) : undefined
  }

  const base = project.media
  if (!base) throw new Error('No base media to export')

  // Snap cut edges to energy valleys using the media's own waveform, matching
  // the renderer (which passes the store waveform for the same file).
  let baseWave: Waveform | null = null
  try {
    baseWave = await extractWaveform(base.path)
  } catch {
    baseWave = null
  }
  const keeps = computeKeepRanges(project, baseWave)
  if (!cameFromMontage) await writeExportDebug('single', project, keeps, baseClipSpans(project), new Set())
  if (keeps.length === 0) throw new Error('Nothing to export (all cut)')

  const totalKept = keeps.reduce((s, k) => s + (k.end - k.start), 0)
  // Re-probe for the canvas rather than trusting stored dimensions: projects
  // saved before probe() was rotation-aware carry the STORED (unrotated) size
  // for portrait phone clips, which picks a landscape canvas and pillarboxes
  // the whole export. Probe failure falls back to the stored values.
  let baseW = base.width || 1920
  let baseH = base.height || 1080
  try {
    const bp = await probe(base.path)
    if (bp.width > 0 && bp.height > 0) {
      baseW = bp.width
      baseH = bp.height
    }
  } catch {
    /* keep stored dims */
  }

  // Collect overlay clips (tracks 1 & 2). Each becomes an extra ffmpeg input.
  // Skip any whose source file is missing so a broken/deleted overlay never
  // aborts the whole render — the video still exports without it.
  const overlays = project.tracks
    .filter((t) => t.index !== 0)
    .flatMap((t) => t.clips)
    .filter((c) => c.sourceOut - c.sourceIn > 0.05)
    .filter((c) => {
      try {
        if (existsSync(c.sourcePath)) return true
        console.warn(`[overlays] skipping missing file: ${c.sourcePath}`)
        return false
      } catch {
        return false
      }
    })

  const inputs: string[] = ['-i', base.path]
  overlays.forEach((c) => {
    if (c.isImage) inputs.push('-loop', '1', '-i', c.sourcePath)
    else inputs.push('-i', c.sourcePath)
  })

  // Write text overlay PNGs to temp files and add them as looped inputs.
  const texts = (textOverlays ?? []).filter((t) => t.png && t.end - t.start > 0.05)
  const tmpDir = join(tmpdir(), `easecut-txt-${randomUUID()}`)
  const textInputs: { idx: number; start: number; end: number }[] = []
  if (texts.length) {
    await mkdir(tmpDir, { recursive: true })
    for (let i = 0; i < texts.length; i++) {
      const p = join(tmpDir, `t${i}.png`)
      await writeFile(p, Buffer.from(texts[i].png.replace(/^data:image\/png;base64,/, ''), 'base64'))
      inputs.push('-loop', '1', '-i', p)
      textInputs.push({ idx: 1 + overlays.length + i, start: texts[i].start, end: texts[i].end })
    }
  }

  // Background music input (looped at the demuxer when requested).
  const music = project.music && project.music.path ? project.music : null
  let musicIdx = -1
  if (music) {
    if (music.loop) inputs.push('-stream_loop', '-1')
    inputs.push('-i', music.path)
    musicIdx = 1 + overlays.length + texts.length
  }

  // Document-mode audio lanes (detached / dropped audio, folded-out music) — each
  // an extra input mixed under the base voice at its edited position. Skip any
  // missing/degenerate file so a broken lane can never abort the render.
  const extraAudio = (project.extraAudio ?? []).filter(
    (a) => a.path && existsSync(a.path) && a.out - a.in > 0.02
  )
  const extraAudioIdx: number[] = []
  {
    let idx = 1 + overlays.length + texts.length + (music ? 1 : 0)
    for (const a of extraAudio) {
      inputs.push('-i', a.path)
      extraAudioIdx.push(idx++)
    }
  }

  try {
    return await new Promise<string>((resolve, reject) => {
      const parts: string[] = []

    // Base video passes through unzoomed — global base Ken Burns is gone; per-clip
    // motion (zoom/pan) now lives on the document clips' transforms. `vcur` tracks
    // the current base video label ([0:v] -> overlay/text composite outs).
    let vcur = '[0:v]'

    // 1) Composite overlays onto the base video timeline.
    if (base.hasVideo) {
      overlays.forEach((c, idx) => {
        const inIdx = idx + 1
        const crop = c.crop ?? { l: 0, t: 0, r: 0, b: 0 }
        const vw = Math.max(0.05, 1 - crop.l - crop.r)
        const vh = Math.max(0.05, 1 - crop.t - crop.b)
        const ow = even(baseW * c.scale)
        const len = c.sourceOut - c.sourceIn
        const zs = Math.max(1, c.zoomStart ?? 1)
        const ze = Math.max(1, c.zoomEnd ?? 1)
        const fps = Math.max(1, Math.round(base.fps || 30))
        const frames = Math.max(1, Math.round(len * fps))
        const hasZoom = zs > 1.001 || ze > 1.001
        const trimPart = c.isImage
          ? `trim=start=0:end=${len}`
          : `trim=start=${c.sourceIn}:end=${c.sourceOut}`
        // Crop the visible region RELATIVE to the real decoded frame (iw/ih).
        // Absolute pixel crops derived from the probed srcW/srcH aborted the
        // export ("Invalid too big or non positive size") whenever the decoded
        // image differed from the probe — e.g. EXIF-rotated photos.
        const cropPart =
          crop.l > 0.001 || crop.t > 0.001 || crop.r > 0.001 || crop.b > 0.001
            ? `crop=iw*${vw.toFixed(5)}:ih*${vh.toFixed(5)}:iw*${crop.l.toFixed(5)}:ih*${crop.t.toFixed(5)},`
            : ''
        let scaleZoom: string
        if (hasZoom) {
          // Ken Burns zoom (zoom-in). zoompan needs an explicit output canvas,
          // so derive the height from the source aspect (reliable for video).
          const sW = c.srcW || baseW
          const sH = c.srcH || baseH
          const cw = even(sW * vw)
          const ch = even(sH * vh)
          const oh = even((ow * ch) / cw)
          // Supersampled zoompan (see zoompanStage) so slow b-roll pushes are
          // sub-pixel smooth too; its internal scale-up replaces the plain
          // scale=ow:oh and establishes the ow:oh canvas at S× before zooming.
          scaleZoom = animatedZoomChain(
            `${zs}+(${ze}-${zs})*${easedProgressT(len)}`,
            0.5,
            0.5,
            ow,
            oh
          )
        } else {
          // No zoom: scale to the overlay width and let the height follow the
          // real cropped aspect (even). Correct for any image orientation.
          scaleZoom = `scale=${ow}:-2`
        }
        // Overlay in/out animation. 'fade' = alpha fade in & out. 'pop' = a fast
        // fade-in (a lightweight stand-in; TODO: true scale-pop via per-frame
        // scale). 'none' = static.
        let animPart = ''
        const anim = c.overlayAnimation
        if (anim === 'fade' || anim === 'pop') {
          const inD = anim === 'pop' ? 0.15 : 0.3
          const outD = 0.3
          animPart = `,format=rgba,fade=t=in:st=0:d=${inD}:alpha=1`
          if (len > outD + inD) {
            animPart += `,fade=t=out:st=${(len - outD).toFixed(3)}:d=${outD}:alpha=1`
          }
        }
        parts.push(
          `[${inIdx}:v]${trimPart},setpts=PTS-STARTPTS,${cropPart}${scaleZoom}${animPart},` +
            `setpts=PTS-STARTPTS+${c.start}/TB[ov${idx}]`
        )
        const x = Math.round(baseW * c.x)
        const y = Math.round(baseH * c.y)
        const out = idx === overlays.length - 1 ? '[cv]' : `[bc${idx}]`
        parts.push(
          `${vcur}[ov${idx}]overlay=${x}:${y}:enable='between(t,${c.start.toFixed(3)},${(c.start + len).toFixed(3)})':eof_action=pass${out}`
        )
        vcur = out
      })
    }
    // 1b) Composite text overlays (full-frame PNGs) on top, in source time.
    if (base.hasVideo) {
      textInputs.forEach((t, i) => {
        parts.push(`[${t.idx}:v]scale=${even(baseW)}:${even(baseH)}[tx${i}]`)
        const out = `[tc${i}]`
        parts.push(
          `${vcur}[tx${i}]overlay=0:0:enable='between(t,${t.start.toFixed(3)},${t.end.toFixed(3)})':eof_action=pass${out}`
        )
        vcur = out
      })
    }

    // vcur now tracks the latest base label ([0:v] -> [bz] -> overlay/text outs).
    const vsrc = vcur

    // 2) Cut: split the composited stream, trim each keep range, concat.
    const N = keeps.length
    const vLabels: string[] = []
    const aLabels: string[] = []
    if (base.hasVideo) {
      parts.push(`${vsrc}split=${N}${keeps.map((_, i) => `[vs${i}]`).join('')}`)
    }
    if (base.hasAudio) {
      parts.push(`[0:a]asplit=${N}${keeps.map((_, i) => `[as${i}]`).join('')}`)
    }
    keeps.forEach((k, i) => {
      if (base.hasVideo) {
        parts.push(`[vs${i}]trim=start=${k.start}:end=${k.end},setpts=PTS-STARTPTS[v${i}]`)
        vLabels.push(`[v${i}]`)
      }
      if (base.hasAudio) {
        // Anti-click seam fades, GATED on project.smoothAudioFadeMs — unset
        // (all classic modes) keeps the exact previous filter graph.
        // Fades apply only at actual CUT SEAMS: no fade-in on the very first
        // segment, no fade-out on the last. Clamped to <=60ms (user runs 50ms
        // for FastCut/ProCut; note long fades can read as slight volume dips
        // at dense cut points). A true acrossfade would drift AV sync.
        const fadeSec = Math.min(project.smoothAudioFadeMs ?? 0, 60) / 1000
        const segDur = k.end - k.start
        let fade = ''
        if (fadeSec > 0 && segDur > fadeSec * 3) {
          const fin = i > 0 ? `,afade=t=in:st=0:d=${fadeSec.toFixed(3)}` : ''
          const fout = i < N - 1 ? `,afade=t=out:st=${(segDur - fadeSec).toFixed(3)}:d=${fadeSec.toFixed(3)}` : ''
          fade = fin + fout
        }
        parts.push(`[as${i}]atrim=start=${k.start}:end=${k.end},asetpts=PTS-STARTPTS${fade}[a${i}]`)
        aLabels.push(`[a${i}]`)
      }
    })

    const maps: string[] = []
    const useRes = settings && settings.width > 0 && settings.height > 0
    if (base.hasVideo) {
      if (useRes) {
        const W = even(settings!.width)
        const H = even(settings!.height)
        parts.push(`${vLabels.join('')}concat=n=${vLabels.length}:v=1:a=0[vcat]`)
        parts.push(
          `[vcat]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
            `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[vout]`
        )
      } else {
        parts.push(`${vLabels.join('')}concat=n=${vLabels.length}:v=1:a=0[vout]`)
      }
      maps.push('-map', '[vout]')
    }
    const buildMusic = (): void => {
      const gain = Math.max(0, music!.gain)
      const startAt = Math.max(0, music!.startAt)
      const stopAt = Math.min(music!.endAt ?? totalKept, totalKept)
      const need = Math.max(0.05, stopAt - startAt)
      let m = `[${musicIdx}:a]atrim=0:${need.toFixed(3)},asetpts=PTS-STARTPTS,volume=${gain.toFixed(3)}`
      if (startAt > 0.01) m += `,adelay=${Math.round(startAt * 1000)}:all=1`
      parts.push(`${m}[mus]`)
    }
    if (extraAudio.length === 0) {
      // Legacy path (unchanged): base voice (kept ranges) mixed with optional music.
      if (base.hasAudio || music) {
        if (base.hasAudio && music) {
          parts.push(`${aLabels.join('')}concat=n=${aLabels.length}:v=0:a=1[abase]`)
          buildMusic()
          parts.push('[abase][mus]amix=inputs=2:duration=first:normalize=0[aout]')
        } else if (music) {
          buildMusic()
          parts.push(`[mus]atrim=0:${totalKept.toFixed(3)},asetpts=PTS-STARTPTS[aout]`)
        } else {
          parts.push(`${aLabels.join('')}concat=n=${aLabels.length}:v=0:a=1[aout]`)
        }
        maps.push('-map', '[aout]')
      }
    } else {
      // Document mode: base voice + music + N audio lanes, amix'd. The FIRST mix
      // input is always edit-length (base voice, or a silent bed when the base is
      // fully muted) so `duration=first` can't let a short lane truncate the mix.
      const mixLabels: string[] = []
      if (base.hasAudio) {
        parts.push(`${aLabels.join('')}concat=n=${aLabels.length}:v=0:a=1[abase]`)
        mixLabels.push('[abase]')
      } else {
        parts.push(
          `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${totalKept.toFixed(3)},asetpts=PTS-STARTPTS[abed]`
        )
        mixLabels.push('[abed]')
      }
      if (music) {
        buildMusic()
        mixLabels.push('[mus]')
      }
      extraAudio.forEach((a, i) => {
        const inS = Math.max(0, a.in)
        const outS = Math.max(inS + 0.02, a.out)
        const gain = Math.max(0, a.gain ?? 1)
        const startAt = Math.max(0, a.startAt)
        let s = `[${extraAudioIdx[i]}:a]atrim=${inS.toFixed(3)}:${outS.toFixed(3)},asetpts=PTS-STARTPTS,volume=${gain.toFixed(3)}`
        if (startAt > 0.01) s += `,adelay=${Math.round(startAt * 1000)}:all=1`
        parts.push(`${s}[ex${i}]`)
        mixLabels.push(`[ex${i}]`)
      })
      if (mixLabels.length === 1) {
        parts.push(`${mixLabels[0]}atrim=0:${totalKept.toFixed(3)},asetpts=PTS-STARTPTS[aout]`)
      } else {
        parts.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:normalize=0[aout]`)
      }
      maps.push('-map', '[aout]')
    }

    const mbps = settings && settings.bitrateMbps > 0 ? settings.bitrateMbps : 0
    const rate =
      mbps > 0
        ? ['-b:v', `${mbps}M`, '-maxrate', `${(mbps * 1.45).toFixed(1)}M`, '-bufsize', `${(mbps * 2).toFixed(1)}M`]
        : ['-crf', '20']

    // Many cuts -> a huge trim/concat graph. Inline `-filter_complex` overruns the
    // OS command-line limit (spawn ENAMETOOLONG). Large graph -> write it to a temp
    // file and use `-filter_complex_script`; short graphs stay inline. (Sync write —
    // this runs inside a non-async Promise executor.)
    const fcMain = parts.join(';')
    let filterArg: string[] = ['-filter_complex', fcMain]
    let fcFileMain = ''
    if (fcMain.length > 6000) {
      fcFileMain = join(tmpdir(), `easecut-fc-${randomUUID()}.txt`)
      writeFileSync(fcFileMain, fcMain, 'utf8')
      filterArg = ['-filter_complex_script', fcFileMain]
    }
    const cleanFc = (): void => { if (fcFileMain) void rm(fcFileMain).catch(() => undefined) }
    const args = [
      '-y',
      ...inputs,
      ...filterArg,
      ...maps,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      ...rate,
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      outPath
    ]

    const proc = spawn(FFMPEG, args)
    let errBuf = ''
    proc.stderr.on('data', (c: Buffer) => {
      const s = c.toString()
      errBuf += s
      const m = s.match(/time=(\d+):(\d+):([\d.]+)/)
      if (m && onProgress && totalKept > 0) {
        const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
        onProgress(Math.min(99, Math.round((t / totalKept) * 100)))
      }
    })
      proc.on('error', (e) => { cleanFc(); reject(e) })
      proc.on('close', (code) => {
        cleanFc()
        if (code === 0) {
          onProgress?.(100)
          resolve(outPath)
        } else {
          reject(new Error(`ffmpeg export failed (${code}):\n${errBuf.slice(-2000)}`))
        }
      })
    })
  } finally {
    if (texts.length) await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
