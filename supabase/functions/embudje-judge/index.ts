// EaseCutPro embudje-judge (easecut0.05): Micro-decision architecture.
// Segments by punctuation/length -> Local Window Cosine (≥0.95) -> Regex Chatter -> Micro LLM Prompt.
// Returns word-index EDL.
// Primary model google/gemini-3.6-flash; falls back to deepseek-v3.2-exp so it never hangs.
import { createClient } from 'npm:@supabase/supabase-js@2'

const BASE = Deno.env.get('ULTRACUT_BASE_URL') ?? 'https://openrouter.ai/api/v1'
const EMBED_MODEL = Deno.env.get('EMBUDJE_EMBED_MODEL') ?? 'gemini-embedding-2'

const PRIMARY = Deno.env.get('EMBUDJE_MODEL') ?? 'google/gemini-3.6-flash'

// Configuration for new architecture
const SIMILARITY_THRESHOLD = 0.95;
const LOOKAHEAD_WINDOW = 8; // Only compare a segment to the next 8 segments

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

function cosine(a: number[], b: number[]): number { 
  let d = 0, na = 0, nb = 0; 
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] } 
  return d / ((Math.sqrt(na) * Math.sqrt(nb)) || 1) 
}

type Seg = { id: number; start: number; end: number; text: string }

// 1. Improved Segmentation: Prioritizes punctuation and natural boundaries
function segmentize(words: { i: number; text: string }[]): Seg[] {
  const segs: Seg[] = []; 
  let cur: { i: number; text: string }[] = [];
  let segId = 0;
  
  const clean = (t: string) => t.replace(/<[^>]+>/g, '').trim();
  
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    cur.push(w);
    const t = clean(w.text);
    
    // Break on sentence endings, natural pauses (comma/dash if chunk is getting long), or max fallback limit
    const isEnd = /[.?!]$/.test(t);
    const isSoftPause = /[,-]$/.test(t) && cur.length > 15;
    const isTooLong = cur.length >= 35; 
    
    if (isEnd || isSoftPause || isTooLong || i === words.length - 1) {
      const text = cur.map((x) => clean(x.text)).join(' ').trim();
      if (text.length > 0) {
        segs.push({ id: segId++, start: cur[0].i, end: cur[cur.length - 1].i, text });
      }
      cur = [];
    }
  }
  return segs;
}

// 2. Deterministic Chatter Detection
const CHATTER_REGEX = /\b(take (one|two|three|\d)|say that again|cut that|clip it|rolling|action|let me (do|try|say) that|forgot to say|is it recording|camera on|freeze|go back|yapping|stupid)\b/i;

const SYSTEM_PROMPT = `You are a micro-decision engine for a video editor. 
Your job is to review short snippets of a transcript and identify exactly which segment IDs to CUT.

RULES FOR CUTTING:
1. RETAKES (Pairs): If two segments are variations of the same line, KEEP the one that flows best or seems like the final complete thought. CUT the mistake/abandoned take. If they are completely distinct ideas, cut neither.
2. CHATTER: Cut segments that are production chatter (e.g., talking to the camera, false starts, "say that again"). Keep it if it's part of the actual video content.

Output VALID JSON ONLY matching this schema:
{"cuts": [list of segment IDs to remove]}`;

