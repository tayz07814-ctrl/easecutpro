# HANDOFF — EaseCutPro (2026‑07‑05 session → next)

> Read this first. Companion: the auto‑loaded memory files under
> `~/.claude/projects/C--easecutpro/memory/` (esp. `easecutpro-deploy-path`,
> `easecutpro-fastcut-engine`, `easecutpro-cutcutpro`, `easecutpro-doc-timeline`,
> `easecutpro-server-restart`, `easecutpro-reporting-style`). The older
> `HANDOFF.md` is the *timeline‑migration* handoff — still valid for that subsystem.

## 0. TL;DR — the one thing that's in flight
**FastCut's ML tiers (semantic + acoustic) are committed but NOT deployed.**
Commit `2e82167` is on the branch, **not on main**, and the live web server is still
running the text‑only FastCut. Everything else this session is already live.

To finish it (see §2 for why each step):
```
git -C C:/easecutpro merge --ff-only claude/upbeat-newton-c35d0a   # brings 2e82167 to main
cd C:/easecutpro && npm run build                                  # rebuild out/renderer (renderer bits)
# then RESTART the web server so it loads the new fast-cut.ts/server.py + auto-starts the sidecar:
#   in the `npm run remote` terminal: Ctrl+C, then `npm run remote` again  → NEW *.trycloudflare.com URL
```
Verify after: run FastCut on a real retake clip; the job toast should read
**"Fast Cut (semantic+audio) flagged N word(s)"**. First run is ~8s (cold model
load in the sidecar), then ~0.5–1s (warm).

## 1. Git / deploy state (measured)
- Branch: `claude/upbeat-newton-c35d0a`, HEAD **`2e82167`**, working tree **clean**.
- Main (`C:/easecutpro`): HEAD **`d7bb2bb`** → **only `2e82167` is unmerged**.
- Live web server: **UP** on `localhost:8787` (tunnel `bookmarks-cottage-isle-slim.trycloudflare.com`),
  serving renderer bundle `index-CSkrgAaY.js` (== the retake‑fix build). Its **main‑process
  code is stale** (last real restart was around `c4e8656`), so server‑side changes since
  then are NOT live — see §2.

## 2. DEPLOY MECHANICS (critical, non‑obvious — this bit us repeatedly)
The live app the user tests **from their phone** is `tsx src/server/index.ts` run from the
**MAIN checkout `C:/easecutpro`** (branch `main`), fronted by a Cloudflare **quick tunnel**
(random URL). Committing on a worktree branch does nothing until you merge to main.

- **Renderer‑only change** (anything under `src/renderer`, `src/shared` used by the renderer):
  merge to main + `npm run build` → the running server serves the new `out/renderer` on the
  next page reload. **No restart, same URL.** (This is how mobile UI + retake fix went live.)
- **Main‑process / server / Python change** (`src/main/*`, `src/server/*`, `fastcut/*.py`):
  loaded into the running `tsx` process (or spawned fresh per call for Python) → needs a
  **server restart** to take effect. The server is supervised by `scripts/remote.mjs`, which
  **kills the tunnel when the server exits** and hands out a **NEW URL** on restart. So a
  restart = new phone URL. Do NOT restart without the user's OK (memory `easecutpro-server-restart`).
- Verify a deploy: `curl -s localhost:8787/ | grep -oE 'index-[A-Za-z0-9]+\.js'` (renderer hash),
  and grep the built `out/renderer/assets/index-*.js` for a marker string of your change.

## 3. What shipped this session (newest first; all merged to main + LIVE except `2e82167`)
- **`2e82167` FastCut ML tiers** — ⚠ **NOT deployed** (see §0/§5).
- `d7bb2bb` **FastCut retake accuracy** — clause‑level detection with directional *containment*
  (`LCS(earlier,last)/len(last)`) + pause segmentation → cut the WHOLE earlier take, keep the
  last; `snapRetakeFlags` cleans the Python+heuristic union and protects the kept take.
  `shared/fillers.ts` + `store.selectFastCuts`. Test `scripts/verify-retake-cuts.ts`. **Live.**
