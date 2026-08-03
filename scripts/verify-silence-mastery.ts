// Headless tests for the Silence Mastery engine (shared/silenceMastery.ts).
// Run: npx tsx scripts/verify-silence-mastery.ts
import {
  planSilenceMastery,
  planSilenceMasteryDetailed,
  frameRmsDb,
  rmsAutoThreshold,
  planRmsSilence,
  unionCutRegions,
  guardRegionEdgesOffWords,
  padTrimRegions,
  SILENCE_MASTERY_PRESETS,
  matchSilenceMasteryPreset,
  normalizeSilenceMastery,
  DEFAULT_SILENCE_MASTERY_SETTINGS,
  type SilenceMasterySettings,
  type SpeechSpan
} from '../src/shared/silenceMastery'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? '✓' : '✗ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const S = (p?: Partial<SilenceMasterySettings>): SilenceMasterySettings => ({
  ...DEFAULT_SILENCE_MASTERY_SETTINGS,
  ...p
})
const fmt = (rs: { start: number; end: number }[]): string =>
  rs.map((r) => `[${r.start.toFixed(2)},${r.end.toFixed(2)}]`).join(' ')
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9

console.log('1) the spec example — 15s video, words at 3–7 and 9–12')
{
  // "word 1 starts at 3 sec and word 5 ends at 7 sec" … "word 6 starts at 9,
  // word 10 ends at 12" → remove 0–3, 7–9, 12–15 (pads/trim zeroed for the
  // literal example).
  const words: SpeechSpan[] = [
    { start: 3, end: 4 }, { start: 4, end: 5 }, { start: 5, end: 6 }, { start: 6, end: 6.5 }, { start: 6.5, end: 7 },
    { start: 9, end: 10 }, { start: 10, end: 10.8 }, { start: 10.8, end: 11.3 }, { start: 11.3, end: 11.7 }, { start: 11.7, end: 12 }
  ]
  const cuts = planSilenceMastery(words, 15, S({ padLeftMs: 0, padRightMs: 0, trimEdgesMs: 0 }))
  check('exactly three cuts', cuts.length === 3, fmt(cuts))
  check('leading 0–3 removed', near(cuts[0].start, 0) && near(cuts[0].end, 3))
  check('gap 7–9 removed', near(cuts[1].start, 7) && near(cuts[1].end, 9))
  check('trailing 12–15 removed', near(cuts[2].start, 12) && near(cuts[2].end, 15))
  check('all cuts protect:true remove', cuts.every((c) => c.protect === true && c.action === 'remove'))
}

console.log('2) min silence gates gaps')
{
  const words: SpeechSpan[] = [{ start: 0, end: 1 }, { start: 1.3, end: 2 }, { start: 4, end: 5 }]
  const cuts = planSilenceMastery(words, 5, S({ minSilenceS: 0.5, padLeftMs: 0, padRightMs: 0 }))
  check('0.3s beat kept, 2s gap cut', cuts.length === 1 && near(cuts[0].start, 2) && near(cuts[0].end, 4), fmt(cuts))
  const none = planSilenceMastery(words, 5, S({ minSilenceS: 3, padLeftMs: 0, padRightMs: 0 }))
  check('min above every gap → nothing cut', none.length === 0)
}

console.log('3) pads keep silence at the gap edges')
{
  const words: SpeechSpan[] = [{ start: 0, end: 2 }, { start: 5, end: 7 }]
  const cuts = planSilenceMastery(words, 7, S({ padLeftMs: 200, padRightMs: 100, trimEdgesMs: 0 }))
  check('cut shrunk by padLeft on the left', cuts.length === 1 && near(cuts[0].start, 2.2), fmt(cuts))
  check('cut shrunk by padRight on the right', near(cuts[0].end, 4.9))
  // Pads bigger than the gap swallow the cut entirely.
  const tight: SpeechSpan[] = [{ start: 0, end: 2 }, { start: 2.6, end: 4 }]
  const gone = planSilenceMastery(tight, 4, S({ minSilenceS: 0.5, padLeftMs: 400, padRightMs: 400 }))
  check('pads ≥ gap → no cut', gone.length === 0, fmt(gone))
}

console.log('4) trim edges moves the cutter INTO the words (asymmetric)')
{
  const words: SpeechSpan[] = [{ start: 0, end: 2 }, { start: 5, end: 7 }]
  const cuts = planSilenceMastery(words, 7, S({ padLeftMs: 0, padRightMs: 0, trimLeftMs: 150, trimRightMs: 50 }))
  check('left edge bites 150ms into the ending word', cuts.length === 1 && near(cuts[0].start, 1.85), fmt(cuts))
  check('right edge bites 50ms into the starting word', near(cuts[0].end, 5.05))
  // Trim can never pass a word's midpoint, no matter the setting vs word size.
  const tiny: SpeechSpan[] = [{ start: 0, end: 0.2 }, { start: 3, end: 3.2 }]
  const clamped = planSilenceMastery(tiny, 3.2, S({ padLeftMs: 0, padRightMs: 0, trimLeftMs: 300, trimRightMs: 300 }))
  check('trim clamped at word midpoints', clamped.length === 1 && near(clamped[0].start, 0.1) && near(clamped[0].end, 3.1), fmt(clamped))
}

