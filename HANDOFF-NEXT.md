# HANDOFF — EaseCutPro (2026-07-09 session → next)

> Read this first. Companions: the auto-loaded memory files under
> `~/.claude/projects/C--easecutpro/memory/` (esp. `easecutpro-retakeaware`,
> `easecutpro-smoothseams`, `easecutpro-ondevice-export`, `easecutpro-web-mode`,
> `easecutpro-deploy-path`, `easecutpro-multiclip-base`). This supersedes the
> 07-08 handoff (1af3861).

`main` = **ce06edf**, tree clean. Renderer build current (`out/renderer` →
`index-Co9W2SZG.js`). **Engine (`src/main/**`) changes need an app RELAUNCH** to
go live (Electron loads the main process at launch; the web server loads modules
at start via `tsx`). The renderer picks up rebuilt `out/renderer` without a
restart on web.

## 0. Stack up / deploy (unchanged)
```
cd C:\easecutpro
restart-server.bat        # kills 8787 + cloudflared, starts fresh, prints new URL + signup code
```
Tunnel URL changes every restart (free quick-tunnel). Hand the user the new URL.
`npm run selfhost` = permanent-domain path (SELFHOST.md). Renderer changes need
`npm run build`; `src/main`+`src/shared` are picked up from source by `tsx`.

## 1. This session (07-09) — what shipped, newest first

The whole session was the **Retake β silence cutter** (rebuilt end to end from
real-video bug reports) plus an earlier offline/Capacitor block. All Retake-β
only; **FastCut/ProCut/Smart Smooth byte-identical** (verified every commit).

| Commit | What |
|---|---|
| ce06edf | **Dead-air residue clips removed.** `computeKeepRanges` now drops any INTERIOR keep (cut on both sides) holding NO kept speech, any size (not just <0.5s) — dead air between two removed retakes / cut+silence no longer survives as a residue clip. Gated on `SilenceRegion.protect`. |
| 5b83358 | **Tight ~100ms lead-in.** Residual split ASYMMETRICALLY: ~100ms before the next word's VAD-true onset, the rest as trailing air after the previous word. `vadOnset()` finds the real onset (may precede a late transcript start → never clips). Falls back to the right guard w/o VAD. |
| 34fc2f7 | **Leading/trailing edge silence** trimmed (edges have no bounding word). VAD must confirm the region is silent (protects a music intro). engine passes the true media duration for trailing. |
| 881906e | **Noise-as-voice fix.** AssemblyAI absorbs trailing silence into some word END timestamps ("it's" = 4.33s) → transcript gap reads ~0 → silence hidden INSIDE the clip. `vadSpeechEnd/Start()` refine the word's true speech boundary so the hidden silence is exposed and cut. |
| 3db1525 | **Timeline sliver ripple-fix + Silence Settings UI.** (a) `computeKeepRanges` builds the timeline clips (`bridge.ts:130`) — protected-silence subtraction ran after island cleanup and left tiny air slivers; now they ripple-close. (b) Full Silence Settings modal + presets. |
| 0683da0 | **Hybrid detector.** Transcript word GAPS are the primary span (VAD-only under-detected, left 0.7–1.2s); VAD is SAFETY only (drops a cut only for a genuine interior speech island). Word-cut carve keeps pauses adjacent to retakes. |
| 0673ecc | (superseded) conservative word-clamped VAD profile. |
| 2e0eba6 | (superseded) tried FastCut's VAD path for Retake β. |
| 0746bd3, da97cd5, d98339d | (superseded) the v1→v3 bespoke transcript-gap cutter. |
| 63a4b59 | **DocPreview seam pre-warm** — pre-seek the next source ~0.6s before a clip/cut boundary so crossing it doesn't stall ("slider sticks + video pauses"). NOT fixed: a same-file forward-skip cut (inherent `<video>` seek latency). |
| 7ef830b | **Offline mode + Capacitor Android.** `probeServer()`, offline boot to editor, server-only buttons gated (`requireServer`); `capacitor.config.ts` (appId `com.easecutpro.tals`), `android/` project, built `app-debug.apk` (3.9MB). |

## 2. Retake β silence cutter — current architecture (the deliverable)

