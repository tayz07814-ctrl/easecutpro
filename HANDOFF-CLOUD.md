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
`easecut0.01` = **0662f2f** (Android offline app: import picker fix + runtime media permissions; a `59ef87b` "macOS cloud desktop shell" from ANOTHER session also sits on this branch; OFFLINE app — bundled dist-cloud + gallery/files picker `09f70ea`; Android test APK via CI `0c2eba3`; 3-tab text panel + text shadow + style presets `3cd0716`; mobile single-decoder preview `21be3e1`; text-drawer batch `4d033e0`: drop Duration, `]|[` split, modern text panel, caption styles, custom fonts, bg-opacity 100%; timeline theme `90661d8`; base-video crop + caption size `febe44f`; freeze fix `1cc8551`; crop/captions/transcript-reuse `6d38a08`; reskin `2b088a1`). Tests alternate
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
- **⚠ That `PREWARM_LEAD_S = 1.2` FROZE playback — REVERTED to `0.6`** (`1cc8551`). On a heavily-cut video
  the kept segments are SHORTER than the 1.2 s lead, so the decode-ahead buddy re-seeks on essentially
  every segment; on mobile that starved the hardware decoder and wedged the picture (frozen frame while
  the wall-clock playhead kept advancing + no audio). Lesson: **`PREWARM_LEAD_S` must stay ≤ the typical
  kept-segment length** — do not raise it to chase flicker. Seam flicker is still open; the real fix is a
  smarter reconciler (device-profiled), not a bigger lead. Also `generateCaptions` no longer rewrites
  `media`/`baseSequence` in its transcribe branch (captions don't cut → don't need it; only risked
  desyncing the doc-native preview) — it just stores the transcript.

### Round 2 on-device fixes (0.01 only — `a9e5f86`, `e71459d`, `febe44f`)
- **Caption "Your text"** was a real bug (`c234c5c`, shipped earlier): `addDocTexts` dropped `it.text`.
  Default caption font size is now ~7 on the editor scale (`fontSize 0.0233`; `a9e5f86`).
- **Base-video CROP now actually renders** (`e71459d`). It was rendered ONLY for overlay (PiP) clips —
  the base video ignored `clip.crop` in the preview AND all exporters, so the crop tool did nothing on
  the main clip. Fix: `cropToKenBurns(crop)` (kenBurns.ts) folds an inset crop into an equivalent Ken
  Burns **cover-zoom + focal pan** (the base transform is already a uniform scale-about-origin, so a
  crop-to-cover is the same shape → reuse it, no new base renderer). Preview: `DocPreview.docSegments`
  folds it into ovScale/ovX/ovY. Export: `localExport.planFromDoc` folds it into size/ox/oy — and that
  planner is shared by BOTH `localExportMB` (cloud) and `localExport` (desktop), so preview == export.
  Exact for a just-cropped clip (source aspect ≈ output); COVER semantics (fills, crops excess for a
  mismatched crop aspect); approximate if combined with a Ken Burns zoom or a letterboxed source.
- **Crop backdrop** was a pixelated thumbnail → now a full-res `<video>` seeked to the clip in-point,
  thumbnail as poster (`febe44f`).
- **Playback freeze, take 2** (paused, scrub back → stuck frame, single continuous clip): confirmed NOT
  from these commits — prewarm already reverted, scrub-adoption + paused-seek code intact. It's the phone
  HW decoder stalling on the seek (low battery worsens it). NOT changing the player blind again — needs a
  charged-device repro / on-screen decoder debug readout before any code change.

### Mobile timeline theme + "Cut Lord" label (0.01 only — `90661d8`) — VISUAL ONLY, mobile-scoped
Purple-theming the mobile timeline to match the app, plus the tool rename. **No behaviour change**; every
geometry helper is scoped to `MobileTimeline` so the shared desktop timeline is byte-for-byte the same.
Files: `components/mobile/MobileTools.tsx`, `components/timeline/{WaveformCanvas,MobileTimeline}.tsx`,
`components/timeline/timeline.css`.
- **"ScriptCut" → "Cut Lord"** as the tool label (`MobileTools`); the handler/sheet were already Cut Lord.
- **Track background follows the purple theme** (was sea-green teal `#2f8f9d`): base + overlay clips now
  render dark-purple `#312a52` via a mobile-only `mTrackColor(kind)` (non-video kinds keep `TRACK_COLOR`).