- `a6bcc98` **Cut Lord** — FastCut auto‑transcribes with **Parakeet**, ProCut with its own
  **OpenAI whisper‑1** (pulled into the word selector); manual Transcribe + model selector are
  **Electron‑only** (`{!IS_WEB && …}`); **VAD test switch** `cutLordSettings.vadDuringAnalysis`
  (⚙ dropdown, default ON): ON = VAD stages silence for review, OFF = decouple + VAD only at
  Execute. Renderer LIVE; the server‑side `runVad` bit needs the pending restart (minor).
- `c4e8656` **ProCut rework** — whisper‑1 transcribe → **GPT‑audio first pass** (keep LAST take)
  → **Claude opus‑4‑8 verify** (zero repeats). `main/cutcutpro.ts`. VAD retained. Live (server
  ran this at last restart).
- `6540253` mobile: always show overlay/text/audio lanes (`normalizeDefaultLanes` for existing
  docs) + visible empty lanes. **Live.**
- `a22570d` mobile transport = responsive grid, buttons never overlap the play. **Live.**
- `e260041` mobile: + track‑add dropdown, default lanes, clip film(top)/waveform(bottom) split,
  tap‑empty‑space‑to‑deselect. **Live.**
- `06cb3fa` **Export base‑clip transform/speed/volume at preview parity** — per‑clip
  crop/zoompan/pad + atempo/volume in the montage concat; the no‑effect graph is byte‑identical.
  `main/ffmpeg.ts`, `shared/timeline/bridge.ts`, `types.ts`, `edit.ts`. Test
  `scripts/verify-timeline-exporttransform.ts`. Live (renderer folds the doc; ffmpeg ran at
  last restart). **Never got a real on‑device export smoke test from the user.**

## 4. Environment (this machine — already set up; a fresh machine would need these)
- OS Windows 11, RTX 4060 Ti (driver 610.62). Node app + Python engine on the same PC.
- **System Python 3.12** (`C:/Users/trojan/AppData/Local/Programs/Python/Python312/python.exe`)
  is what the fastcut engine resolves to (its `.venv`/`.venv-ml` lack torch). It has:
  torch **2.12.1+cpu**, torchaudio 2.11.0+cpu, numpy, onnxruntime, fastapi/uvicorn (unused now),
  and **installed this session**: `transformers`, `sentence-transformers`.
- Models cached in `~/.cache/huggingface/hub`: `all-MiniLM-L6-v2` (~90 MB) + `wav2vec2-base-960h`
  (~360 MB). First FastCut on a fresh machine re‑downloads these.
- Ports: **8787** web server, **8799** FastCut sidecar.
- API keys present in `*.env` at repo root: `ANTHROPIC_API_KEY` (claudeapi.env),
  `OPENAI_API_KEY` (openaiapikey.env). ProCut needs both; FastCut needs neither.
- Parakeet model IS installed (`resources/models/parakeet/*.onnx`) → FastCut uses it, not whisper.

## 5. FastCut ML tiers — the in‑flight feature (full detail)
Goal the user asked for: "use an ASR model to review repeats" → we turned on the fastcut
engine's dormant tiers instead of building anything new.
- The `fastcut/` Python package already had **semantic** (sentence‑transformers MiniLM) and
  **audio** (`audio.py` `AudioEmbedder`, **wav2vec2** acoustic self‑similarity) tiers; they were
  off because the app sent the engine **text only** and the ML deps weren't installed.
- Wiring (commit `2e82167`): audio path threads
  `store.selectFastCuts → window.api.fastCut(t, audioPath) → preload/webapi/IPC/server →
  fastCutSuggest`, which **extracts a 16 kHz WAV** (ffmpeg) and sends
  `{audio_path, config:{use_audio,use_semantic}}`. Web path uploads audio like ProCut.
