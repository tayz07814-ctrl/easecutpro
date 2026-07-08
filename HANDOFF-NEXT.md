# HANDOFF — EaseCutPro (2026-07-08 marathon session → next)

> Read this first. Companions: the auto-loaded memory files under
> `~/.claude/projects/C--easecutpro/memory/` (esp. `easecutpro-retakeaware`,
> `easecutpro-ondevice-export`, `easecutpro-web-mode`, `easecutpro-deploy-path`).
> This file supersedes the 07-07 handoff (a6c584c).

## 0. FIRST THING: the stack is DOWN — one command brings everything current live

Server + tunnel were dead at last check. Nothing is unmerged: `main` = **d272d19**,
tree clean, `out/renderer` build is current (renderer hasn't changed since the
last build — later commits only touched `src/main/` and `src/shared/retakeaware/`,
which the server picks up straight from source via `tsx`, no rebuild needed).

```
cd C:\easecutpro
restart-server.bat        # one-click: kills anything on 8787 + cloudflared, starts fresh
```

or manually: `npm run remote` (prints the new `*.trycloudflare.com` URL + signup code).

- Run from a shell where `EC_FASTCUT_PYTHON` is inherited (it's a system env var via
  `setx`, so any fresh shell has it — a leftover `python.exe` process from the last
  session is a dead fastcut sidecar, harmless, a fresh start replaces it).
- **Hand the user the new URL** — the tunnel URL changes on every restart (free
  quick-tunnel tradeoff; `npm run selfhost` is the permanent-domain path, see
  `SELFHOST.md`).
- Sanity: `curl -s localhost:8787/ | grep -oE 'index-[A-Za-z0-9_-]+\.js'` → should
  print `index-B4Jh9XQJ.js`.

## 1. Session log (07-08), newest first — what & where it lands

