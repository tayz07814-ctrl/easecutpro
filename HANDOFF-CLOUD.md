# HANDOFF — Cloud / iOS / mobile session (+ 0.01 betas)

> Living handoff for the **cloud/web build** (easecutpro.com — Vercel + Supabase,
> new UI gated `?newui=1`) worked on in this session. Updated after every change.
> Companion docs: `HANDOFF.md` (timeline migration), `HANDOFF-NEXT.md` (07-10 desktop/engine).
> Prod branch `main`; test branch `easecut0.01`. Supabase project ref `zlqxrdlognjvwqpmnfjq`.

## 0. Current state
`main` = **9b7aac8**, tree clean. Cloud build (`npm run build:cloud` → `dist-cloud`) + desktop
build (`npm run build`, electron-vite) + `npm run typecheck` (node + web) all GREEN. NOT
GUI-smoke-tested (the agent can't drive Electron/iOS) — **every change needs a live test**.

**Audio-decode architecture (after the ffmpeg.wasm revert):**
`WebCodecs (mediabunny) → WebAudio decodeAudioData`. Fully on-device — the clip **never leaves
the device**; only the extracted 16 kHz mono audio (WAV) is uploaded to the STT providers.
- Waveform: `webmedia.localWaveform` — WebCodecs (mediabunny `AudioBufferSink`) primary,
  `decodeAudioData` fallback, quiet degrade (console warn, no red error box) if both fail.
- STT audio: `webmedia.extractAudioWavBlob` → `cloud/audio.extractSttAudio` — WebCodecs primary,
  `decodeAudioData` fallback; throws a clean error if neither decodes.

## 1. HARD constraints (do NOT violate)
- **Video never leaves the device.** Only extracted audio (WAV) is uploaded for transcription.
  The server-side "upload the original clip" fallback was shipped then REVERTED for this reason.
- **Cloud fixes must NOT touch the shared desktop export path.** `src/renderer/src/export/localExport.ts`
  and the `webmedia` decode chain are shared with the **desktop (electron)** build. A cloud-only
  ffmpeg.wasm change reached into `renderAudio` + the decode chain and broke desktop audio → full
  revert. Any future iOS-only decode fix must be gated to the cloud build (`IS_CLOUD`) and must not
  alter `localExport`.
- **Never put the model id `claude-opus-4-8` in commits/PRs/code.**
- Git author `Claude <noreply@anthropic.com>`. Flow: work on `claude/handoff-doc-access-lo1ad9`,
  then `git checkout main && git merge --ff-only …`.

## 2. This session — `main`, newest first
| Commit | What |
|---|---|
| 9b7aac8 | **REVERT the ffmpeg.wasm audio saga** (9443a58, e594848, fe487a7) — it broke the **desktop** version (touched shared `localExport`/`webmedia`). Audio back to WebCodecs→decodeAudioData, byte-identical to 37d92c5. `@ffmpeg/*` deps + `/ffmpeg` staging removed. Verified: typecheck, desktop build, cloud build, retake fixtures. |
| 37d92c5 | **REVERT the server-side video-upload fallback** (be482a7) — keep "video never leaves the device". |
| 3d5fae3 | Cut Lord "no spoken audio" on iOS → WebCodecs (mediabunny `AudioBufferSink`) STT audio + decodeAudioData fallback. |
| 6b7a6a3 | Waveform "decode failed" on iOS → WebCodecs waveform primary, quiet degrade. |
| ~844d45a | **Mobile UI:** clip-import "Done" no-op fixed (iOS file `<input>` must be attached to the DOM before `.click()` — `cloud/api.ts` pickers); mobile timeline made **fixed** (removed the stage resize grip, `MobileEditor.tsx`). |
| (earlier) | **Batch processing:** export progress bar, silence-settings reuse (existing modal), per-user localStorage persistence on refresh, defer-create + reconcile-on-reload robustness. |

## 3. Open / known
- **iOS Cut Lord still fails on genuinely-silent clips.** Diagnostics proved the failing `copy_*`
  clips carry an audio track that is **all zeros** (peak 0.00 across decodeAudioData ×2 + ffmpeg +
  AssemblyAI; codec `pcm_s16le` → written by editing software, not a camera). The pipeline correctly
  refuses "no spoken audio". Suspected source: a prior EaseCutPro export that itself wrote a silent
  track on iOS. **Not fixed** (the export-side guard was part of the reverted saga).
- **Desktop confirmation pending** — user to pull `main`, rebuild (electron-vite), relaunch, and verify
  audio / waveform / retake / export behave as before.
- If re-attempting the iOS silent-export fix: **cloud-only** (`IS_CLOUD` gate), never in shared `localExport`.

## 4. `easecut0.01` branch (test only — beta LLM judges; DO NOT touch main)
`easecut0.01` = **25529b2** (on-device bug pass; crop/captions/transcript-reuse `6d38a08`; reskin `2b088a1`). Tests alternate
LLM cut judges via OpenRouter (the key stays
**server-side** in the `ultracut-judge` edge fn). The user tests these manually; main is unaffected.
- **Retake Beta** button → `meta-llama/llama-4-maverick` (promptVariant `sharp`, reasoning off). `e4ed28e`.
- **Ultracut Beta** button → `deepseek/deepseek-v4-flash`. `225b033` / `48b299d`.
- **Premium Cut** (3rd button) → Gemini 3.5 Flash multimodal cut engine + smooth-seam margins (100 ms
  lead-in / 300 ms tail). `78a7fe8` / `9af9445`.
- Edge fn `ultracut-judge` `MODEL_WHITELIST` includes `meta-llama/llama-4-maverick`.
- A/B (main-logged transcripts): Maverick faster / more reliable; DeepSeek more conservative, slower,
  occasional timeouts.

### Mobile UI redesign (0.01 only — `9416050`)
CapCut-style rework of the mobile editor, from a proposed 3-mockup design. Files:
`components/mobile/{Icon,MobileTools,MobileExportDrawer}.tsx`, `newui/screens/MobileEditor.tsx`, `styles.css`.
- **Main toolbar** (nothing selected): Edit · Music · Effect · Text · ScriptCut · Captions. Edit selects
  the base clip (reveals its editing toolbar); ScriptCut = Cut Lord; Effect stubs ("coming soon").
- **Selected clip**: main toolbar hides → context toolbar led by a collapse chevron (deselect) + a floating
  two-pill quick bar (Layer · Keyframe · Duplicate | Flip · Delete). Video/image: Duration · Split ·
  Animation · AI Upscaler(OFF) · Crop + existing Speed/Zoom/Adjust/Volume/Extract/Overlay/Remove-BG/Delete.
  Text + audio have their own toolbars. New Duration panel. Real edits → shared engine; stubs toast.
- **Export drawer** (`MobileExportDrawer`, replaces the modal on mobile): top-anchored sheet with
  Resolution (480p–4K) + Frame-rate (24–60) + Code-rate (Low/Med/High) sliders + live est. file size.
  Resolution + code-rate drive the real on-device encode; **FPS is UI-only — export is fixed at 30 fps**
  in `localExport` (threading a variable FPS is a bigger, separate change).
- **Stubs** (toast "coming soon", matching the existing pattern): Effect, AI Upscaler, Layer, Keyframe,
  Flip, Fade.
- **Deferred** (documented, not built): top-bar aspect/resolution controls; the canvas selection frame;
  the transport keyframe ◇+ button — all need a real keyframe engine and/or the rendered video rect.
- NOT GUI-tested (no mobile-render harness) — needs a live test on `easecut0.01`.

### Mobile UI reskin (0.01 only — `2b088a1`) — "EaseCut Editor" design, VISUAL ONLY
Reskin of the same mobile editor to the imported `EaseCut Editor.dc.html` design. **No behaviour /
wiring changes** — every handler, engine call and export path is byte-for-byte the same as `9416050`;
only appearance changed. Files: `components/mobile/{Icon,MobileTools,MobileExportDrawer}.tsx`,
`newui/screens/MobileEditor.tsx`, `styles.css`, + `newui/fonts/MaterialSymbols-subset.woff2`.
- **Icons → Material Symbols Outlined.** Self-hosted **17 KB codepoint subset** (49 glyphs, built with
  `pyftsubset` by unicode; FILL/opsz/wght axes kept). `Icon.tsx` now renders a `.ec-msym` span via a
  `IconName → codepoint` map (`String.fromCodePoint`) — **same `{name,size}` API** (+ optional `fill`
  for play/pause) so all call sites are untouched. **No CDN and NO CSP change**: the woff2 is served
  same-origin under `default-src 'self'`. (If it ever needs the Google CDN instead, that requires adding
  `fonts.googleapis.com`/`fonts.gstatic.com` to the 0.01 `vite.config.cloud.ts` CSP — not done here.)
- **Palette** scoped to `.ec-m-editor` (desktop + every other view keep the global blue theme): `#0b0b0d`
  shell, `#17171b` root tiles, `#1d1d22` collapse chevron + quick pills, purple gradient
  `#7c5cff→#a468ff`, AI-blue `#5ab6ff` (AI Upscaler), ScriptCut purple. `--accent`/`--grad` override is
  the only global-ish change — it also tints the selected-clip outline purple (free, on-design).
- **Top bar**: back + centred 9:16 marker + gradient Export (project name dropped, per design; settings
  moved to a `⋯` icon). **Transport**: Material undo/redo + filled play glyph (zoom −/＋ kept).
- **Export drawer**: `#0e0e12` sheet, **green (`#7ed957`) custom slider track** (grey rail + green fill +
  tick stops + white-circle thumb, rebuilt from the native `<input range>`), purple Export, res pill.
- **Verified**: typecheck + `build:cloud` green; font subset + all 49 codepoints render (Chromium
  screenshot of the dock/transport/export). NOT on-device tested — needs a live check on `easecut0.01`.
- **Not reskinned** (safe scope): timeline waveform bar colour (canvas-drawn in shared timeline logic);
  the design's CutLord sub-toolbar + AI-cut tool set (that's a feature, not a reskin — ScriptCut still
  opens the Cut Lord sheet).

