# HANDOFF — EaseCutPro (2026-07-10 session → next)

> Read this first. Companions: the auto-loaded memory under
> `~/.claude/projects/C--easecutpro/memory/` (esp. `easecutpro-retakeaware`,
> `easecutpro-smoothseams`, `easecutpro-cutcutpro`, `easecutpro-multiclip-base`,
> `easecutpro-web-mode`, `easecutpro-deploy-path`, `easecutpro-selfhost-domain`).
> This supersedes the 07-09 handoff (bc9b659).

`main` = **690fe20**, tree clean. Renderer build current (`out/renderer` →
`index-C5tAb8dt.js`). **`src/main`+`src/shared` engine changes need a server
restart** (the web server loads them from source via `tsx` at start). **Renderer
changes (`src/renderer`) need `npm run build`.** Electron main-process changes need
an app relaunch.

## 0. Stack up / deploy
```
cd C:\easecutpro
restart-server.bat        # kills 8787 + cloudflared, starts fresh, prints new URL + signup code
```
- Quick-tunnel URL changes on every restart — hand the user the new
  `*.trycloudflare.com` link. Signup code has been `-Hla4yKvVKi2`.
- **Deploy sequence for a renderer change**: merge worktree→`main` in `C:\easecutpro`
  → `npm run build` (regenerates `out/renderer`) → restart. Engine-only change:
  merge → restart (no build). `src/main`/`src/shared` are picked up from source.
- **Permanent URL (user wants this):** `npm run selfhost` = Cloudflare NAMED tunnel
  on the user's bought domain (stable link, survives restarts, works behind their
  CGNAT ISP). See `SELFHOST.md`. Requires the domain's DNS on Cloudflare + a named
  tunnel routing `domain → localhost:8787`.

## 1. This session (07-10) — what shipped, newest first
All Retake-β + shared-`edit.ts` (protect/clip-gated) + export + one server fix.
FastCut/ProCut logic byte-identical (verified via their harnesses every commit).

| Commit | What |
|---|---|
| 690fe20 | **Web/tunnel booted OFFLINE fix.** The offline probe (`offline.ts`) pinged `/api/toolStatus` to decide online/offline — but that's behind `app.use('/api', requireUser)`, so a fresh not-logged-in session got 401 → offline boot (editor, no login, FastCut/ProCut gated). Added a PUBLIC `/api/ping` **before** requireUser; `probeServer` pings it (timeout 3.5→6s). Confirmed live: `/api/ping`→200 no-auth. Native path unchanged (`!IS_WEB`→true). |
| 9db17e1 | **Export: missing clips + ENAMETOOLONG.** (a) `computeKeepRanges` residue-drop is CLIP-AWARE — never drops a keep covering >70% of a base/montage clip (a wordless b-roll clip was dropped as dead air → "missing clips"; **confirmed by the export dump**). Single-clip unchanged (no baseSequence). (b) Heavy cuts made the inline `-filter_complex` overrun the OS cmdline limit → `spawn ENAMETOOLONG`; large graphs now go via a temp `-filter_complex_script` file (`filterComplexArgs`, main render + both concat paths). |
| 9970aea | **Export-plan debug dump** (`ffmpeg.ts writeExportDebug`) — non-destructive; `~/.easecutpro/export/debug-*.json` logs path chosen / keeps / base-clip spans / which clips survived + missing clips + whether they had words + `likely_cause`. This is what confirmed the residue-drop. |
| 7ab8048 | **Word-onset guard (ALL engines) + VAD hard-cut retune.** Energy-based cutting (valley-snap, blip-absorb, raw VAD) was clipping a kept word's low-energy onset (the "m" of "My" in "my parents…") in ProCut AND Retake β. Now no cut edge lands inside a kept word — shared `computeKeepRanges` (fixes ProCut/FastCut) + the hard-cut regions in `engine.ts`. Retuned the hard-cut toggle to 0.5/0.05/0.05/0.2. |
| 924f222 | **Aggressive VAD hard-cut TOGGLE** (Silence Settings, default OFF). `vadHardCut` bypasses the transcript-gap hybrid and removes EVERY VAD silence ≥ mingap via `retakeBetaVadHardCutOpts` (now `vadThreshold 0.5, edgeTrimMs 50, speechPadMs 50, minDuration 0.2`). Word cuts unaffected; regions time-only + staged as chips; `engine.ts` branches on the toggle; debug `retake_beta_vad_hardcut`. |
| afef73f | **ASR-artifact cleanup** — new `src/shared/retakeaware/artifacts.ts`, wired in `engine.ts` between word-cuts and silence. ORPHAN detector (isolated short/connector/starter word — a click heard as "Do" — with corroborating evidence: adjacent to a removed take OR low-conf → added to the delete set). STRETCHED detector (impossible-duration function word, e.g. "it's" 4.33s → clamp end to VAD speech core so the dead-air tail becomes a real gap; the clamp is applied to the TRANSCRIPT too so the core survives the residue-drop). Debug `retake_beta_artifacts`. |
| b033f49 | Retake β silence: clamp the silence cut to the word-cut edge (removed 1.7s dead air LEFT before a kept word "Do" — the cut's start had landed inside the preceding take's word cut and the whole cut was rejected). |
| 09c7230 | Retake β silence: VAD-silent guards — trim a record-button click glued to a word's kept guard air (`trail_guard`/`lead_guard`). |
| 83dbbe9 | Retake β silence: no-transcript noise-island classifier — clicks/taps/breath (<0.75s) removed, only ≥0.75s speech-like islands protected; leading record-click before the first word trimmed to a 0.25s pre-roll. Debug `no_transcript_islands`. |
| 6845e29 | Retake β silence: carve AROUND a VAD speech island instead of dropping the whole cut (a 4.7s pause with a ~1s mumble mid-gap used to survive as dead air). |

