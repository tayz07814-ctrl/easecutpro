# HANDOFF — EaseCutPro (2026-07-05→07 marathon session → next)

> Read this first. Companions: the auto-loaded memory files under
> `~/.claude/projects/C--easecutpro/memory/` (esp. `easecutpro-fastcut-engine`,
> `easecutpro-cutcutpro`, `easecutpro-docpreview`, `easecutpro-script-guided`,
> `easecutpro-openai-backend`, `easecutpro-deploy-path`). `HANDOFF.md` remains the
> older timeline-migration handoff. This file supersedes the 07-05 handoff (73c2ab3).

## 0. FIRST THING: the stack is DOWN — one command brings everything current live

Web server, cloudflared tunnel AND the fastcut sidecar were all dead at 2026-07-07 19:54
(likely a PC reboot). Nothing is unmerged: `main` = **b844067**, tree clean, `out/` built.

```
cd C:\easecutpro
npm run remote        # server + quick tunnel → prints NEW *.trycloudflare.com URL + signup code
```

- Run from a FRESH shell so `EC_FASTCUT_PYTHON` (setx, 2026-07-05) is inherited — the server
  auto-spawns the fastcut sidecar with the right Python (tiers are OFF now, so a wrong python
  only costs warmth, not correctness).
- **Hand the user the new URL** — their phone bookmark died with the tunnel.
- This start activates the whole queued backlog: ProCut Claude-verify fix + hard prompt rules,
  resumable uploads, the wobble-free zoom export, script pass-through to the engines,
  FastCut heuristic-only, quiet aborted-request handling.

Sanity: `curl -s localhost:8787/ | grep -oE 'index-[A-Za-z0-9_-]+\.js'` → newest bundle.
Deploy mechanics (unchanged): renderer → `npm run build`, live immediately, same URL.
Main-process/server/prompts → server restart (new URL) or Electron relaunch. Python fastcut
CLI is spawned per call (fresh code every run); the sidecar caches code until restarted.

## 1. Session log (07-05 → 07-07), newest first — what & where it lands

