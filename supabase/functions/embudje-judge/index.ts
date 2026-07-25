// EaseCutPro embudje-judge (easecut0.04): the EMBEDDING judge. Full transcript is

// embedded, near-duplicates clustered + production-chatter flagged, then a small LLM

// makes segment-level keep/cut decisions over the annotated transcript. Returns a

// word-index EDL ({raw}) shaped like ultracut-judge so the browser reuses validateEdl.

import { createClient } from 'npm:@supabase/supabase-js@2'

const BASE = Deno.env.get('ULTRACUT_BASE_URL') ?? 'https://openrouter.ai/api/v1'

const EMBED_MODEL = Deno.env.get('EMBUDJE_EMBED_MODEL') ?? 'gemini-embedding-2'

const PRIMARY = Deno.env.get('EMBUDJE_MODEL') ?? 'google/gemini-3.6-flash'

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }

function json(b: unknown, s = 200): Response { return new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } }) }

function admin() { return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!) }

async function requireUser(req: Request): Promise<boolean> {

  const auth = req.headers.get('Authorization') ?? ''

  const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } })

  const { data } = await anon.auth.getUser(); return !!data.user

}

async function getKey(): Promise<string> {

  const e = Deno.env.get('ULTRACUT_JUDGE_KEY') ?? Deno.env.get('OPEN_ROUTER_KEY')

  if (e) return e

  try { const { data } = await admin().rpc('delta_judge_key'); if (typeof data === 'string' && data) return data } catch { /* */ }

  return ''

}

function cosine(a: number[], b: number[]): number { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] } return d / ((Math.sqrt(na) * Math.sqrt(nb)) || 1) }

type Seg = { start: number; end: number; text: string }

function segmentize(words: { i: number; text: string }[]): Seg[] {

  const segs: Seg[] = []; let cur: { i: number; text: string }[] = []

  const clean = (t: string) => t.replace(/<[^>]+>/g, '').trim()

  for (const w of words) { cur.push(w); const t = clean(w.text); if (/[.?!]$/.test(t) || cur.length >= 22) { segs.push({ start: cur[0].i, end: cur[cur.length - 1].i, text: cur.map((x) => clean(x.text)).join(' ').trim() }); cur = [] } }

  if (cur.length) segs.push({ start: cur[0].i, end: cur[cur.length - 1].i, text: cur.map((x) => clean(x.text)).join(' ').trim() })

  return segs.filter((s) => s.text.length > 0)

}

const CH = ['you can start talking now', 'just leave the camera rolling', 'cut to the camera on the tripod recording', 'the touchscreen is being stupid', 'let me look up and say that again', 'wait are you ready to start', 'you shout off camera', 'should I look up at you', 'put a fast ticking timer on screen', 'freeze go back', 'pause it', 'what the heck I already said that, did I say that', 'let me do that take again', 'take two action', 'how much yapping you are doing', 'so wait but I have to say']

const CO = ['a normal sentence that is part of the actual video message', 'explaining what the product is and where to buy it', 'telling the viewer a genuine story or fact', 'describing a product feature', 'the main spoken line of the video']

const SYSTEM = `You edit a raw video transcript. REMOVE:

- RETAKES: the same thing said more than once. In each DUP group keep exactly ONE take — prefer the one marked KEEP (the last complete take), but if that one is buried in planning/chatter and an earlier take is clean, keep the clean one instead. Cut the rest of the group.

- PRODUCTION CHATTER: talking about the recording itself — camera/tripod/timer, "rolling", "cut to camera", "say that again", "freeze", crew directions, checking if ready, false starts, "I already said that", "how much yapping".

KEEP all unique content: the hook, the story, product info, the CTA. When unsure whether a line is unique content, KEEP it.



The transcript is pre-split into numbered SEGMENTS. Hints (advisory — verify with the text + context):

  DUP:g# = near-duplicate of others in that group. KEEP = the suggested survivor.

  ch=0.NN = higher means more likely production chatter.



Output VALID JSON ONLY and NOTHING ELSE, compact:

{"cut_segments":[ids to remove ENTIRELY],"partial_cuts":[{"from":word,"to":word,"reason":""}],"pause_cuts":[]}

Use partial_cuts ONLY when just part of a segment repeats. Do not output reasoning.`

function extractJson(raw: string): string { let t = raw.replace(/<think>[\s\S]*?<\/think>/gi, ''); t = t.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim(); const m = t.match(/\{[\s\S]*\}/); return (m ? m[0] : t).trim() }