## 2. Where the new stuff lives
- **`src/shared/retakeaware/silence.ts`** — the hybrid silence cutter. New: noise-island
  classifier (`classifyNoTranscriptIsland`, `interiorSpeechIslands`, `nonSilenceBlobs`),
  carve-around-islands, VAD-silent guards, word-cut clamp, `vadHardCut` setting +
  `retakeBetaVadHardCutOpts()`. Debug: `no_transcript_islands`, `carved_around_speech_islands`.
- **`src/shared/retakeaware/artifacts.ts`** (NEW) — `detectArtifacts(words, wordCutSpans, vad)`
  → `{ orphanCutSpans, repairedWords, debug }`. Pure, Retake-β only.
- **`src/main/retakeaware/engine.ts`** — order: transcribe → analyze → buildCutSpans →
  VAD → **detectArtifacts** (orphans→delete set; repairedWords→transcript+silence) →
  silence engine (branch on `vadHardCut`: hybrid vs raw-VAD-hard-cut, regions clamped
  off words) → stage review-first.
- **`src/shared/edit.ts` `computeKeepRanges`** — the ONE keep computation preview+export
  share. New: **word-onset guard** (`WORD_EDGE_GUARD`, after valley-snap/blip-absorb) +
  **clip-aware residue-drop** (`coversWholeClip`, gated on `project.baseSequence`).
- **`src/main/ffmpeg.ts`** — `writeExportDebug` (export-plan dump) + `filterComplexArgs`
  (script-file for huge graphs). Montage path at ~L760; single-base at ~L840.
- **`src/server/index.ts`** — public `/api/ping` before `requireUser`.
- **UI**: `SilenceSettingsModal.tsx` (VAD hard-cut toggle), `store.ts` (setting flows +
  preserved across preset changes at ~L1542).

## 3. Open threads / next steps (priority)
1. **Playback stall at cut lines** (user asked, NOT done). Pinpointed:
   `DocPreview.tsx:354` — a SAME-FILE forward-skip seeks the ONE `<video>` element AT
   the boundary → stall (the pool is `path→one <video>`; the seam pre-warm only fires
   for a DIFFERENT source). Fix = dual-video ping-pong (a second element of the same
   source pre-seeked to the next segment, swap at the seam). Delicate — the reconciler
   is deliberately "wedge-proof" (rAF loop + seek-in-flight bookkeeping + watchdog);
   do it carefully and don't reintroduce wedges.