Pure detector: **`src/shared/retakeaware/silence.ts`** → `detectBetaSilencesHybrid(words, wordCutSpans, vad, settings, mediaDurS)`.
Called by **`src/main/retakeaware/engine.ts`** (after word-cut spans are known),
which fetches a fine-grained VAD scan (`retakeBetaVadSafetyOpts` → `detectSilence`)
and passes it in. Returns `SilenceRegion[]` (`action:'remove'`, **`protect:true`**)
+ a `retake_beta_silence` debug block.

- **Primary source = transcript word gaps** (`nextOnset − prevSpeechEnd`), NOT
  VAD (VAD-only under-detects). VAD is used ONLY to: (a) refine over-long word
  boundaries (`vadSpeechEnd/Start`), (b) find the true onset (`vadOnset`), (c)
  drop a cut if a genuine silence-bounded interior speech island ≥0.35s sits in
  the centre (a transcript-missed word). VAD under-detection can NEVER cap removal.
- **Settings-driven** (`RetakeBetaSilenceSettings`): minPause / targetRemaining /
  paddingBefore / paddingAfter / minRemoved / removeBreaths / maxCutsPerMinute /
  antiSliver. Presets Conservative/Balanced/Aggressive/Custom (exact values in
  `RETAKE_BETA_SILENCE_PRESETS`). **Launch default = Balanced, safe.** Fragile
  starters/prev words get a guard floor (0.32/0.38). UI: `SilenceSettingsModal.tsx`
  + the "🔇 Silence Settings" button in `TranscriptPanel.tsx`; the 🧪 button is
  relabelled "Find Retakes & Silence". Settings flow renderer→store
  (`retakeBetaSilenceSettings`)→IPC(preload/webapi/main/server)→engine→detector,
  and are recorded in the debug JSON (`retake_beta_silence_settings_used`).
- **Asymmetric residual**: tight ~100ms lead-in before the next word (VAD onset),
  the rest as trailing air (user explicitly wants tight starts, natural trailing).
- **Leading/trailing edges** handled after the word-pair loop; VAD-gated.
- **`SilenceRegion.protect`** (`src/shared/types.ts`) makes `computeKeepRanges`
  (`src/shared/edit.ts`) apply the region VERBATIM (no edgeTrim/valley-snap/
  blip-absorb/bridge) and, at the very end, drop interior dead-air residue keeps.
  **FastCut/ProCut never set `protect` → their behaviour is unchanged** (this is
  how we're allowed to touch the shared `edit.ts`).

Debug JSON: `~/.easecutpro/retakeaware/debug-*.json`, `retake_beta_silence` block
has `per_region` (transcript_gap, guards, target/effective residual, removed,
remaining, drop/reject reasons, merged-with-word-cut) + aggregate counters +
`retake_beta_silence_settings_used`.

## 3. Open threads / next steps (rough priority)

1. **Verify the silence cutter on-device.** All fixes were verified by replaying
   the user's real transcripts (debug JSON has `raw_words`) + pure harnesses; the
   real VAD path only runs on-device. The user should relaunch and re-run **Find
   Retakes & Silence**; if a specific spot still looks wrong, get that run's newest
   debug JSON and trace `per_region`.
2. **Silence cutter depends on on-device VAD** (`retakeBetaVadSafetyOpts` →
   `detectSilence`, whisper-VAD bin or ffmpeg silencedetect fallback). If VAD is
   unavailable it falls back to transcript-only (misses hidden-in-word silence +
   won't trim edges). The user's machine has VAD.
3. **EXPORT BUGS (diagnosed, not fixed — awaiting repro/green-light).** "Missing
   clips" = two export paths with DIFFERENT sources of truth: browser on-device
   (`localExport.ts planFromDoc` reads `doc.tracks`, silently `continue`s past a
   clip whose media doesn't resolve, `:116`) vs PC (`ffmpeg.ts` uses
   `computeKeepRanges`+`virtualKeepsToClipSegments` over the legacy model). Slowness
   = software `libx264` only (no nvenc/qsv/amf) + re-encode-everything + montage
   double-encode (`concatSegmentsToFile` then re-encode). Fix plan: (1) export-plan
   debug dump, (2) fail-loud on unresolved clip, (3) unify both exporters on the
   doc, (4) hardware encoder + single-pass montage. Do NOT blind-fix — it corrupts
   outputs; get a repro (single-clip vs montage / PC vs browser / cut type) first.
4. **Git remote for the Mac/iOS build.** User wants to push to a remote to build
   iOS on a Mac. BLOCKER: verify secrets don't leak — `*.env` (assemblyai/claudeapi/
   openaiapikey) must be gitignored; recommend a PRIVATE repo. iOS = Capacitor
   (`npx cap add ios`) on the Mac + Xcode + CocoaPods; no rewrite. `android/` is
   large — gitignore it (regenerate via `npx cap add`).
5. **Local project persistence (offline).** Offline mode boots to a fresh editor
   but projects don't persist across restarts (records are server-only; media is
   already IndexedDB). Add a local IndexedDB project store.