console.log('5) leading/trailing follow the same rules')
{
  const words: SpeechSpan[] = [{ start: 1, end: 2 }, { start: 2.2, end: 3 }]
  const cuts = planSilenceMastery(words, 10, S({ minSilenceS: 0.5, padLeftMs: 100, padRightMs: 100, trimEdgesMs: 0 }))
  check('leading cut starts at 0 (no left pad against nothing)', cuts.length === 2 && near(cuts[0].start, 0), fmt(cuts))
  check('leading cut keeps padRight before the first word', near(cuts[0].end, 0.9))
  check('trailing cut keeps padLeft after the last word', near(cuts[1].start, 3.1))
  check('trailing cut runs to the end of the media', near(cuts[1].end, 10))
  const shortLead: SpeechSpan[] = [{ start: 0.3, end: 2 }]
  const noLead = planSilenceMastery(shortLead, 2, S({ minSilenceS: 0.5 }))
  check('sub-threshold leading silence kept', noLead.length === 0, fmt(noLead))
}

console.log('6) degenerate inputs stay sane')
{
  check('no words → whole runtime cut', fmt(planSilenceMastery([], 8, S())) === '[0.00,8.00]')
  check('no words, short clip under min → nothing', planSilenceMastery([], 0.2, S()).length === 0)
  const overlap: SpeechSpan[] = [{ start: 1, end: 3 }, { start: 2, end: 4 }] // ASR overlap
  const oCuts = planSilenceMastery(overlap, 4.2, S({ minSilenceS: 0.1, padLeftMs: 0, padRightMs: 0 }))
  check('overlapping words → no phantom gap cut between them', !oCuts.some((c) => c.start >= 1 && c.end <= 4), fmt(oCuts))
  const junk = planSilenceMastery([{ start: NaN, end: 2 }, { start: 5, end: 5 }], 6, S({ padLeftMs: 0, padRightMs: 0 }))
  check('invalid words ignored (falls back to whole-runtime cut)', junk.length === 1 && near(junk[0].start, 0) && near(junk[0].end, 6), fmt(junk))
  const n = normalizeSilenceMastery({ minSilenceS: -4, padLeftMs: 1e9, trimLeftMs: NaN })
  check('normalize clamps garbage', n.minSilenceS === 0.05 && n.padLeftMs === 1000 && n.trimLeftMs === DEFAULT_SILENCE_MASTERY_SETTINGS.trimLeftMs)
  const legacy = normalizeSilenceMastery({ trimEdgesMs: 120 } as never)
  check('legacy symmetric trimEdgesMs feeds both sides', legacy.trimLeftMs === 120 && legacy.trimRightMs === 120)
}

console.log('7) ids are stable and ordered')
{
  const words: SpeechSpan[] = [{ start: 2, end: 3 }, { start: 6, end: 7 }]
  const cuts = planSilenceMastery(words, 10, S({ padLeftMs: 0, padRightMs: 0 }))
  check('ids sm0..smN in time order', cuts.map((c) => c.id).join(',') === 'sm0,sm1,sm2' && cuts.every((c, i) => i === 0 || c.start >= cuts[i - 1].end))
}