- **Waveform = thin bright-purple bars on a grey-dark band.** `WaveformCanvas` gained optional
  `colors/barW/step` props **defaulting to the desktop teal gradient** (desktop untouched); `MobileTimeline`
  passes `WAVE_PURPLE` (bright `#c4b5fd`/`#a78bfa`) + `barW 1.4` + `step 3`. The wave band background is
  `#202127` (grey-dark) with a faint top hairline (`.ec-mtl-wave` in timeline.css).
- **Trim handles = white thick bars with a black grip.** `.ec-mtl-handle::before` is a full-height white
  bar (`#fff`, radius 4); `.ec-mtl-handle::after` is a short black grip (`#141414`) centred on it.
- **Base + overlay lanes 20% shorter.** `mLaneHeight(t)` = `round(laneHeight(t)*0.8)` for video kinds only,
  scoped to `MobileTimeline` (shared `laneHeight` unchanged → desktop lanes are the same height).
- Verified: typecheck + `build:cloud` green; Chromium static mock confirmed the white-bar/black-grip trims
  render. NOT on-device tested — needs a live check on `easecut0.01`.

### Mobile text drawer batch (0.01 only — `4d033e0`) — text tools, fonts, caption styles
Text-editing pass on the phone editor. New files: `components/mobile/MobileTextPanel.tsx`, `customFonts.ts`,
`captionStyles.ts`. Edited: `components/mobile/{Icon,MobileTools}.tsx`, `newui/screens/{MobileEditor,Editor}.tsx`,
`store.ts`, `docTextClips.ts`, `components/TextPanel.tsx`, `shared/timeline/bridge.ts`.
- **Duration tool dropped** from the video/image edit toolbar (`MobileTools`) — length is set by trimming;
  the panel code stays (audio clips still have a Duration tool).
- **Split icon → `]|[`.** `Icon` special-cases `split` to a bespoke SVG (two brackets + a dashed centre cut
  line, `currentColor`) instead of the `vertical_split` Material glyph.
- **Modernized text drawer.** The phone "Text" sheet was still the desktop `TextPanel` (`.tool-content`,
  raw `<select>`/`<h4>`). New `MobileTextPanel` matches the other sheets (dark cards, purple accents,
  segmented alignment, `accent-color` sliders, colour swatches) with the SAME engine wiring (doc-native
  text clips). **Desktop `TextPanel` is untouched** — it's still used by `ToolsPanel` (desktop) + `MobileApp`
  (legacy), so a mobile-only file was added rather than editing the shared one.
- **Custom fonts.** `customFonts.ts` lets the user upload a font file (.ttf/.otf/.woff/.woff2): registers a
  `FontFace` (renders in preview AND the main-thread canvas-baked export), persists it as a data-URL in
  `localStorage`, reloads on editor mount (`loadStoredFonts` in `MobileEditor`), and tracks a **default**
  font. Uploading a font sets it as the default; `defaultTextContent()` (docTextClips) now reads
  `getDefaultFont()`, so new text AND captions inherit it. All storage/FontFace access is try-guarded (quota
  / private mode degrade quietly). **Cloud-only feature; desktop font list unchanged.**
- **Two caption styles** (`captionStyles.ts`): **Clean** (white + black outline, the old default) and
  **Boxed** (white on an opaque black bar). The Captions sheet shows a 2-card picker (mini `Aa` preview);
  `generateCaptions(styleId?)` applies the chosen style's content. `Editor.tsx` caption button wrapped so it
  no longer passes the click event as the style id.
- **Background opacity default 100%** (was `0.6`) in all three text defaults: `docTextClips.ts`,
  `TextPanel.tsx`, `bridge.ts`. (These live on `main` too but the change is 0.01-only for now.)
