// Export frame source — demux + WebCodecs VideoDecoder, via Mediabunny.
//
// The exporter used to pull its source frames out of hidden <video> elements:
// play a segment at the clip's own speed and capture presented frames, or seek
// once per output frame. Both are pinned to the media clock — a 10-minute
// timeline cost 10 minutes of wall clock no matter how fast the machine could
// decode, which is the whole gap against CapCut/Premiere/Resolve. They demux the
// file and run the decoder flat out; nothing about an export needs playback.
//
// Mediabunny's `samplesAtTimestamps` is exactly that pipeline: hand it the
// source timestamps for a segment's output frames in order and it walks the
// packets once, decoding each at most once, and yields the frame for every
// timestamp. No seeking, no realtime, no dropped-frame guesswork — and it is
// frame-EXACT by construction, where the play-harvest had to police itself with
// a tolerance check and fall back to seeking whenever the device dropped one.
//
// Returns null when a source can't be demuxed or its codec can't be decoded
// here, and the caller keeps its <video> path for that source — so an exotic
// container still exports, just at the old speed.

import { isWebMediaId, getFile } from '../webmedia'

const dbg = (...a: unknown[]): void => console.log('[ondevice-dec]', ...a)

export interface DecodeSource {
  /** Track display size (rotation applied) — stands in for videoWidth/Height. */
  width: number
  height: number
  /**
   * One frame per requested timestamp, in order. `timestamps` MUST be
   * non-decreasing; yields null only where the track has no frame at all (a
   * timestamp before its first). The consumer owns each VideoFrame and must
   * close (or transfer) it.
   */
  framesAt(timestamps: number[]): AsyncGenerator<VideoFrame | null, void, unknown>
  close(): void
}

/** Cheapest byte source Mediabunny can read this media through. */
async function sourceFor(mb: any, src: string, url: string): Promise<unknown | null> {
  // Web media is already a File in IndexedDB — read ranges straight out of it.
  if (isWebMediaId(src)) {
    try {
      const f = await getFile(src)
      if (f) return new mb.BlobSource(f)
    } catch {
      /* fall through to the URL forms */
    }
  }
  // A blob: URL is in memory already, so materialising it costs nothing extra.
  if (url.startsWith('blob:')) {
    try {
      return new mb.BlobSource(await (await fetch(url)).blob())
    } catch {
      return null
    }
  }
  // http(s)/custom protocol: range requests, so a big file is never fully read.
  try {
    return new mb.UrlSource(url)
  } catch {
    return null
  }
}

export async function openDecodeSource(src: string, url: string): Promise<DecodeSource | null> {
  let input: any = null
  try {
    const mb: any = await import('mediabunny')
    const source = await sourceFor(mb, src, url)
    if (!source) return null
    input = new mb.Input({ source, formats: mb.ALL_FORMATS })
    const track = await input.getPrimaryVideoTrack()
    if (!track) return null
    if (!(await track.canDecode())) {
      dbg('codec not decodable here', track.codec)
      return null
    }
    const sink = new mb.VideoSampleSink(track)
    const width = track.displayWidth || track.codedWidth || 0
    const height = track.displayHeight || track.codedHeight || 0
    const held = input
    return {
      width,
      height,
      async *framesAt(timestamps: number[]) {
        if (!timestamps.length) return
        for await (const sample of sink.samplesAtTimestamps(timestamps)) {
          if (!sample) {
            // A missing sample is not a harmless placeholder for export. It means
            // the requested timestamp could not be resolved from the decoded
            // stream, and the caller must fail rather than duplicate a stale frame.
            yield null
            continue
          }
          // Close the SAMPLE only once the consumer has finished with the frame
          // it handed back (finally runs when the generator resumes past the
          // yield, or when the consumer abandons the iterator early).
          try {
            yield sample.toVideoFrame()
          } finally {
            sample.close()
          }
        }
      },
      close() {
        try {
          held.dispose?.()
        } catch {
          /* already gone */
        }
      }
    }
  } catch (e) {
    dbg('cannot demux — falling back to the element path', (e as Error)?.message)
    try {
      input?.dispose?.()
    } catch {
      /* ignore */
    }
    return null
  }
}