async function callMicroLLM(key: string, model: string, userPrompt: string, timeoutMs: number): Promise<number[] | null> {
  const ctrl = new AbortController(); 
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const body = JSON.stringify({ 
      model, 
      stream: false, 
      temperature: 0.0, // Force deterministic output
      response_format: { type: "json_object" }, // Enforce JSON mode
      max_tokens: 1500, 
      reasoning: {
        effort: "none" // Disables reasoning entirely to ensure speed
      },
      messages: [
        { 
          role: 'system', 
          content: SYSTEM_PROMPT + "\n\nDo not output any reasoning, thinking process, or explanation. Output ONLY the raw JSON object." 
        }, 
        { 
          role: 'user', 
          content: userPrompt 
        }
      ] 
    });

    const r = await fetch(`${BASE}/chat/completions`, { 
      method: 'POST', 
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'HTTP-Referer': 'https://easecutpro.com', 'X-Title': 'EaseCutPro embudje' }, 
      body, 
      signal: ctrl.signal 
    });
    
    clearTimeout(timer); 
    const txt = await r.text(); 
    if (!r.ok) return null;
    
    let content = ''; 
    try { content = JSON.parse(txt).choices?.[0]?.message?.content ?? '' } catch { return null; }
    
    const o = JSON.parse(content.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim());
    return Array.isArray(o.cuts) ? o.cuts : [];
  } catch { 
    clearTimeout(timer); 
    return null; 
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    if (!(await requireUser(req))) return json({ error: 'Not signed in' }, 401)
    const { payload } = await req.json().catch(() => ({ payload: null }))
    if (typeof payload !== 'string' || !payload) return json({ error: 'missing payload' }, 400)
    
    const words: { i: number; text: string }[] = []
    for (const line of payload.split('\n')) { 
      const mm = line.match(/^(\d+)\|(.*)$/); 
      if (mm) words.push({ i: Number(mm[1]), text: mm[2] }) 
    }
    
    if (!words.length) return json({ raw: JSON.stringify({ word_cuts: [], pause_cuts: [] }), judge: 'embudje:no-words' })
    
    const segs = segmentize(words)
    const key = await getKey(); if (!key) return json({ raw: null, judge: 'none' })
    
    // Get Embeddings
    const er = await fetch(`${BASE}/embeddings`, { 
      method: 'POST', 
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, 
      body: JSON.stringify({ model: EMBED_MODEL, input: segs.map((s) => s.text) }) 
    });
    if (!er.ok) return json({ raw: null, judge: 'embudje:embed-failed' })
    
    const vecs: number[][] = JSON.parse(await er.text()).data.map((d: { embedding: number[] }) => d.embedding)
    
    // 3. Extract Micro-Decisions Candidates
    const candidates: string[] = [];
    
    // A. Rolling Window Duplicate Detection
    const processedPairs = new Set<string>();
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < Math.min(i + 1 + LOOKAHEAD_WINDOW, segs.length); j++) {
        if (cosine(vecs[i], vecs[j]) >= SIMILARITY_THRESHOLD) {
          const ctxBefore = i > 0 ? segs[i-1].text : "";
          const ctxAfter = j < segs.length - 1 ? segs[j+1].text : "";
          candidates.push(
            `[RETAKE PAIR]\n` +
            (ctxBefore ? `Context Before: "${ctxBefore}"\n` : '') +
            `Option A (ID: ${segs[i].id}): "${segs[i].text}"\n` +
            `Option B (ID: ${segs[j].id}): "${segs[j].text}"\n` +
            (ctxAfter ? `Context After: "${ctxAfter}"\n` : '')
          );
          processedPairs.add(`${i}-${j}`);
        }
      }
    }

    // B. Deterministic Chatter Detection
    for (let i = 0; i < segs.length; i++) {
      if (CHATTER_REGEX.test(segs[i].text)) {
        const ctxBefore = i > 0 ? segs[i-1].text : "";
        const ctxAfter = i < segs.length - 1 ? segs[i+1].text : "";
        candidates.push(
          `[POTENTIAL CHATTER]\n` +
          (ctxBefore ? `Context Before: "${ctxBefore}"\n` : '') +
          `Target (ID: ${segs[i].id}): "${segs[i].text}"\n` +
          (ctxAfter ? `Context After: "${ctxAfter}"\n` : '')
        );
      }
    }

    // 4. LLM Verification Pass (Skip if no candidates found)
    let cutIds: number[] = [];
    if (candidates.length > 0) {
      const userPrompt = "Review these candidates and decide which segment IDs to cut.\n\n" + candidates.join('\n\n');
      
      let out = await callMicroLLM(key, PRIMARY, userPrompt, 20000)
      if (!out) out = await callMicroLLM(key, FALLBACK, userPrompt, 20000)
      if (!out) return json({ raw: null, judge: 'embudje:llm-failed' })
      
      cutIds = out;
    }

    // 5. Build Word-Index EDL
    const wc: { from: number; to: number; reason: string }[] = []
    const cutSet = new Set(cutIds);
    
    for (const s of segs) {
      if (cutSet.has(s.id)) {
        wc.push({ from: s.start, to: s.end, reason: 'retake/chatter' })
      }
    }

    return json({ raw: JSON.stringify({ word_cuts: wc, pause_cuts: [] }), judge: 'embudje:' + PRIMARY })
  } catch (e) { 
    return json({ error: (e as Error).message }, 500) 
  }
});