### Mobile crop / captions / transcript-reuse (0.01 only — `6d38a08`)
Functional batch on top of the reskin. Files: `components/mobile/{MobileTools,MobileCropModal}.tsx`,
`newui/screens/MobileEditor.tsx`, `store.ts`, `cloud/{retakeEngine,transcriptCache}.ts`.
- **Effects button removed** from the main toolbar (was a "coming soon" stub). Root row is now
  Edit · Music · Text · ScriptCut · Captions.
- **Crop → visual crop window** (`MobileCropModal`, replaces the four inset sliders). Full-screen dark
  sheet: clip-thumbnail backdrop at the source aspect, draggable crop box (corner handles + rule-of-
  thirds grid + box-shadow-dimmed surround), centred aspect presets (Free/9:16/16:9/1:1/4:3/2:1), Reset,
  ✕/✓. Confirm dispatches `setOverlayCrop` (the engine crop is inset-based, so the box maps straight on).
  Backdrop = the clip's library thumbnail (falls back to any video/image thumb, else a placeholder — the
  crop maths are correct regardless). Live drag doesn't dispatch; it applies on ✓. **Rotate is NOT wired**
  (the engine has no clip-rotation command) — omitted rather than shipped as a dead control.
- **Captions now work standalone.** `generateCaptions` (store) is async: uses `project.transcript` if Cut
  Lord already ran, else transcribes first (`window.api.transcribe`, AssemblyAI) and then captions. Folds
  a doc-native base exactly like `runRetakeCutBeta` so it works on a dragged-in clip. Captions sheet
  modernized (gradient button + live status + updated copy). Interface type is now `() => Promise<void>`.
