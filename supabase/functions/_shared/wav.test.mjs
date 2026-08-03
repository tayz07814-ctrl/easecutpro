// Tests for the billing path's duration parser.
//   node --experimental-strip-types supabase/functions/_shared/wav.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { wavSeconds } from './wav.ts'

/** Build a RIFF/WAVE header the way src/renderer/src/cloud/audio.ts does. */
function wav({ rate = 16000, channels = 1, bits = 16, dataBytes = 32000, extraChunk = false } = {}) {
  const byteRate = (rate * channels * bits) / 8
  const chunks = extraChunk ? 26 : 0 // a LIST chunk between fmt and data
  const buf = new Uint8Array(44 + chunks + Math.min(dataBytes, 64))
  const dv = new DataView(buf.buffer)
  const put = (o, s) => [...s].forEach((c, i) => (buf[o + i] = c.charCodeAt(0)))

  put(0, 'RIFF'); dv.setUint32(4, 36 + dataBytes, true); put(8, 'WAVE')
  put(12, 'fmt '); dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)          // PCM
  dv.setUint16(22, channels, true)
  dv.setUint32(24, rate, true)
  dv.setUint32(28, byteRate, true)
  dv.setUint16(32, (channels * bits) / 8, true)
  dv.setUint16(34, bits, true)

  let off = 36
  if (extraChunk) {
    put(off, 'LIST'); dv.setUint32(off + 4, 18, true); off += 26
  }
  put(off, 'data'); dv.setUint32(off + 4, dataBytes, true)
  return { head: buf, total: off + 8 + dataBytes }
}

test('16 kHz mono 16-bit — the format the app actually uploads', () => {
  const { head, total } = wav({ dataBytes: 32000 })   // 32000 B/s -> 1.0 s
  assert.equal(wavSeconds(head, total), 1)
})

test('ten minutes of 16 kHz mono', () => {
  const { head, total } = wav({ dataBytes: 32000 * 600 })
  assert.equal(wavSeconds(head, total), 600)
})

test('rate/channel/depth come from the header, not an assumption', () => {
  const { head, total } = wav({ rate: 48000, channels: 2, bits: 16, dataBytes: 48000 * 2 * 2 * 5 })
  assert.equal(wavSeconds(head, total), 5)
})

test('skips unknown chunks to find data', () => {
  const { head, total } = wav({ dataBytes: 32000 * 3, extraChunk: true })
  assert.equal(wavSeconds(head, total), 3)
})

test('streamed WAV with a placeholder data size falls back to the object size', () => {
  const { head } = wav({ dataBytes: 32000 })
  new DataView(head.buffer).setUint32(40, 0xffffffff, true)
  assert.equal(wavSeconds(head, 44 + 32000 * 7), 7)
})

// --- refusals: every one of these must be null, never 0 and never a guess ----

test('not a WAV is a refusal, not a free pass', () => {
  const mp4 = new Uint8Array(64)
  ;[...'ftypisom'].forEach((c, i) => (mp4[4 + i] = c.charCodeAt(0)))
  assert.equal(wavSeconds(mp4, 5_000_000), null)
})

test('truncated header is a refusal', () => {
  assert.equal(wavSeconds(new Uint8Array(20), 5_000_000), null)
})

test('RIFF but not WAVE is a refusal', () => {
  const { head, total } = wav()
  ;[...'AVI '].forEach((c, i) => (head[8 + i] = c.charCodeAt(0)))
  assert.equal(wavSeconds(head, total), null)
})

test('zero byteRate cannot divide by zero into Infinity credits', () => {
  const { head, total } = wav()
  new DataView(head.buffer).setUint32(28, 0, true)
  assert.equal(wavSeconds(head, total), null)
})

test('a lying RIFF size does not shrink the bill — data chunk wins', () => {
  // Attacker rewrites the RIFF size to claim the file is tiny; the data chunk
  // and the real object size are what get billed.
  const { head, total } = wav({ dataBytes: 32000 * 120 })
  new DataView(head.buffer).setUint32(4, 8, true)
  assert.equal(wavSeconds(head, total), 120)
})