| Commit | What | Needs rebuild? |
|---|---|---|
| d272d19 | **Retake β: 4 more generic vetoes/detectors** — `tail_fragment_continuation_veto` (a CHUNK_MAX_WORDS-forced mid-sentence split's tail is a completion, not an independent retake — was wrongly matched against an unrelated earlier short sentence), `numbered_progression_veto` (masks number words, detects a repeating `<frame> #` template — "not just gonna get one/two/three/four" is a countdown, not a retry), `detectRepeatedSetups` (dash-less mid-chunk abandoned setup that restarts a beat later with the same connective+opening, absorbs any short chunker-orphaned leftover), `detectOrphanConnectors` (standalone one-word connective before a stronger restart connective — "...same way. And [pause] But now..." cuts the orphan "And"). 3 new real-video fixtures. 10/10 fixtures + 80 unit checks green. | server-only |
| 6fcf4ad | **Retake β: retry transient network failures** — `fetchRetry()` wraps every AssemblyAI/Deepgram call with backoff; retries on thrown `fetch failed` + 429/5xx, never on 4xx; poll loop tolerates up to 8 transient blips before giving up. Two real runs had silently fallen to whisper-1 on a bare connection blip — verified fixed with an injected-failure test. | server-only |
| e6a0c78 | **Retake β: large progressive retakes across multiple chunks + global stutter fixes** — `extendProgressiveRetakes` widens a confirmed retake pair's anchor chunks forward through following chunks (a restarted PARAGRAPH rarely re-chunks identically) until a paragraph-level pause/next-anchor/length-guard, commits only if the widened texts stay similar. Stutter-restart detection moved from per-chunk to GLOBAL (the chunk-split pause often lands exactly on the stutter seam) + single-token stutters now fire for closed-class function words (I/because/and/but) with a sentence-boundary guard against false positives like "...literally it. It is that easy." | last renderer-touching commit before this (2c91643) — **build is current** |
| b081f9c – cd3dcce | **Retake β core detection buildout** (5 commits): false-start/prefix-swap/self-correction/LLM-gated-ambiguity, parallel-list veto, in-chunk lead-in-orphan/corrected-word/stutter-restart, fixture-driven regression system (`test-fixtures/retake-aware/`), micro-cutoff-fragment + partial-word-restart. | server-only |
| 2c91643, b999571 | **Retake β review-state fix** — the engine now ALWAYS shows its own full verbatim transcript (never a stale/mismatched prior one) and stages cuts ONLY as blue highlights; debug JSON gained a review-state audit block (`raw_words_count`, `visible_transcript_words_count`, `hidden_words_before_execute_count`, `auto_applied_before_review` — all provably 0/false every run). **Last commit that touches renderer** (store.ts) — this is why the current build is still valid. | renderer — **already built** |
| ea1ee7b | AssemblyAI fix: `speech_model` (deprecated, 400s) → `speech_models` ARRAY (`['universal-3-5-pro','universal-2']`). | server-only |
| c9e405b | **Retake-Aware Cut Beta ships** — brand-new isolated cut engine (🧪 Retake β button next to ProCut). Provider chain AssemblyAI→Deepgram→whisper-1 fallback; pure rule analyzer (chunking, filler triage, retake grouping, whole-attempt-only removal — NEVER splices words between takes); optional LLM judge (Claude Haiku) for ambiguous cases only. Standard engines (FastCut/ProCut) byte-identical, never touched by any of the above. | renderer — already built |
| 137c8ce | `restart-server.bat` — one-click stop+restart, prints new URL. | n/a |
| b513878, f4595d7 | **On-device export speed fix** — play-harvest source frames (one seek per SEGMENT not per FRAME) for near-realtime export on weak phones, with an exact-or-seek-per-frame fallback so a device that drops presented frames degrades to slow-but-correct, never freezes/stretches (the disease this was built to avoid in the first place). | renderer — already built |
| 58c1f97 | **Job results survive WebSocket drops** — server buffers every finished job in a 30-min outbox (`GET /api/job-result`); client polls it alongside the WS wait. Fixes "FastCut/ProCut stuck busy forever" on tunnel/mobile WS drops. | server + renderer — already built |
| 2b06d4c | **Web autosave is local-first** — autosave now sends ONLY the small project JSON to the PC; media bytes live in the browser's IndexedDB (written at import, restored on reopen). Explicit toolbar **Save** is now the full push (uploads media + record) — the durable cross-device copy. | renderer — already built |
| ee27622 | **On-device export**: audio comes from `/api/export-audio` (server extracts just the AAC track, ~1.5MB/min) instead of re-fetching the full video through the tunnel — this is what was causing exports to have NO audio over cloudflare. Decode failures now FAIL the export loudly instead of shipping a silent file. | server + renderer — already built |
| 9bd832f, 3601d14 | "Use as base" no longer trusts the stale legacy `project.media` field (deleting a clip from the timeline never cleared it, so reloading the same video was permanently blocked) — now reads the doc's main lane directly and builds the timeline synchronously so a same-video reload isn't a silent no-op. | renderer — already built |

## 2. Debugging & verification tooling (reach for these FIRST)

- **Retake β debug JSON**: `~/.easecutpro/retakeaware/debug-*.json` — one per run,
  newest = latest. Toast after each run names the file. Contains raw words, chunks,
  every retake group + score + reasoning, `rejected_retake_candidates` (why a
  candidate did NOT become a cut — candidate_type/reason/similarity/prefix scores),
  `false_starts`/`self_corrections`/`micro_cutoff_fragments`/`partial_word_restarts`/
  `repeated_setups`/`orphan_connectors`, and the review-state audit block.
- **Retake β harnesses** (both pure/offline, no API keys needed):
  `npm run verify-retake-aware` (~80 synthetic unit checks) and
  `npm run verify-retake-aware-fixtures` (10 real-video regression fixtures in
  `test-fixtures/retake-aware/` — each is a raw-words JSON harvested from a real
  debug file + an expected-cuts/keeps JSON). **When you find a new Retake β bug**:
  harvest the failing run's debug JSON into a new fixture pair (see the README in
  that folder), fix the GENERIC detector until the fixture passes, never
  hardcode the specific phrase.
- **Other harnesses** (all green @ d272d19): `npx tsx scripts/verify-{fast-cut,
  retake-cuts,repeats,cutcutpro,timeline-exporttransform}.ts`.