6. **WebCodecs thumbnails/waveform speedup.** On mobile/browser these take 10–20s
   (`<video>` seeking + full `decodeAudioData`). Switch to WebCodecs + cache in
   IndexedDB. (Do NOT embed ffmpeg.wasm — bigger AND slower for these tasks.)

## 4. Debug & verification tooling
- **Retake β silence**: `~/.easecutpro/retakeaware/debug-*.json` → `retake_beta_silence`.
  Replay a run's transcript through the detector offline: read `raw_words` +
  `final_cut_spans`, call `detectBetaSilencesHybrid(raw_words, final_cut_spans,
  syntheticVAD, settings, dur)`. Build synthetic VAD as: silence in gaps + each
  word's tail past `start+0.35`. To check residue: build a Project (mark deleted =
  word midpoint in a `final_cut_span`; silences = kept `per_region`), run
  `computeKeepRanges`, look for interior air keeps (no kept word).
- **Harnesses** (pure, deterministic, no keys/network): `npm run verify-retake-aware`
  (unit incl. silence/settings/ripple/edge tests), `npm run verify-retake-aware-fixtures`
  (10 real-video retake fixtures), `npx tsx scripts/verify-{fast-cut,retake-cuts,
  repeats,cutcutpro}.ts` (standard-engine regression — run these after ANY edit.ts
  change to prove FastCut/ProCut unchanged).
- `npm run typecheck` — pre-existing `MobileTimeline.tsx` errors (11, unrelated to
  this session; `TimelineDocument` naming) are the only ones; filter them out.

## 5. Environment gotchas
- Keys in project-root `*.env` (gitignored): `assemblyai.env`, `claudeapi.env`,
  `openaiapikey.env`. AssemblyAI is the live provider; needs `speech_models` ARRAY.
- Android toolchain installed: JDK 17 `C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot`
  (JAVA_HOME), Android SDK `C:\Android\Sdk` (ANDROID_HOME, cmdline-tools/latest,
  platform-tools, platforms;android-34, build-tools;34.0.0), Gradle 8.7 `C:\Gradle`.
  Env vars persisted (User scope) — new terminals only.
- Only ~10–13GB free on C: — do NOT install Android emulator system images.
- whisper-1 hallucinates across long silences; AssemblyAI word timestamps are
  ground truth (but see 881906e: AssemblyAI pads some word END times through
  silence — VAD refinement handles it).
- Windows: real `C:/...` paths (no /tmp mangling); the Bash tool resets cwd to the
  worktree each call — use absolute paths / `cd /c/easecutpro &&`.

## 6. Working agreements (standing)
- Don't restart the web server/tunnel unasked (unless the stack is confirmed down).
- Retake β is additive; NEVER change FastCut/ProCut/Smart Smooth to fix a Retake β
  bug. The `edit.ts` changes are allowed ONLY because they're gated on
  `SilenceRegion.protect` (FastCut/ProCut never set it) — verify with the standard
  harnesses every time.
- Silence cuts are TIME-ONLY: never `spansToWordIds`, never in `deleteWordIds`,
  never mark a transcript word deleted. Review-first: full transcript visible,
  word cuts blue, silence as chips, nothing applied before Execute cuts.
- Code silently, short 3-4 line wrap-up, surface decisions, ask before big/core-file
  edits. Commit only when asked. The user tests from their computer/phone — hand
  over the new tunnel URL after any restart.