console.log('8) stretched-word clamp — the real Sova-script "Okay." case')
{
  // From production debug data: "again." ends 30.71, "Okay." stamped
  // 33.28–35.79 (2.51s for one word — the pause hidden INSIDE it), "Yeah,"
  // starts 35.84. Without the clamp only the 30.71→33.28 gap is cuttable.
  const words: SpeechSpan[] = [
    { start: 30.48, end: 30.71, text: 'again.' },
    { start: 33.28, end: 35.79, text: 'Okay.' },
    { start: 35.84, end: 36.03, text: 'Yeah,' },
    { start: 36.26, end: 36.37, text: 'there' },
    { start: 36.42, end: 36.55, text: 'is' },
    { start: 36.75, end: 36.99, text: 'no' },
    { start: 37.07, end: 37.41, text: 'shot.' }
  ]
  const on = planSilenceMastery(words, 38, S({ minSilenceS: 0.25, padLeftMs: 0, padRightMs: 0, trimEdgesMs: 0 }))
  const hidden = on.find((c) => c.start > 33.5 && c.end >= 35.8)
  check('hidden pause inside "Okay." exposed and cut', !!hidden, fmt(on))
  check('spoken core of "Okay." survives (cut starts after ~0.65s of speech)', !!hidden && hidden.start >= 33.9 && hidden.start <= 34.0, hidden ? hidden.start.toFixed(2) : 'none')
  const off = planSilenceMastery(words, 38, S({ minSilenceS: 0.25, padLeftMs: 0, padRightMs: 0, clampStretchedWords: false }))
  check('toggle OFF keeps the old verbatim behavior', !off.some((c) => c.start > 33.5 && c.start < 35.8), fmt(off))
  // A long word with a plausible duration is untouched.
  const normal: SpeechSpan[] = [{ start: 0, end: 1.1, text: 'appreciate' }, { start: 1.2, end: 1.5, text: 'it' }]
  check('plausible long word untouched', planSilenceMastery(normal, 1.5, S({ minSilenceS: 0.25, padLeftMs: 0, padRightMs: 0 })).length === 0)
  // Overlapping ASR (a word starting inside the span) suppresses the clamp.
  const overlapping: SpeechSpan[] = [
    { start: 0, end: 3, text: 'hey' },
    { start: 1.0, end: 1.4, text: 'there' },
    { start: 3.2, end: 3.6, text: 'friend' }
  ]
  const oc = planSilenceMastery(overlapping, 4, S({ minSilenceS: 0.25, padLeftMs: 0, padRightMs: 0 }))
  check('overlapped span not clamped', !oc.some((c) => c.start < 3 && c.end > 1.5), fmt(oc))
  const det = planSilenceMasteryDetailed(words, 38, S({ minSilenceS: 0.25 }))
  check('repairs reported for debug', det.stretched.length === 1 && det.stretched[0].text === 'Okay.' && det.stretched[0].exposedS > 1.5)
}

console.log('9) RMS energy pass — auto threshold + word guard')
{
  const F = 0.02 // 20ms frames
  // 10s clip: speech -20dB at 1.0–2.0s and 6.0–7.0s, room tone -55dB elsewhere.
  const frames: number[] = []
  for (let t = 0; t < 10; t += F) frames.push((t >= 1 && t < 2) || (t >= 6 && t < 7) ? -20 : -55)
  const th = rmsAutoThreshold(frames)
  check('auto threshold sits between floor and speech', th.usable && th.thresholdDb > th.floorDb && th.thresholdDb < th.speechDb, `floor=${th.floorDb} speech=${th.speechDb} thr=${th.thresholdDb}`)
  const words: SpeechSpan[] = [{ start: 1, end: 2, text: 'hello' }, { start: 6, end: 7, text: 'world' }]
  const r = planRmsSilence(frames, F, words, 10, 0.5)
  check('three silent stretches found (lead, middle, tail)', r.regions.length === 3, fmt(r.regions))
  check('word guard: cuts stop 100ms from word spans',
    r.regions.every((c) => words.every((w) => c.end <= w.start - 0.1 + 1e-6 || c.start >= w.end + 0.1 - 1e-6)), fmt(r.regions))
  // A low-energy dip INSIDE a word span (soft consonant) is protected.
  const dip = frames.slice()
  for (let t = 1.3; t < 1.5; t += F) dip[Math.floor(t / F)] = -55
  const rd = planRmsSilence(dip, F, words, 10, 0.15)
  check('low-energy dip inside a word is protected', !rd.regions.some((c) => c.start >= 0.9 && c.end <= 2.1), fmt(rd.regions))
  // Flat clip (no dynamic range) cuts nothing rather than everything.
  const flat = new Array(500).fill(-50)
  check('flat clip → unusable range → no cuts', planRmsSilence(flat, F, [], 10, 0.5).regions.length === 0)
  // frameRmsDb: silence vs full-scale sine frames.
  const sr = 16000
  const sig = new Array(sr).fill(0).map((_, i) => (i < sr / 2 ? 0 : Math.sin((i / sr) * 2 * Math.PI * 440)))
  const fdb = frameRmsDb(sig, sr)
  check('frameRmsDb: quiet half ≪ loud half', fdb[0] < -100 && fdb[fdb.length - 1] > -6, `${fdb[0].toFixed(0)} vs ${fdb[fdb.length - 1].toFixed(1)}`)
  // Union merges gap + rms lists and restamps ids.
  const u = unionCutRegions([[{ start: 0, end: 1 }, { start: 5, end: 6 }], [{ start: 0.9, end: 2 }]], 10)
  check('union merges overlapping cuts across passes', u.length === 2 && near(u[0].start, 0) && near(u[0].end, 2) && u[0].id === 'sm0' && u[1].id === 'sm1', fmt(u))
}