- **ProCut debug**: `~/.easecutpro/cutcutpro/debug-*.json`.
- **FastCut debug**: `fastcut/last_run.json` + `.prev.json`.
- **Browser E2E rig**: worktree `.claude/launch.json` → add an `ec-preview` config
  pointing `cmd /c <scratchpad>/ec-preview.cmd` at `EC_PORT=8790 EC_WORK_DIR=<scratch>
  npx tsx src/server/index.ts` (sandboxed server, own work dir, tests server changes
  WITHOUT touching the live server/tunnel). Tricks: signup via fetch to
  `/api/auth/signup` (code '' works on open signup); patch
  `HTMLInputElement.prototype.click` with a DataTransfer to feed the file picker;
  patch `URL.createObjectURL` to capture export blobs; push blobs via `/api/upload`
  then ffprobe server-side. Always `git checkout -- .claude/launch.json` and stop
  the preview server when done.
- **Whisper vs AssemblyAI disagreement**: if ProCut shows a "repeat" that Retake β
  doesn't, check the engine's temp WAV (`%TMP%/easecut-*.wav`, mtime = run time)
  with `ffmpeg -af silencedetect`/`volumedetect` — whisper hallucinates entire
  sentences across long silences (confirmed 2026-07-08); AssemblyAI's word-level
  timestamps are the ground truth here.

## 3. Next steps (rough priority)

1. **Keep feeding Retake β real failures as fixtures.** The user has been sending
   debug JSONs from real videos one at a time; each new miss becomes a fixture +
   a generic detector fix. This is working well — don't regress it into
   phrase-specific patches.
2. **Deepgram path is still untested** (no key configured; AssemblyAI has been the
   live provider all session). If the user adds `DEEPGRAM_API_KEY`, do a real
   end-to-end check the way AssemblyAI's `speech_models` bug was caught.
3. **Retake β mobile UI**: the 🧪 button lives in `TranscriptPanel.tsx`, shared by
   desktop and the mobile sheet — confirm it actually renders/works on the phone
   (desktop-verified only so far).
4. **On-device export phase 2** (older item, still open): text + overlay
   compositing in the worker; `whyNotLocal` gates render-side text/overlay
   projects to the PC exporter for now.
5. **Own-model path** (user interest, older item): log Retake β / ProCut review
   decisions as labels, eventually train the dormant fastcut classifier.

## 4. Environment gotchas

- **Keys are in project-root `*.env` files** (gitignored): `assemblyai.env`,
  `claudeapi.env`, `openaiapikey.env`. `ASSEMBLYAI_API_KEY` was added 2026-07-08 and
  works — provider order is AssemblyAI → Deepgram → whisper-1 fallback.
- **LM Studio owns `OPENAI_BASE_URL`/`OPENAI_API_KEY` user env vars** — leave them;
  the app pins its own baseURL and prefers the key files above.
- `EC_FASTCUT_PYTHON` (setx) → system Python 3.12 (torch lives there).
- whisper-1 hallucinates across long silences (confirmed again this session) —
  never trust a ProCut-only "repeat" without cross-checking against AssemblyAI or
  the raw audio.
- Windows: pass real `C:/...` paths (no /tmp mangling).

## 5. Working agreements (standing)

- Don't restart the web server/tunnel unasked (§0 is pre-authorized: the stack is
  already down).
- Retake β is fully additive — never touch FastCut/ProCut/Smart Smooth Cut logic
  to fix a Retake β bug. Verified after every change via `git status --short src/`
  filtered for the standard-engine files.
- Retake β must stay review-first: full raw transcript visible, proposed cuts
  highlighted blue only, nothing hidden/auto-applied before the user presses
  Execute cuts. The review-state audit block in the debug JSON is the proof.
- Code silently, short wrap-up, decisions surfaced; ask before big/core-file edits.
- Every cut engine stays review-first; the user tests from their phone — always
  hand over the new tunnel URL after a restart.

## 6. Immediate next task: Smart Silence Cutter for Retake Beta

Scope discipline, read this before writing any code:

- **We are NOT building a new retake decision engine.** Retake grouping, filler
  triage, false-start/self-correction detection etc. are DONE and stay as-is.
