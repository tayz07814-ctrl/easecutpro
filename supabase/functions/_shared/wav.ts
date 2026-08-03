// Measuring a WAV from its own bytes. No imports on purpose: this is the one
// piece of the billing path that decides HOW MANY SECONDS a caller is charged
// for, so it stays pure and directly testable (see wav.test.mjs).

/** Seconds of audio in a RIFF/WAVE object, read from the object's OWN header so
 *  the client never gets a say in how many seconds it is billed for.
 *
 *  Returns null for anything that isn't a WAV we can measure, and callers treat
 *  null as a refusal. The app only ever uploads 16 kHz mono WAV
 *  (src/renderer/src/cloud/audio.ts is the single producer), so a non-WAV object
 *  is either a bug or someone hand-rolling requests — neither should transcribe. */
export function wavSeconds(head: Uint8Array, totalBytes: number): number | null {
  if (head.length < 44) return null
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const tag = (o: number): string =>
    String.fromCharCode(head[o], head[o + 1], head[o + 2], head[o + 3])
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null

  let off = 12
  let byteRate = 0
  while (off + 8 <= head.length) {
    const id = tag(off)
    const size = dv.getUint32(off + 4, true)
    if (id === 'fmt ' && off + 20 <= head.length) {
      // fmt chunk data starts at off+8: format(2) channels(2) sampleRate(4)
      // byteRate(4) ... so byteRate sits at off+16. It already folds in
      // rate x channels x bit depth, which is why we read it rather than
      // recomputing from the parts.
      byteRate = dv.getUint32(off + 16, true)
    } else if (id === 'data') {
      // Streamed WAVs write a placeholder size; fall back to what's actually there.
      const dataBytes =
        size > 0 && size !== 0xffffffff ? size : Math.max(0, totalBytes - (off + 8))
      return byteRate > 0 ? dataBytes / byteRate : null
    }
    if (size <= 0) break
    off += 8 + size + (size % 2) // chunks are word-aligned
  }
  // fmt seen but the data chunk sits past the bytes we read: measure the rest
  // of the object.
  return byteRate > 0 ? Math.max(0, totalBytes - 44) / byteRate : null
}