- Verified: typecheck + `build:cloud` green; Chromium mock confirmed the `]|[` split + caption-style cards.
  NOT on-device tested. **Custom-font EXPORT needs an on-device check** — the FontFace must be loaded before
  the canvas bakes text (it is, on upload + on mount), but only a real export confirms the glyphs land.

### Mobile preview: single-decoder path (0.01 only — `21be3e1`) — mobile playback fix, phase 1
User report: **mobile browsers are slow/glitchy in the preview; desktop is fine.** Root cause is the phone
platform, not tuning: iOS Safari effectively has **~1 hardware H.264 decode pipeline** (Android 1–3), while
the `DocPreview` player keeps a `<video>` per source **+ a decode-ahead "buddy"** (+ PiP videos). On a phone
the buddy can't actually decode ahead — it contends for the single decoder and its prewarm seeks **stall the
live picture** (the frozen-frame-while-the-playhead-moves bug). Desktop has many pipelines + fast seeks, so
it never bites.
- **Fix (phase 1, low-risk):** `DocPreview` gates `buddySrcs` on `useIsMobile()` — on mobile it returns an
  empty set, so every source gets exactly ONE `<video>` and same-source cut seams **cold-seek that one
  element** (a brief stall) instead of wedging. This is literally the reconciler's existing no-buddy
  fallback (already used for multi-source montages on desktop), so it's well-exercised. Desktop keeps the
  buddy (unchanged). `useIsMobile` = `matchMedia('(max-width: 820px)')` — same gate the app uses to pick the
  mobile editor.
- **Tradeoff:** trades the hard FREEZE for a brief seam stutter on heavily-cut clips. Not a full cure —
  seams still stutter, and multi-source montages still spin one decoder per source (pool windowing is a
  later lever). Overlay/PiP videos still decode live (pausing them would silence overlay audio — left alone).
- **Phase 2 (the real cure, not built):** an **on-device low-res proxy** of the edited timeline (reuse the
  export planner + mediabunny encoder to render a 360–480p MP4), which the phone plays as ONE seek-free
  file → smooth like desktop. Rebuild debounced after edits; keeps video on-device (no upload). ~1 week.
- NOT on-device tested — needs a live check on a phone (ideally charged); expect maybe one tuning round.
  Per the earlier freeze lesson, do NOT tune the reconciler further blind — this change is safe because it
  only *removes* a decoder (the documented fallback), it doesn't add new seek logic.

### Mobile text panel → 3 tabs + shadow + style presets (0.01 only — `3cd0716`)
From on-device feedback: tapping the Text tool **auto-dropped a "Your text" clip** before the user added
anything; the panel was "bulky and all over the place"; the length control overlapped. New files:
`textStyles.ts`. Edited: `MobileTextPanel.tsx` (full rewrite), `MobileEditor.tsx`, plus shadow plumbing in
`shared/types.ts`, `shared/timeline/bridge.ts`, `textRender.ts`, `components/TextLayer.tsx`.
- **No more auto-add.** `MobileEditor` opening the Text sheet no longer inserts a clip (`openTextSheet`
  replaces the old `addText`). With nothing selected the Text tab composes a **draft** and commits on
  "Add to timeline" (`addDocTexts`, then jumps to the Font tab). Timeline empty-lane `+ Add text` (`ec:sheet`
  `text`) also just opens the sheet now.
- **3 tabs** (segmented pill at the top of the sheet), fixing the bulky single-scroll:
  - **Text** — textarea + a single clean **"Length on screen"** slider (0.3–30s; text clips are
    non-time-based so `trimClipOut` extends freely) + Delete. (The old overlapping Start/End number pair is
    gone.)
  - **Font** — font selector + upload-your-own + "default" toggle; alignment segmented; size; bold/italic.
  - **Style** — one-tap **presets** (`textStyles.ts`: Plain/Outline/Boxed/Shadow/Yellow/Pop, each a full
    style bundle so switching is predictable) + manual text colour, outline (thickness+colour), background
    (toggle+colour+opacity+radius+padding), and **shadow**.