- We are adding a **Smart Silence Cutter** as one more stage INSIDE the existing
  Retake β pipeline (`src/main/retakeaware/engine.ts` +
  `src/shared/retakeaware/analyze.ts`) — not a parallel/competing system.
- Pipeline position: it runs **AFTER** retake-group/filler/false-start/self-
  correction detection and **BEFORE** `buildCutSpans` does its final merge pass —
  i.e. it contributes its own candidate spans into the same merge step everything
  else already goes through, it doesn't get its own separate merge/apply path.

Detection approach:

- **Word timestamp gaps first** — the transcript already has exact word
  start/end times; a silence candidate is a gap between consecutive words above
  some floor. This is the primary, cheap signal (matches how `silenceAfterMs`,
  `CHUNK_GAP_S`, `RUN_GAP_S` etc. already work elsewhere in this file — reuse
  that vocabulary, don't invent a parallel timing concept).
- **Refine with audio energy/RMS if possible** — word-gap timestamps can be a
  little loose at the edges; if there's a cheap way to snap the cut boundary to
  actual low-energy audio (the existing ffmpeg pipeline has RMS/silencedetect
  precedent — see `smoothseams`/`computeKeepRanges` waveform-snapping in the
  standard engines for the established pattern, memory: `easecutpro-smoothseams`)
  use it to tighten the boundary. Optional refinement, not a hard requirement —
  timestamp gaps alone must work standalone.

Cutting behavior — this is the part most likely to be gotten wrong:

- **Shorten pauses, do NOT delete all pauses.** A long silence gets trimmed down
  to a natural-feeling gap, not removed entirely. Removing every pause makes
  speech sound rushed/robotic — that is an explicit non-goal.
- **Preserve natural pacing.** The target shortened duration should read as a
  normal conversational beat, not a hard minimum like 0ms.
- **Support a small fade/crossfade at the edges** of a shortened silence so the
  cut doesn't click/pop — mirrors the existing `≤12ms seam-only fades` approach
  used by `computeKeepRanges` for standard-engine cuts (memory:
  `easecutpro-smoothseams`); reuse that idea/scale here rather than inventing a
  new fade constant.

Hard requirements (do not ship without these):

- **Review-first, no exceptions**: silence-shortening spans are staged as
  proposed cuts the SAME way every other Retake β span is — full raw transcript
  stays visible, proposed shortenings highlighted for review, nothing is
  auto-applied before the user presses Execute cuts. This is not optional or
  a special case; it goes through the exact same `deleteWordIds`/review-state
  machinery as every other detector in this engine.
- **Must NOT touch FastCut, ProCut, or Smart Smooth Cut.** All of this lives
  inside `src/shared/retakeaware/` + `src/main/retakeaware/` only. Verify with
  `git status --short src/` filtered for the standard-engine files before
  committing, same as every other Retake β change this session.

Debug output (add to `RetakeAwareDebug` / the engine's returned debug JSON,
following the existing pattern of `false_starts`/`self_corrections`/etc.):

- **silence candidates** — every detected gap considered, with its raw duration
  and (if RMS refinement ran) the refined boundary.
- **dropped candidates** — gaps that were considered but NOT shortened, with a
  reason (e.g. already short enough, inside a kept retake attempt's natural
  pacing, below the shortening floor).
- **total silence removed** — a single summary number (seconds) for the whole
  run, similar in spirit to the existing `mapped_word_ids_count`/
  `final_cut_spans_count` summary fields.
- **final spans with silence** — the actual silence-shortening spans that made
  it into `final_cut_spans`, distinguishable from retake/filler/self-correction
  spans (new `CutSpan.type`, e.g. `'silence_shorten'`, following the same
  pattern as `'repeated_setup'`/`'orphan_connector'` added this session).

Before implementing: add a fixture the same way every other Retake β feature
was added this session (harvest a debug JSON with real pauses worth shortening
into `test-fixtures/retake-aware/`, write the expected shortened-duration
behavior, then build the generic detector against it — not the other way
around). Run `npm run verify-retake-aware` and
`npm run verify-retake-aware-fixtures` before considering this done, and
confirm all existing fixtures still pass.