2. **ProCut rework** (user's next big item; investigated, NOT started). Wants: **AssemblyAI
   transcription** (reuse `transcribeVerbatim` from `retakeaware/providers.ts`) →
   **single Claude Haiku pass** (`claude-haiku-4-5-20251001`) that finds abandoned
   sentences + retakes/repeats ONLY (NO filler removal) → execute as usual. Current
   ProCut = whisper-1 → GPT-audio first pass → Claude opus verify → EDL → resolve
   (`cutcutpro.ts`). **KEEP the old prompts intact** (`GPT_FIRST_SYSTEM`,
   `CLAUDE_VERIFY_SYSTEM`) — "might use them later"; add a mode flag rather than
   deleting. Reuse `buildAiPayload`/`validateEdl`/`refineEdl`/`edlToEdits`. `noUnusedLocals`
   is OFF so dead prompts won't error.
3. **Verify the export fixes on-device** (ENAMETOOLONG on a heavily-cut clip; missing
   clips on a montage — newest `~/.easecutpro/export/debug-*.json` should show
   `missing_clips: 0`).
4. **Browser on-device export path** (`localExport.ts planFromDoc`, `:116` silent
   `continue` on unresolved media) was NOT instrumented — only the PC render dump.
   The residue-drop fix is upstream/shared so it should cover both, but confirm the
   on-device export isn't still dropping clips for a different reason.
5. **Custom domain / `npm run selfhost`** — the user wants a permanent URL (SELFHOST.md).

## 4. Debug & verification tooling
- **Retake β silence**: `~/.easecutpro/retakeaware/debug-*.json` → `retake_beta_silence`
  (`no_transcript_islands`, `carved_around_speech_islands`, `per_region`), plus
  `retake_beta_artifacts` (orphan/stretched) and `retake_beta_vad_hardcut` (when toggled).
- **Export plan**: `~/.easecutpro/export/debug-*.json` (`missing_clips`, `likely_cause`).
- **ProCut**: `~/.easecutpro/cutcutpro/debug-*.json`.
- **Harnesses** (run from the WORKTREE — the earlier trap: `cd /c/easecutpro` runs
  MAIN's files, not the worktree's uncommitted changes): `npx tsx scripts/verify-{
  retakeaware,retake-fixtures,retake-cuts,cutcutpro,fast-cut,repeats,smoothseams,
  clipkeep-parity,timeline-exporttransform}.ts`. New tests this session live in
  `verify-retakeaware.ts` (carve, noise-classifier, guard-trim, word-cut clamp,
  artifacts, vad-hardcut opts) and `verify-smoothseams.ts` (word-onset guard, montage
  residue-drop). `npm run typecheck` — pre-existing MobileTimeline errors are the only
  ones; filter them out.
- **Replay offline**: reconstruct a Project from a debug JSON's `raw_words` +
  `final_cut_spans` and call `computeKeepRanges` / the detectors directly (no keys).

## 5. Environment gotchas
- Keys in project-root `*.env` (gitignored): `assemblyai.env`, `claudeapi.env`,
  `openaiapikey.env`. AssemblyAI is the live transcriber (needs `speech_models` ARRAY).
- **Worktree vs main**: this worktree (`.claude/worktrees/mystifying-visvesvaraya-2c9f38`)
  has NO `node_modules` — it resolves up to `C:\easecutpro\node_modules`. Run harnesses
  from the worktree dir (default Bash cwd) so they use the worktree's source. Edits land
  in the worktree; `git -C /c/easecutpro merge --ff-only <branch>` promotes them to main.
- `/api/toolStatus` is auth-gated (behind `requireUser`) AND slow (`checkTools()` shells
  out to ffmpeg/whisper) — never probe it for reachability; use `/api/ping`.
- whisper-1 hallucinates across long silences; AssemblyAI word timestamps are ground
  truth (but AssemblyAI pads some word END times through silence — VAD refinement in
  the silence cutter handles it; the STRETCHED-word detector handles the extreme case).
- Windows: real `C:/...` paths; the Bash tool resets cwd to the worktree each call.

## 6. Working agreements (standing)
- **Review-first**: nothing touches the timeline until Execute — full transcript
  visible, word cuts blue, silence as chips.
- **Additive**: never change FastCut/ProCut/Smart Smooth to fix a Retake β bug. Shared
  `edit.ts` changes are allowed ONLY gated (protect-silence, or `baseSequence` for the
  clip-aware drop, or the word-onset guard which only pulls an edge OFF a kept word) —
  verify FastCut/ProCut via their harnesses after every `edit.ts` change.
- **Don't blind-fix the export** — it corrupts outputs; get a repro / the plan dump first
  (this session's missing-clips was confirmed by the dump before touching cut logic).
- Silence cuts are TIME-ONLY (never mark a transcript word deleted).
- Code silently, short 3-4 line wrap-up, surface decisions, ask before big/core-file
  edits, commit only when asked. The user tests from their phone — hand over the new
  tunnel URL after any restart, and don't restart unasked unless the stack is down.