async function callLLM(key: string, model: string, user: string, timeoutMs: number): Promise<{ ok: boolean; cutSegs: number[]; partial: { from: number; to: number; reason?: string }[] }> {

  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs)

  try {

    const r = await fetch(`${BASE}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'HTTP-Referer': 'https://easecutpro.com', 'X-Title': 'EaseCutPro embudje' }, body: JSON.stringify({ model, stream: false, max_tokens: 8000, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }] }), signal: ctrl.signal })

    clearTimeout(timer); const txt = await r.text(); if (!r.ok) return { ok: false, cutSegs: [], partial: [] }

    let content = ''; try { content = JSON.parse(txt).choices?.[0]?.message?.content ?? '' } catch { /* */ }

    const o = JSON.parse(extractJson(content))

    if (o && Array.isArray(o.cut_segments)) return { ok: true, cutSegs: o.cut_segments, partial: Array.isArray(o.partial_cuts) ? o.partial_cuts : [] }

    return { ok: false, cutSegs: [], partial: [] }

  } catch { clearTimeout(timer); return { ok: false, cutSegs: [], partial: [] } }

}

Deno.serve(async (req) => {

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {

    if (!(await requireUser(req))) return json({ error: 'Not signed in' }, 401)

    const { payload } = await req.json().catch(() => ({ payload: null }))

    if (typeof payload !== 'string' || !payload) return json({ error: 'missing payload' }, 400)

    const words: { i: number; text: string }[] = []

    for (const line of payload.split('\n')) { const mm = line.match(/^(\d+)\|(.*)$/); if (mm) words.push({ i: Number(mm[1]), text: mm[2] }) }

    if (!words.length) return json({ raw: JSON.stringify({ word_cuts: [], pause_cuts: [] }), judge: 'embudje:no-words' })

    const segs = segmentize(words)

    const key = await getKey(); if (!key) return json({ raw: null, judge: 'none' })

    const inputs = [...segs.map((s) => s.text), ...CH, ...CO]

    const er = await fetch(`${BASE}/embeddings`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: EMBED_MODEL, input: inputs }) })

    if (!er.ok) return json({ raw: null, judge: 'embudje:embed-failed' })

    const vecs: number[][] = JSON.parse(await er.text()).data.map((d: { embedding: number[] }) => d.embedding)

    const Sn = segs.length, chV = vecs.slice(Sn, Sn + CH.length), coV = vecs.slice(Sn + CH.length)

    const parent = segs.map((_, i) => i); const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }

    for (let a = 0; a < Sn; a++) for (let b = a + 1; b < Sn; b++) if (cosine(vecs[a], vecs[b]) >= 0.82) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb }

    const groups: Record<number, number[]> = {}; for (let i = 0; i < Sn; i++) { const r = find(i); (groups[r] = groups[r] || []).push(i) }

    const gid: Record<number, number> = {}; const keep: Record<number, boolean> = {}; let gc = 0

    for (const k of Object.keys(groups)) { const g = groups[+k]; if (g.length > 1) { gc++; for (const i of g) gid[i] = gc; const last = g.reduce((m, i) => (segs[i].start > segs[m].start ? i : m), g[0]); keep[last] = true } }

    const lines = segs.map((s, i) => {

      const simCh = Math.max(...chV.map((c) => cosine(vecs[i], c))); const simCo = Math.max(...coV.map((c) => cosine(vecs[i], c)))

      const tags: string[] = []

      if (gid[i]) tags.push('DUP:g' + gid[i] + (keep[i] ? ' KEEP' : ''))

      if (simCh - simCo >= 0.05) tags.push('ch=' + simCh.toFixed(2))

      return `[${i}] w${s.start}-${s.end} "${s.text}"${tags.length ? '  {' + tags.join(' ') + '}' : ''}`

    })

    const user = 'SEGMENTS:\n' + lines.join('\n')

    let out = await callLLM(key, PRIMARY, user, 100000)

    if (!out.ok) out = await callLLM(key, FALLBACK, user, 30000)

    if (!out.ok) return json({ raw: null, judge: 'embudje:llm-failed' })

    const wc: { from: number; to: number; reason: string }[] = []

    for (const id of out.cutSegs) { const s = segs[id]; if (s) wc.push({ from: s.start, to: s.end, reason: 'retake/chatter' }) }

    for (const p of out.partial) { if (Number.isFinite(p.from) && Number.isFinite(p.to)) wc.push({ from: p.from, to: p.to, reason: p.reason || 'partial retake' }) }

    return json({ raw: JSON.stringify({ word_cuts: wc, pause_cuts: [] }), judge: 'embudje:' + PRIMARY })

  } catch (e) { return json({ error: (e as Error).message }, 500) }

}) 

