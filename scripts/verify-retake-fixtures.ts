// Retake-Aware Cut Beta — FIXTURE regression harness.
//
// Every failed video becomes a replayable fixture: its raw AssemblyAI words
// (harvested from the run's debug JSON) + an expected-output file. This runs
// the PURE analyzer (rules only, NO network, NO LLM — deterministic) against
// each fixture and reports PASS/FAIL, missed cuts, unexpected large cuts and
// the pattern types detected. New failures are added as data, never as
// phrase-specific engine patches.
//
//   npm run verify-retake-aware-fixtures
//
// Fixture pair in test-fixtures/retake-aware/:
//   <name>.words.json     { provider, words: VerbatimWord[], clean_text, ... }
//   <name>.expected.json  see ExpectedSpec below
//
// The analyzer is pure and imported ONLY from src/shared/retakeaware — the
// standard engines (FastCut/ProCut) are never touched by this harness.

import { readdirSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  buildChunks,
  detectFillers,
  findRetakeGroups,
  extendProgressiveRetakes,
  detectFalseStarts,
  detectSelfCorrections,
  detectRepeatedSetups,
  detectOrphanConnectors,
  buildCutSpans
} from '../src/shared/retakeaware/analyze'
import type { VerbatimTranscript, CutSpan } from '../src/shared/retakeaware/types'

