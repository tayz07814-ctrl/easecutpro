# EaseCutPro — Cloud version (Vercel + Supabase)

The cloud build is a **static SPA on Vercel** with **Supabase** as the entire
backend — no PC server, no tunnel, a permanent URL. This is the architecture
going forward, including the future iOS/Android apps (same Supabase project,
same client layer).

```
   Browser / future mobile app
        │ static app         https://easecutpro.vercel.app  (or your domain)
        ▼
   Vercel (CDN)  — just files; nothing runs here
        │
        ▼
   Supabase ──── Auth (email+password accounts, profiles)
            ──── Postgres (projects JSONB + transcript, user settings; RLS owner-only)
            ──── Edge functions: stt (AssemblyAI→Deepgram proxy + temp audio bucket),
                 llm-judge (Retake β reviewer: Claude Haiku → gpt-4o-mini)
```

**What stays on the device (by design):** the video itself. Media lives in the
browser (IndexedDB), preview/waveform/thumbnails run locally, and export is the
on-device WebCodecs renderer (now including text, Ken Burns zoom and image/video
overlays). Only the small extracted **audio** is uploaded — to a private temp
bucket for transcription, deleted right after. Projects + transcripts are the
only durable data in Supabase.

**What the cloud build exposes:** Retake β (the only cut engine), transcription
(AssemblyAI → Deepgram), VAD silence detection (Silero ONNX **in the browser**),
manual editing, on-device export. FastCut / ProCut / Smart Cut / Smart Smooth /
AI overlays stay desktop/self-host-only and are hidden.

---

## One-time setup

### 1. Supabase project (free tier is fine)
1. https://supabase.com → New project. Note the **Project ref**, **anon key**
   (Settings → API) and pick a strong DB password.
2. Apply the schema — either:
   - `npx supabase login && npx supabase link --project-ref <REF>` then
     `npx supabase db push` (uses `supabase/migrations/`), or
   - paste `supabase/migrations/20260710000000_init.sql` into the SQL editor and run it.
3. Deploy the edge functions:
   ```powershell
   npx supabase functions deploy stt
   npx supabase functions deploy llm-judge
   ```
4. Set the provider keys as function secrets (these replace the *.env files the
   PC server used — users never see them):
   ```powershell
   npx supabase secrets set ASSEMBLYAI_API_KEY=...
   npx supabase secrets set DEEPGRAM_API_KEY=...
   npx supabase secrets set ANTHROPIC_API_KEY=...
   npx supabase secrets set OPENAI_API_KEY=...   # optional judge fallback
   ```
5. Auth settings (Dashboard → Authentication):
   - **Email confirmations**: your choice. Off = signup logs straight in
     (matches the old server behavior). On = users confirm via email first.
   - To gate signups like `EC_SIGNUP_CODE` did: **disable new signups** here
     and create accounts manually, or leave signups open.

### 2. Vercel project
1. https://vercel.com → Add New Project → import the `easecutpro` repo
   (root directory = repo root). Vercel reads `vercel.json`
   (build = `npm run build:cloud`, output = `dist-cloud/`).
2. Project → Settings → Environment Variables:
   ```
   VITE_SUPABASE_URL      = https://<REF>.supabase.co
   VITE_SUPABASE_ANON_KEY = <anon key>
   ```
3. Deploy. Your permanent URL is `https://<project>.vercel.app`; add a custom
   domain in Vercel → Domains whenever you buy one (no code change needed).

### 3. Local development
```powershell
copy .env.example .env    # fill in the two VITE_ vars
npm run dev:cloud         # Vite dev server with the cloud flag baked in
npm run build:cloud       # what Vercel runs; output in dist-cloud/
```

---

## Notes & limits

- **Cross-device:** projects/transcripts/settings follow the account; the video
  file itself is only on the device that imported it — re-pick the file when
  opening the project elsewhere.
- **Multi-clip base projects:** Retake β needs the server-side clip combine, so
  the cloud build supports it on single-clip projects only (for now).
- **Export coverage:** on-device export requires WebCodecs H.264+AAC
  (Chromium desktop/Android, recent Safari; Firefox can't). Text, zoom and
  image/video overlays render in-browser; audio comes from the local file.
- **Costs:** Vercel Hobby + Supabase Free cover hosting (video never touches
  them). Per-use: AssemblyAI/Deepgram minutes + a tiny Haiku judge call per
  Retake β run — billed to YOUR provider keys.
- **The Electron app and the self-hosted server (`npm run web`) are unchanged**
  — this is an additional build target (`npm run build:cloud`), not a
  replacement for local development.
- **Temp audio bucket:** `stt-audio` objects are deleted by the client after
  each run; if a run is killed mid-flight a stray object may remain — safe to
  empty the bucket any time.
