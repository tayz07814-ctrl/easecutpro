import { readFileSync } from 'node:fs'
import {
  DEFAULT_RETAKE_FINAL_BOSS_SETTINGS,
  buildFinalBossVerbatimPayload,
  normalizeRetakeFinalBossSettings,
  planFinalBossSilenceCuts,
  validateFinalBossWordCuts
} from '@shared/retakefinalboss'

let okay = true
function check(label: string, condition: boolean): void {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}`)
  if (!condition) okay = false
}

console.log('1) Gemma receives only indexed verbatim words')
const words = [
  { word: 'I', start: 0, end: 0.2, confidence: 0.99 },
  { word: 'I', start: 0.3, end: 0.5, confidence: 0.8 },
  { word: 'finished.', start: 0.6, end: 1, confidence: 0.95 }
]
const payload = buildFinalBossVerbatimPayload(words)
check('payload contains every word in immutable index order', payload.endsWith('0|I\n1|I\n2|finished.'))
check('payload contains no timestamps', !/\b(start|end|time|ms)\b/i.test(payload))
check('payload contains no confidence or utterance metadata', !/confidence|utterance/i.test(payload))
check('payload contains no predicted boundary metadata', !/pause|incomplete|vad|filler|stutter/i.test(payload))

console.log('2) word-only EDL validation')
const cuts = validateFinalBossWordCuts('{"word_cuts":[{"from":1,"to":2,"reason":"redo"}],"pause_cuts":[{"pause_id":"p1"}]}', 5)
check('word cut is accepted', cuts?.length === 1 && cuts[0].from === 1 && cuts[0].to === 2)
check('pause decisions never enter the result', cuts != null && !('pause_cuts' in cuts))
check('overlapping/adjacent word cuts merge', validateFinalBossWordCuts('{"word_cuts":[{"from":1,"to":2},{"from":3,"to":4}]}', 8)?.length === 1)
check('runaway whole-transcript deletion is rejected', validateFinalBossWordCuts('{"word_cuts":[{"from":0,"to":19}]}', 20) === null)

console.log('3) dedicated settings normalization')
const normalized = normalizeRetakeFinalBossSettings({ speechThreshold: 2, padBeforeS: -1, padAfterS: 0.2, trimEdgesS: 5, audioOverlapMs: 100 })
check('speech threshold clamps to 0..1', normalized.speechThreshold === 1)
check('paddings, trim, and overlap use Final Boss bounds', normalized.padBeforeS === 0 && normalized.padAfterS === 0.2 && normalized.trimEdgesS === 0.2 && normalized.audioOverlapMs === 60)
check('defaults expose only the five Final Boss controls', Object.keys(DEFAULT_RETAKE_FINAL_BOSS_SETTINGS).sort().join(',') === ['audioOverlapMs', 'padAfterS', 'padBeforeS', 'speechThreshold', 'trimEdgesS'].sort().join(','))

console.log('4) fresh Final Boss silence planner')
const settings = { ...DEFAULT_RETAKE_FINAL_BOSS_SETTINGS, padAfterS: 0.12, padBeforeS: 0.18, trimEdgesS: 0.02 }
const speech = [{ word: 'Done.', start: 0, end: 0.5 }, { word: 'Next', start: 2, end: 2.5 }]
const planned = planFinalBossSilenceCuts([{ start: 0.5, end: 2 }], speech, settings, 3)
check('one protected cut is produced', planned.length === 1 && planned[0].protect === true && planned[0].action === 'remove')
check('padding and edge trim produce exact independent geometry', Math.abs(planned[0].start - 0.6) < 1e-9 && Math.abs(planned[0].end - 1.84) < 1e-9)
const oversized = planFinalBossSilenceCuts([{ start: 0, end: 3 }], speech, settings, 3)
check('whole-clip VAD miss is carved while short edge rhythm stays', oversized.length === 1)
check('carved cuts never enter surviving words', oversized.every((cut) => speech.every((word) => cut.end <= word.start || cut.start >= word.end)))
check('candidate fully inside a surviving word is rejected', planFinalBossSilenceCuts([{ start: 0.1, end: 0.4 }], speech, settings, 3).length === 0)
check('candidate with no transcript context is rejected', planFinalBossSilenceCuts([{ start: 0, end: 3 }], [], settings, 3).length === 0)
const rhythm = [{ word: 'I', start: 0, end: 0.2 }, { word: 'think', start: 0.7, end: 1 }]
check('short mid-sentence rhythm is preserved', planFinalBossSilenceCuts([{ start: 0.2, end: 0.7 }], rhythm, settings, 1).length === 0)
const sentencePause = [{ word: 'Done.', start: 0, end: 0.2 }, { word: 'Next', start: 0.7, end: 1 }]
check('short silence at a sentence boundary is tightened', planFinalBossSilenceCuts([{ start: 0.2, end: 0.7 }], sentencePause, settings, 1).length === 1)
const longPause = [{ word: 'I', start: 0, end: 0.2 }, { word: 'think', start: 1.2, end: 1.5 }]
check('long background-noise gap is tightened without punctuation', planFinalBossSilenceCuts([{ start: 0.2, end: 1.2 }], longPause, settings, 1.5).length === 1)

console.log('5) edge prompt contains no silence-boundary instructions')
const edge = readFileSync(new URL('../supabase/functions/retakefinalboss/index.ts', import.meta.url), 'utf8')
const system = edge.match(/const SYSTEM = `([\s\S]*?)`\n\nasync function requireUser/)?.[1] ?? ''
check('Final Boss system prompt was located', system.length > 1000)
check('system prompt never mentions predicted silence data', !/pause|incomplete sentence|VAD|keep_ms|pause_cuts/i.test(system))
check('system output contract contains only word_cuts', system.includes('"word_cuts"') && !system.includes('"pause_cuts"'))

console.log('6) edge uses only OpenRouter Gemma 4')
check('OpenRouter chat-completions endpoint is fixed', edge.includes("const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'"))
check('OpenRouter Gemma 4 31B model id is fixed', edge.includes("const MODEL = 'google/gemma-4-31b-it'"))
check('OpenRouter secret is used with the existing vault fallback', edge.includes("Deno.env.get('OPEN_ROUTER_KEY')") && edge.includes("admin().rpc('delta_judge_key')"))
check('Cerebras transport is absent', !/api\.cerebras\.ai|CEREBRAS_API_KEY|X-Cerebras-Version-Patch/.test(edge))

console.log('7) engine is isolated from previous Retake silence logic')
const engine = readFileSync(new URL('../src/renderer/src/cloud/retakeFinalBossEngine.ts', import.meta.url), 'utf8')
const vad = readFileSync(new URL('../src/renderer/src/cloud/retakeFinalBossVad.ts', import.meta.url), 'utf8')
check('engine never imports the old Retake engine or timestamp-map payload', !/retakeEngine|buildTimestampMap|buildAiPayload|detectArtifacts|retakeBetaVadSafetyOpts/.test(engine))
check('Final Boss VAD never imports an old silence planner or settings profile', !/retakeSilenceCutter|retakesilence|vadsilence|vadSilenceRegions|clampSilenceRegions/.test(vad))

console.log(okay ? '\nRETAKE FINAL BOSS OK' : '\nRETAKE FINAL BOSS FAILED')
process.exit(okay ? 0 : 1)