- **Transcript reuse (efficiency).** New `cloud/transcriptCache.ts` caches the verbatim STT transcript by
  `mediaId`. The FIRST run of Cut Lord / Ultracut / Transcribe / Generate-Captions transcribes once; every
  later run **reuses it and skips the AssemblyAI round-trip** — only the on-device audio decode (for VAD)
  + the LLM judge re-run. `transcribeCloud` returns instantly on a hit (no audio decode at all). Wired in
  `retakeAwareCutCloud` + `ultracutCutCloud` + `transcribeCloud`; premium is a multimodal-audio path (no
  STT) so it's untouched. **Cloud-only** — the desktop STT path is not touched. Cache is session-scoped
  (clears on reload) and keyed by media, so a re-import / re-combined montage never reuses a stale one.
- **Not done**: deeper text-editing rework (the `TextPanel` sheet is shared/desktop-oriented — left as-is);
  crop rotate + AI-expand (engine support needed). Verified: typecheck + `build:cloud` green; crop layout
  screenshot-checked. NOT on-device tested.

### On-device bug pass (0.01 only — `c234c5c`, `25529b2`) — from user testing
Fixes from the first on-device test of the crop/captions batch.
- **Captions rendered "Your text"** (`c234c5c`): `addDocTexts` (`docTextClips.ts`) built the text clip's
  content from `defaultTextContent()` + `it.content` but **dropped `it.text`** (the real string), so every
  caption showed the default. Fixed: `text: { ...default, ...it.content, text: it.text }`. **This bug is
  also on `main`** (same line) — carry the one-line fix over when 0.01 merges.
- **Crop backdrop all black** (`c234c5c`): the library-thumbnail lookup missed the clip → dark placeholder.
  `MobileCropModal` now decodes a REAL frame near the clip in-point via `window.api.thumbnails(sourcePath)`
  (the filmstrip path), library thumb as an instant fallback while it loads.
- **Fonts don't render on phones** (`25529b2`): `FONT_OPTIONS` are all desktop system fonts (Arial Black,
  Impact, Segoe UI…) absent on phones, so selection barely changes anything and the default fell back to a
  thin sans (looked a different size than desktop). User chose the **quick-consistency** path (kept system
  fonts): bold weight `700 → 800` in BOTH `TextLayer` (preview) and `textRender` (export) so captions read
  heavy + identical cross-device; Size shows familiar point-like numbers (`fontSize*300`, default ~24)
  instead of `%`. **A real cross-device font fix still needs self-hosted webfonts** (deferred by the user).
- **Seam flicker/stutter at cuts** (`25529b2`, phone + desktop): lives in the doc-native `DocPreview`
  reconciler (already wall-clock-driven + one decode-ahead buddy). Low-risk lever the user OK'd:
  `PREWARM_LEAD_S 0.6 → 1.2 s` (warm the next seam earlier so the decoder lands before the cut). Fully
  behind the existing fallback — revert to `0.6` if it isn't better on-device. A deeper reconciler rework
  (2nd buddy on capable devices, etc.) is the next step if the lever isn't enough; needs real device
  profiling — do NOT change it blind.
