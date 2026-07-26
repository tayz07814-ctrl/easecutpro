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
const normalized = normalizeRetakeFinalBossSettings({ padBeforeS: -1, padAfterS: 0.2, trimEdgesS: 5, audioOverlapMs: 100 })
check('paddings, trim, and overlap use Final Boss bounds', normalized.padBeforeS === 0 && normalized.padAfterS === 0.2 && normalized.trimEdgesS === 0.2 && normalized.audioOverlapMs === 60)
check('defaults expose only cut geometry controls', Object.keys(DEFAULT_RETAKE_FINAL_BOSS_SETTINGS).sort().join(',') === ['audioOverlapMs', 'padAfterS', 'padBeforeS', 'trimEdgesS'].sort().join(','))

console.log('4) fresh Final Boss silence planner')
const settings = { ...DEFAULT_RETAKE_FINAL_BOSS_SETTINGS, padAfterS: 0.12, padBeforeS: 0.18, trimEdgesS: 0.02 }
const planned = planFinalBossSilenceCuts([{ start: 0.5, end: 2 }], settings, 3)
check('one protected cut is produced', planned.length === 1 && planned[0].protect === true && planned[0].action === 'remove')
check('padding and edge trim produce exact independent geometry', Math.abs(planned[0].start - 0.6) < 1e-9 && Math.abs(planned[0].end - 1.84) < 1e-9)
const oversized = planFinalBossSilenceCuts([{ start: 0, end: 3 }], settings, 3)
check('raw FSMN gap is accepted without transcript carving', oversized.length === 1)
check('planner source contains no transcript or sentence rules', !/survivingWords|sentenceBoundary|carveWords/.test(readFileSync(new URL('../src/shared/retakefinalboss.ts', import.meta.url), 'utf8')))

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
const fsmn = readFileSync(new URL('../src/renderer/src/cloud/fsmnVad.ts', import.meta.url), 'utf8')
check('engine never imports the old Retake engine or timestamp-map payload', !/retakeEngine|buildTimestampMap|buildAiPayload|detectArtifacts|retakeBetaVadSafetyOpts/.test(engine))
check('Final Boss VAD never imports an old silence planner or settings profile', !/retakeSilenceCutter|retakesilence|vadsilence|vadSilenceRegions|clampSilenceRegions/.test(vad))
check('Final Boss uses FunASR FSMN-VAD, not Silero', /detectFsmnSilences/.test(vad) && !/detectSilenceFloat32|vad-web|silero/i.test(vad))
check('FSMN runtime supplies fbank, LFR, CMVN and recurrent caches', /fbankLfrCmvn/.test(fsmn) && /LFR_M = 5/.test(fsmn) && /parseCmvn/.test(fsmn) && /in_cache/.test(fsmn))
check('FSMN runtime uses the published default decision threshold', /OFFICIAL_SPEECH_THRESHOLD = 0\.8/.test(fsmn) && !/speechThreshold/.test(fsmn))

console.log('8) Silence Only is a local FSMN-only action')
const silenceOnly = readFileSync(new URL('../src/renderer/src/cloud/retakeFinalBossSilenceOnly.ts', import.meta.url), 'utf8')
const silenceOnlyImports = [...silenceOnly.matchAll(/^import .*$/gm)].map((match) => match[0]).join('\n')
const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')
const silenceOnlyAction = store.match(/runRetakeSilenceOnly: async \(\) => \{([\s\S]*?)\n  \},\n\n  _parakeetTranscribe/)?.[1] ?? ''
check('standalone action source was located', silenceOnlyAction.length > 1000)
check('standalone module calls audio decode and Final Boss FSMN VAD', /decodeAudioFloat32/.test(silenceOnly) && /detectRetakeFinalBossSilences/.test(silenceOnly))
check('standalone module imports no STT, judge, provider, or Retake engine', !/stt|assembly|gemma|judge|retakeFinalBossEngine|invokeEdge/i.test(silenceOnlyImports))
check('standalone store action never calls the full Retake pipeline', !/retakeAwareCut|runRetakeCutBeta|transcribe|invokeEdge/i.test(silenceOnlyAction))
check('standalone results clear pending word cuts and stage FSMN gaps for Execute', /selectedWordIds: new Set<string>\(\)/.test(silenceOnlyAction) && /retakeSilenceStaged: true/.test(silenceOnlyAction))

console.log(okay ? '\nRETAKE FINAL BOSS OK' : '\nRETAKE FINAL BOSS FAILED')
process.exit(okay ? 0 : 1)