- **Text shadow — implemented end-to-end** (was previously in the doc model but rendered NOWHERE). Preview:
  `TextLayer` adds `textShadow` (CSS). Export: `drawTextClip` sets `ctx.shadow*` on the FILL pass only
  (stroke + bg boxes don't double-cast). Threaded via new optional flat `TextClip.shadow*` fields +
  `legacyTextFrom` (doc→flat for export). blur/dx/dy are fractions of font size. Backwards-compatible
  (default off) — existing clips + desktop unaffected. Lives on `main` too (shared files) but only 0.01
  has the editing UI + is where this ships.
- Verified: typecheck + `build:cloud` green; Chromium mock confirmed the 3 tabs + preset previews render
  cleanly with no overlap. NOT on-device tested; **shadow at EXPORT still needs a real on-device export
  check** (canvas shadow bakes on the main thread, same place as the rest of the text).

### Android test APK via GitHub Actions (0.01 only — `0c2eba3`)
User asked for an installable Android APK to test. There was already a committed Capacitor Android project
(`android/`, Capacitor 6.2.1, appId `com.easecutpro.tals`, Gradle 8.2.1, SDK 34) set up for a BUNDLED
offline app (`webDir: out/renderer`) — but a bundled launch has no `?newui=1`, so it wouldn't reliably boot
the 0.01 mobile UI, and the electron-renderer build assumes `window.api`. So for a **reliable test APK** the
wrapper now loads the **live 0.01 preview** instead.
- **`capacitor.config.ts`** (0.01): `webDir: 'capacitor-www'` (a tiny boot splash) + `server.url` = the
  `easecut001` Vercel preview (`?newui=1`). The installed app is a fullscreen Capacitor WebView of the exact
  build tested in the browser — new mobile UI + working Supabase/edge backend. The bundled-offline mode is
  documented in the config comment for later. New file: `capacitor-www/index.html`.
- **`.github/workflows/android-apk.yml`**: on `workflow_dispatch` + push to `easecut0.01` touching the
  wrapper files. Steps: checkout → Node 20 → JDK 17 → `npm ci --ignore-scripts` (fast; no electron/esbuild
  binary downloads, none needed) → `npx cap sync android` → `./gradlew assembleDebug` → upload the APK as an
  artifact AND attach it to a **prerelease** (tag `android-apk-0.01`) for a phone-friendly direct download.
- **First run GREEN** (run `29959336608`, ~2.5 min). APK: **3.75 MB**, debug-signed (installable from
  "unknown sources"), at
  `https://github.com/tayz07814-ctrl/easecutpro/releases/tag/android-apk-0.01` → `app-debug.apk`.
- **Caveats**: it's an Android WebView (Chromium), so the video engine ≈ Chrome on the phone — it does NOT
  fix the preview stutter (that's phase-2 proxy work); needs a network connection; the repo is private so
  the download needs a signed-in GitHub session. `google-services` plugin auto-skips (no `google-services.json`).
  The APK loads the live URL, so it reflects the latest deployed 0.01 without reinstalling — only rebuild the
  APK when the wrapper (config/splash/workflow) changes.

### Android OFFLINE app — bundled dist-cloud (0.01 only — `09f70ea`)
Superseded the webview wrapper: the APK now **bundles the built cloud app** so it's a real offline app, not a
webpage. Edited: `capacitor.config.ts` (webDir → `dist-cloud`, no server.url), `newui/flag.ts`, `offline.ts`,
`cloud/api.ts`, `store.ts`, `newui/screens/{MobileEditor,Editor}.tsx`, `.github/workflows/android-apk.yml`.
- **Offline editing/export** work with no connection (all client-side: import/split/trim/cut/preview + the
  WebCodecs → hardware-codec export). **Online features** (login, project sync, Cut Lord, captions) reach
  **Supabase at its absolute URL** — `invokeEdge` already falls back from `/edge` (localhost 404) to the
  direct `sb.functions.invoke` URL, and the cloud CSP `connect-src` already lists the Supabase origin.
- **Build flags** (baked by the workflow): `VITE_FORCE_NEWUI=1` → `isNewUi()` returns true (no query string /
  product domain on localhost); `VITE_CAPACITOR=1` → `probeServer()` uses `navigator.onLine` instead of the
  same-origin `/api/ping` (which doesn't exist under localhost). Supabase URL + PUBLIC anon key are embedded
  in the workflow env (they ship in every client bundle; safe).
- **Gallery vs storage picker** (user ask): cloud `openMediaDialog`/`openMediaDialogMulti` accept narrowed to
  `video/*,image/*` so Android opens the **gallery/photos** picker; new cloud `openAudioDialogMulti`
  (`audio/*`) + a new store `addAudioToLibrary` action open **files/storage** for audio. Mobile MusicSheet +
  desktop-new-UI audio import now call `addAudioToLibrary`. Cloud-only — the shared `window.api` type +
  electron/webapi picker are untouched (desktop unaffected). NOTE: `main`'s `cloud/api.ts` has a newer
  iOS-detached-input picker (`openPicker`) that 0.01 lacks — carry that fix into 0.01 when convenient.
- **Workflow**: `npm ci` (electron/pw binary downloads skipped via env) → `npm run build:cloud` (with the
  flags + Supabase env) → `npx cap sync android` → `gradlew assembleDebug`. First run GREEN (`29961552244`,
  ~3 min). APK **34.8 MB** (bundles the app), same release tag `android-apk-0.01` → `app-debug.apk`.
- **Caveats** (device-only, untested here): preview smoothness is still bounded by the Android WebView
  decoder (proxy is the real fix); **login may need a Supabase redirect-allowlist entry if it's OAuth**
  (email/password works cross-origin as-is). A truly native ExoPlayer/MediaCodec player+exporter remains a
  separate large native track. Bundle is frozen at build time — re-run the workflow to refresh after changes.

### Offline APK: import fix + runtime permissions (0.01 only — `ca255a5`, `0662f2f`)
On-device: **import didn't open the gallery** and **no permission prompt**. Two fixes:
- **`ca255a5`** — the cloud picker (`cloud/api.ts`) created a DETACHED `<input>` and clicked it; the Android
  System WebView (like iOS Safari) ignores a click on an off-DOM input, so nothing opened. Ported `main`'s
  `openPicker` helper (appends the input to `document.body`, `oncancel` cleanup) — keeps the video/image vs
  `openAudioDialogMulti` accept split. Also declared media perms in `AndroidManifest.xml`
  (`READ_MEDIA_VIDEO/IMAGES/AUDIO`, legacy `READ_EXTERNAL_STORAGE` maxSdk 32).
- **`0662f2f`** — `MainActivity` now **requests the media permissions at launch**
  (`ActivityCompat.requestPermissions`, API-33 granular vs legacy) so the app shows the Allow-access prompt.
- The workflow's push-paths filter only watches the wrapper files, so an app/manifest fix needs a `# rebuild
  marker: vN` bump in `android-apk.yml` to trigger CI (or manual dispatch). Both runs GREEN (`29963083280`,
  `29963083280`→v4); APK republished at tag `android-apk-0.01`.
- **Native track (agreed with user, NOT started):** true native ExoPlayer player + Media3/MediaCodec export.
  Hard prerequisite first — the app keeps imported media as **browser blobs** the native side can't read; a
  native file-URI bridge (native picker + `convertFileSrc`) must land before any native player/exporter.
  Plan is incremental + device-tested per step (perms ✓ → file bridge → native export → native player); do
  NOT big-bang untested native code. Waiting on the user to confirm this perms/import APK works first.
- **NOTE for whoever merges 0.01 → main:** `main` already has the newer `openPicker` in `cloud/api.ts`; the
  `main`-side conflict is only the accept types + `openAudioDialogMulti` (0.01 additions).