- Two fixes that were required:
  1. `fastcut/audio.py` — `torchaudio.load` routes through **torchcodec** (not shipped) →
     ImportError → tier silently disabled. Now loads the WAV via **scipy**; also **caches the
     wav2vec2 model at class level** so the long‑lived sidecar keeps it warm.
  2. `fastcut/server.py` — **rewritten as a stdlib `http.server`** (was FastAPI). FastAPI 0.139
     + Starlette 1.3 + pydantic 2.13 on this box 422'd every `/detect` and 500'd `/openapi.json`.
     Stdlib has no such dependency risk; models persist across requests (warm).
- Sidecar lifecycle: `startFastcutSidecar()`/`stopFastcutSidecar()` in `main/fast-cut.ts`,
  called on **server boot** (`src/server/index.ts` after `listen`) and **Electron boot**
  (`main/index.ts` `whenReady`/`will-quit`). Best‑effort: `fast-cut.ts` already prefers the warm
  sidecar (POST `/detect`) and falls back to the one‑shot CLI (`python -m fastcut.cli`).
- **Verified on the sidecar** (not yet in‑app): `meta {semantic:true, audio:true}`, cold **8.6s**
  → warm **0.6s**. The engine correctly cut the first of a repeated phrase (keep‑last).
- Tunables: `fastcut/config.py` (`use_semantic`, `use_audio`, thresholds); the retake heuristic
  thresholds live in `shared/fillers.ts` (`CONTAIN_MIN 0.7`, `NEARDUP_MIN 0.82`, `PAUSE_GAP 0.35`).

## 6. Known gaps / follow‑ups
- **DEPLOY `2e82167`** (§0) — the immediate task.
- **CUDA (optional)**: torch is CPU‑only. GPU on the 4060 Ti = reinstall torch from the
  `cu124` index (~5 GB); CPU is fine for review‑first (warm ~0.6s). User said "cuda later".
- **VAD test switch** (`vadDuringAnalysis`) — the user is A/B‑ing ON vs OFF for silence‑cut
  timing; wants feedback on which is better. The server‑side ProCut internal‑VAD‑skip when OFF
  needs the pending restart to fully honor it (renderer side already works).
- **Classifier tier** (`fastcut/classifier.py`) is a MiniLM/DistilBERT retake scorer — inference
  code only, **no trained weights** (`use_classifier=false`). Fine‑tuning it on the user's own
  retake clips (`fastcut/train.py`) is a possible future accuracy step.
- **Export parity** (`06cb3fa`) still wants a real on‑device export smoke test.
- The whole session was verified headlessly (typecheck/build + verify scripts + real ffmpeg /
  sidecar runs) — **the agent can't drive the Electron/phone GUI**; the user is the live tester.

## 7. Key files & verify scripts
- FastCut: `src/main/fast-cut.ts` (adapter + sidecar), `fastcut/{engine,detect,semantic,audio,
  server,config}.py`, `src/shared/fillers.ts` (`detectRepeatIds`, `snapRetakeFlags`),
  `src/renderer/src/store.ts` (`selectFastCuts`).
- ProCut: `src/main/cutcutpro.ts` + `src/shared/cutcutpro.ts`.
- Export: `src/main/ffmpeg.ts`, `src/shared/timeline/bridge.ts`.
- Mobile: `src/renderer/src/components/{MobileApp.tsx, mobile/*, timeline/MobileTimeline.tsx}`,
  `src/renderer/src/styles.css`, `src/renderer/src/components/timeline/timeline.css`.
- Verify (pure, headless): `scripts/verify-retake-cuts.ts`, `verify-timeline-exporttransform.ts`,
  `verify-cutcutpro.ts`, `verify-repeats.ts` (print‑only), `verify-timeline-*.ts` (13, green).
  Build gates: `npm run typecheck && npm run build`.

## 8. Working agreements
- **Reporting style**: code silently, 3–4 line wrap‑up, ask before big/core edits.
- **Never restart the web server / cloudflared tunnel unless the user asks** (they test live
  from their phone; restart changes the URL).
- Two shells: PowerShell (Windows‑native) and Bash (Git‑Bash / POSIX). Beware `$(pwd)` in Bash
  mangling Windows paths to `/tmp/...` — pass real `C:/...` paths to Python/ffmpeg.