| Commit | What | Needs §0? |
|---|---|---|
| b844067 | **On-device export phase 1** (web): "📱 Export on this device (beta)" in ExportModal + mobile export sheet. OFFLINE WebCodecs pipeline — index-based timestamps (never wall clock), <video> seek pool → worker (OffscreenCanvas composite + H.264/AAC + mp4-muxer), OfflineAudioContext mix (cuts/speed/gain/audio-lanes/music). ffprobe-verified: 6s timeline → EXACTLY 180 frames @30fps, 6.016s, AAC 48k stereo. Text/overlay timelines fall back to PC export (`whyNotLocal` tooltip). Files: `renderer/src/export/localExport.ts`, `encoderWorker.ts`. `[ondevice]` console breadcrumbs intentional. Landmine fixed live: VideoFrame(video) throws below readyState 2 — wait for `loadeddata`. | renderer — live on §0 |
| eec25fc | **Retake snapper: tail-only containment.** Long rambling clause whose TAIL retakes the next line no longer cut whole (perfume clip: only "I'm trying to get my girl this scent." flagged; 30 unique words survive). `retakeMatch` whole/tail in shared/fillers.ts; permanent regression in verify-retake-cuts.ts. Protects BOTH FastCut & ProCut (shared snapRetakeFlags). | renderer |
| ce90f5b | **FastCut heuristic-only** (user call). `ML_TIERS=false` in main/fast-cut.ts (all tier code intact behind it); renderer skips audio resolve/upload for FastCut (instant web starts); python `use_semantic` default false. Toast: "Fast Cut (heuristic)". | restart |
| 90a2fa7 | **ProCut: Claude verify was SILENTLY DEAD** (prose-wrapped EDL → parse reject → GPT raw draft shipped = the over-cutting/splices). `extractJsonObject` anchored on `"word_cuts"`; max_tokens 16000; `openai_raw`/`claude_raw` saved into debug JSONs. HARD RULES both prompts: whole-take cuts only / never splice halves / the only copy of an idea is untouchable (no filler line-editing). Renderer backstop: ProCut flags → snapRetakeFlags. SPEED: `ensureAudioUploaded` reuses `rec.serverPath` (autosave already uploaded → server ffmpegs audio, zero browser decode); >250MB skips decode → resumable upload. | restart (brain) / snap+speed live |
| 8a598ed+7f422b7 | **zoompan REPLACED** with per-frame scale+crop (`animatedZoomChain`, main/ffmpeg.ts). User diagnosed the left/right shimmy correctly — zoompan rounds scaled-width & crop pos independently. Measured: 37→8 reversals, RMS 0.36→0.17 px/f. Landmine: crop's `in_w` binds AT INIT on variable-size streams — offsets must be analytic from the same trunc'd width expression (a "centered" crop silently left-anchored, caught by measurement). | restart/Electron |
| ed106ef | Ease-in-out on ALL zoom ramps (previews `clock.easeInOut`, export expressions) + slow-ramp supersample. Export side superseded by 8a598ed; preview easing stands. | preview live |
| abfcd70 | **Resumable chunk uploads** (600MB export over flaky links): offset per chunk, 409 {size} realign, GET /api/upload-status, 5×backoff retries; quiet 400 middleware for aborted bodies. | restart (server half) |
| a5bafb7 | Mobile **Overlay button lands on the timeline** (engine-native `timelineInsert.ts`; the legacy store.addLibraryToOverlay wrote project.tracks which doc projects never read). "+ Main" on media cards; **images 4s default** everywhere; web images classified by probe (webmedia ids have no extension); mobile clip toolbar un-gated from project.timeline (fresh projects are bridged docs). | renderer |
| fcf4104 | **Mobile CapCut layout**: lanes = main + populated + one Text + one Music (＋ chips → `ec:sheet` event → sheets); zoom −/+ next to undo/redo; stage 46vh + drag grip (`ec.mStageVh` 22-58); dock always on-screen (`m-tl` min 132px); all scrollbars hidden. | renderer |
| 471621e | **DocPreview rebuild** — black-preview wedge class dead by construction (one <video> per SOURCE + single always-running rAF reconciler; `media/resolver.ts` = the one id→URL point with `missing`). **IS_WEB = !window.api** (UA sniffing broke in Electron-shelled browsers). Main lane 112px default (legacy-64 auto-upgrade, MAIN only — overlay lanes are kind 'video', key off isMain!); empty non-main lanes 22px via `geometry.laneHeight` (used by ALL Y-math incl. drop targeting). | renderer |
| 21d5c91 | FastCut keep-last swap (ABAB interleaved blocks resolve to LATER takes when content-equivalent); web save no longer fails on dead media ids. | renderer |
| d37e4e2 | **Big fix batch**: web project save deep-walks ALL webmedia ids (timeline clips were missed = THE reload-black-preview root cause); upload retries; rAF-smooth playhead; Cut Lord buttons render pre-transcript (they CREATE the transcript); **📜 Script box** (`project.script` → both engines; `fastcut/script.py` uses REVERSED alignment so ties go to the LAST take); media grid/list toggle. | renderer + engines |
| 2606740 | **OpenAI un-hijack**: user-level `OPENAI_BASE_URL=http://127.0.0.1:8875` + `OPENAI_API_KEY=sk-lm-…` (LM Studio's) silently rerouted ALL OpenAI calls. baseURL pinned; project *.env beats process.env; `{error}` bodies throw their real message. NEVER delete the user's env vars; pin baseURL in any new OpenAI client. | live since 07-06 restart, re-lands with §0 |
| c4d30e2, 085fe87…264b089, 2b868d2 | ProCut production-artifact prompts; the FastCut accuracy war (weak markers no/again/wait, verbatim-double floor, top-2-per-j, resolve→merge→extend→merge, extend bar 0.50, clause-start bonus, long-sentence-retake escape, 30× perf anchor hoist); per-run debug dumps. Details in fastcut/cutcutpro memories. | mixed — all land with §0 |

## 2. Debugging & verification tooling (reach for these FIRST)

- **FastCut dump**: `fastcut/last_run.json` + `.prev.json` — inputs, ALL candidates w/ features &
  scores, cuts, verify verdicts. NOTE: verify-script runs overwrite it — copy user runs aside.
- **ProCut debug**: `~/.easecutpro/cutcutpro/debug-*.json` — `phases_run`, `warnings`, EDLs, and now
  `openai_raw`/`claude_raw`. "Claude verification returned an unusable EDL" should be GONE post-§0.
- **Harnesses** (all green @ b844067): `npx tsx scripts/verify-{fast-cut,retake-cuts,repeats,cutcutpro,timeline-exporttransform}.ts`; `fastcut/.venv/Scripts/python.exe -m fastcut.test_missed_restarts` / `test_repeat_sample`.
- **Browser E2E rig**: worktree `.claude/launch.json` → `ec-preview` (sandboxed server :8790,
  own `.ecweb-preview` dir — rm -rf after). Tricks that work: signup via fetch (code '' open on
  localhost); feed the app's file picker by patching `HTMLInputElement.prototype.click` with a
  DataTransfer; capture exports by patching `URL.createObjectURL` (blob-url fetch is BLOCKED in
  the preview shell); push blobs via /api/upload-* then ffprobe server-side. The preview browser's
  UA contains "Electron" (why IS_WEB is window.api-based now). `npx tsx -` on stdin HANGS — write
  a scripts/_probe.ts file instead.
- **Zoom smoothness rig**: drawbox line pattern + numpy centroid per frame; metrics = direction
  reversals + RMS jitter vs 7-frame smooth (see 8a598ed message).

## 3. Next steps (rough priority)

1. **Re-test ProCut on the user's real clips after §0** — the fixed Claude verify + hard rules have
   never run for them. If quality still off, read the raw replies in the debug JSON.
2. **On-device export phase 2**: text + overlay compositing in the worker (renderTextPng equivalent,
   createImageBitmap), lift `whyNotLocal` gates; consider mp4box+VideoDecoder demux to replace
   seek-per-frame for speed. Also confirm real-phone behavior (iOS ≥16.4 quirks).
3. **Keyframed clip transforms** (user-approved "step 2"): generic pos/scale/rotation keyframes on
   doc clips; Ken Burns → two keyframes; mobile kfPrev/kfNext buttons come alive; export compiles
   keyframes into animatedZoomChain-style expressions.
4. **FastCut ML tiers are OFF** — negative results to respect before any re-enable: wav2vec2
   mean-pool cosine is NOT discriminative (known-false pair scored 0.90; frame-level DTW is the
   only worthwhile audio idea); MiniLM rescue rarely fired. The heuristic carries all accuracy.
5. **Own-model path** (user interest): log review decisions (accept/reject/add) as labels first,
   distill ProCut outputs, then train the dormant fastcut classifier (classifier.py/train.py).
6. Real-device export smoke test still owed (old item).

## 4. Environment gotchas

- **LM Studio owns `OPENAI_BASE_URL`/`OPENAI_API_KEY` user env vars** — leave them; the app pins
  its own baseURL and prefers key FILES (`openaiapikey.env`, `claudeapi.env` in repo root).
- `EC_FASTCUT_PYTHON` (setx) → system Python 3.12 (torch lives there; `fastcut/.venv` has none).
- whisper-1 is the only verbatim cloud transcriber; audio-LLMs (incl. Qwen-Audio) normalize away
  repeats — never use them for transcription here.
- Windows: pass real `C:/...` paths to Python/ffmpeg (no /tmp mangling); `npm run build` default
  file encoding traps and Electron-binary extraction gotchas are in memory files.

## 5. Working agreements (standing)

- Don't restart the web server/tunnel unasked (§0 is pre-authorized: the stack is already down).
- Code silently, short wrap-up, decisions surfaced; ask before big/core-file edits.
- Every cut engine stays review-first; the user tests from their phone — always hand over the new
  tunnel URL after a restart.