interface ExpectCut {
  /** text snippet that must fall INSIDE some final cut span. */
  text: string
  /** optional required span type. */
  type?: CutSpan['type']
}
interface ExpectedSpec {
  description: string
  /** the general pattern(s) this fixture exercises (documentation + assertion). */
  patterns: string[]
  /** snippets that MUST be covered by a cut span (rules-only). */
  expectCut: ExpectCut[]
  /** snippets that must NOT be covered by any cut span. */
  expectKeep: string[]
  /** span types / group candidate_types that must appear at least once. */
  expectPatternTypes?: string[]
  /** hard ceiling on any single cut span (seconds). Default 12. */
  maxSpanSeconds?: number
  /** snippets expected only as PROVISIONAL (LLM-gated) groups — present as a
   *  provisional group but NOT cut by rules alone. */
  expectProvisional?: string[]
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[—–]/g, ' ')
    .replace(/[^\w\s'$%]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

function coveredText(span: CutSpan, vt: VerbatimTranscript): string {
  return vt.words
    .filter((w) => {
      const mid = (w.start + w.end) / 2
      return mid >= span.start && mid <= span.end
    })
    .map((w) => w.word)
    .join(' ')
}

interface FixtureResult {
  name: string
  pass: boolean
  spanCount: number
  mappedWords: number
  patternsDetected: string[]
  missedCuts: string[]
  keepViolations: string[]
  missingPatternTypes: string[]
  oversizedSpans: string[]
  provisionalFailures: string[]
}

function runFixture(name: string, vt: VerbatimTranscript, exp: ExpectedSpec): FixtureResult {
  // PURE pipeline, rules only (LLM off) — provisional groups do NOT cut.
  const chunks = buildChunks(vt)
  const fillers = detectFillers(vt.words)
  const { groups } = findRetakeGroups(chunks, vt.words, fillers)
  extendProgressiveRetakes(chunks, groups, vt.words, fillers)
  const active = groups.filter((g) => !g.provisional && !g.llm_rejected)
  const falseStarts = detectFalseStarts(chunks, vt.words, active)
  const selfCorrections = detectSelfCorrections(chunks, vt.words)
  const repeatedSetups = detectRepeatedSetups(chunks, vt.words)
  const orphanConnectors = detectOrphanConnectors(chunks, vt.words)
  const spans = buildCutSpans(vt, groups, fillers, falseStarts, selfCorrections, repeatedSetups, orphanConnectors)

  const coveredNorm = spans.map((s) => ({ s, text: norm(coveredText(s, vt)) }))
  const allCoveredWords = coveredNorm.reduce((n, c) => n + c.text.split(' ').filter(Boolean).length, 0)

  const patternsDetected = Array.from(
    new Set([
      ...spans.map((s) => s.type),
      ...groups.filter((g) => !g.provisional && !g.llm_rejected).map((g) => `group:${g.candidate_type}`)
    ])
  ).sort()

  const missedCuts: string[] = []
  for (const c of exp.expectCut) {
    const want = norm(c.text)
    const hit = coveredNorm.some((cv) => cv.text.includes(want) && (!c.type || cv.s.type === c.type))
    if (!hit) missedCuts.push(c.type ? `${c.text} [${c.type}]` : c.text)
  }
  const keepViolations: string[] = []
  for (const k of exp.expectKeep) {
    const want = norm(k)
    if (coveredNorm.some((cv) => cv.text.includes(want))) keepViolations.push(k)
  }
  const missingPatternTypes: string[] = []
  for (const p of exp.expectPatternTypes ?? []) {
    if (!patternsDetected.includes(p) && !patternsDetected.includes(`group:${p}`)) missingPatternTypes.push(p)
  }
  const maxSpan = exp.maxSpanSeconds ?? 12
  const oversizedSpans = spans
    .filter((s) => s.end - s.start > maxSpan)
    .map((s) => `${(s.end - s.start).toFixed(1)}s [${s.type}] "${coveredText(s, vt).slice(0, 60)}…"`)

  const provisionalFailures: string[] = []
  for (const p of exp.expectProvisional ?? []) {
    const want = norm(p)
    const inProvisional = groups.some(
      (g) => g.provisional && g.attempts.some((a) => norm(a.text).includes(want))
    )
    const wrongfullyCut = coveredNorm.some((cv) => cv.text.includes(want))
    if (!inProvisional) provisionalFailures.push(`${p} — not surfaced as provisional`)
    else if (wrongfullyCut) provisionalFailures.push(`${p} — cut by RULES (should wait for LLM)`)
  }

  const pass =
    !missedCuts.length &&
    !keepViolations.length &&
    !missingPatternTypes.length &&
    !oversizedSpans.length &&
    !provisionalFailures.length

  return {
    name,
    pass,
    spanCount: spans.length,
    mappedWords: allCoveredWords,
    patternsDetected,
    missedCuts,
    keepViolations,
    missingPatternTypes,
    oversizedSpans,
    provisionalFailures
  }
}

// ---- run all fixtures ----
const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, '..', 'test-fixtures', 'retake-aware')
const names = readdirSync(dir)
  .filter((f) => f.endsWith('.words.json'))
  .map((f) => f.replace(/\.words\.json$/, ''))
  .sort()

if (!names.length) {
  console.error('No fixtures in test-fixtures/retake-aware/')
  process.exit(1)
}

let failures = 0
const line = (n: number): string => '─'.repeat(n)
console.log(`\nRetake-Aware Cut Beta — fixture regression (${names.length} fixtures, rules-only)\n${line(66)}`)

for (const name of names) {
  const vt = JSON.parse(readFileSync(join(dir, `${name}.words.json`), 'utf8')) as VerbatimTranscript
  let exp: ExpectedSpec
  try {
    exp = JSON.parse(readFileSync(join(dir, `${name}.expected.json`), 'utf8')) as ExpectedSpec
  } catch {
    console.log(`  ⚠ ${name}: no .expected.json — skipped (add expectations to lock it in)`)
    continue
  }
  const r = runFixture(name, vt, exp)
  if (!r.pass) failures++
  console.log(`\n${r.pass ? '✓ PASS' : '✗ FAIL'}  ${name}  —  ${exp.description}`)
  console.log(`        spans=${r.spanCount}  cut-words=${r.mappedWords}  patterns=[${r.patternsDetected.join(', ')}]`)
  if (r.missedCuts.length) console.log(`        MISSED expected cuts: ${r.missedCuts.map((s) => `"${s}"`).join(', ')}`)
  if (r.keepViolations.length) console.log(`        WRONGLY CUT (should keep): ${r.keepViolations.map((s) => `"${s}"`).join(', ')}`)
  if (r.missingPatternTypes.length) console.log(`        MISSING pattern types: ${r.missingPatternTypes.join(', ')}`)
  if (r.oversizedSpans.length) console.log(`        OVERSIZED cut spans: ${r.oversizedSpans.join('; ')}`)
  if (r.provisionalFailures.length) console.log(`        PROVISIONAL issues: ${r.provisionalFailures.join('; ')}`)
}

console.log(`\n${line(66)}`)
console.log('old engines untouched: this harness imports ONLY src/shared/retakeaware/* (FastCut/ProCut never loaded)')
console.log(failures ? `\n${failures}/${names.length} FIXTURE(S) FAILED\n` : `\nall ${names.length} fixtures PASS\n`)
process.exit(failures ? 1 : 0)