console.log('9b) defaults are Silero-only')
{
  const d = normalizeSilenceMastery(null)
  check('silero on, gap off, rms off by default', d.sileroPass === true && d.gapPass === false && d.rmsPass === false)
}

console.log('10) Silero edge guard — regions clamp off word spans')
{
  const words: SpeechSpan[] = [{ start: 2, end: 3, text: 'hello' }, { start: 8, end: 8.4, text: 'hi' }]
  // region end intrudes into a word's onset -> pulled back 100ms before it
  const a = guardRegionEdgesOffWords([{ start: 0, end: 2.4 }], words, 0.1)
  check('end clamped 100ms before the word onset', a.length === 1 && near(a[0].end, 1.9), fmt(a))
  // region start intrudes into a word's tail -> resumes 100ms after it
  const b = guardRegionEdgesOffWords([{ start: 2.6, end: 6 }], words, 0.1)
  check('start clamped 100ms after the word tail', b.length === 1 && near(b[0].start, 3.1), fmt(b))
  // a word ENTIRELY inside a silence region is trusted to the detector
  const c = guardRegionEdgesOffWords([{ start: 6, end: 10 }], words, 0.1)
  check('fully-covered word trusted to the ear (region intact)', c.length === 1 && near(c[0].start, 6) && near(c[0].end, 10), fmt(c))
  // a region fully INSIDE a word span collapses to nothing
  const d = guardRegionEdgesOffWords([{ start: 2.2, end: 2.8 }], words, 0.1)
  check('region inside a word span collapses', d.length === 0, fmt(d))
}

console.log('11) presets + Silero region shaping (padTrimRegions)')
{
  const byId = Object.fromEntries(SILENCE_MASTERY_PRESETS.map((p) => [p.id, p.values]))
  check('Natural Rhythm = 0.25 / 100 / 100 / 0 / 0',
    byId['natural-rhythm'].minSilenceS === 0.25 && byId['natural-rhythm'].padLeftMs === 100 && byId['natural-rhythm'].padRightMs === 100 && byId['natural-rhythm'].trimLeftMs === 0 && byId['natural-rhythm'].trimRightMs === 0)
  check('No Chill = 0.15 / 0 / 0 / 0 / 0',
    byId['no-chill'].minSilenceS === 0.15 && byId['no-chill'].padLeftMs === 0 && byId['no-chill'].padRightMs === 0 && byId['no-chill'].trimLeftMs === 0 && byId['no-chill'].trimRightMs === 0)
  check('Cut Throat = 0.15 / 0 / 0 / trimL 150 / trimR 50',
    byId['cut-throat'].minSilenceS === 0.15 && byId['cut-throat'].padLeftMs === 0 && byId['cut-throat'].padRightMs === 0 && byId['cut-throat'].trimLeftMs === 150 && byId['cut-throat'].trimRightMs === 50)
  check('preset matcher round-trips', matchSilenceMasteryPreset(S(byId['cut-throat'])) === 'cut-throat' && matchSilenceMasteryPreset(S({ minSilenceS: 0.33 })) === null)

  // Silero region shaping: [5,8] on a 20s clip.
  const nr = padTrimRegions([{ start: 5, end: 8 }], S(byId['natural-rhythm']), 20)
  check('Natural Rhythm keeps 100ms each side of the detected edges', nr.length === 1 && near(nr[0].start, 5.1) && near(nr[0].end, 7.9), fmt(nr))
  const nc = padTrimRegions([{ start: 5, end: 8 }], S(byId['no-chill']), 20)
  check('No Chill cuts flush to the detected edges', nc.length === 1 && near(nc[0].start, 5) && near(nc[0].end, 8), fmt(nc))
  const ct = padTrimRegions([{ start: 5, end: 8 }], S(byId['cut-throat']), 20)
  check('Cut Throat eats 150ms of the ending + 50ms of the next onset', ct.length === 1 && near(ct[0].start, 4.85) && near(ct[0].end, 8.05), fmt(ct))
  // Media boundaries: leading keeps 0, trailing keeps the end.
  const edges = padTrimRegions([{ start: 0, end: 3 }, { start: 18, end: 20 }], S(byId['natural-rhythm']), 20)
  check('leading cut pinned at 0, trailing at media end', edges.length === 2 && near(edges[0].start, 0) && near(edges[0].end, 2.9) && near(edges[1].start, 18.1) && near(edges[1].end, 20), fmt(edges))
  // Pads bigger than a small region swallow it.
  const gone = padTrimRegions([{ start: 5, end: 5.15 }], S(byId['natural-rhythm']), 20)
  check('pads ≥ region → dropped', gone.length === 0)
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall silence-mastery checks green')
process.exit(failures ? 1 : 0)
