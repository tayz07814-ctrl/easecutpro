# EaseCutPro — Timeline Migration Handoff

> Read this first when picking up the "document-driven timeline" work. Companion
> memory: `~/.claude/projects/C--easecutpro/memory/easecutpro-doc-timeline.md`
> (auto-loaded). Approved plan: `~/.claude/plans/moonlit-swinging-waffle.md`.

## 0. Latest session — overnight fix batch (all typecheck+build+pure-suites green)
Done this session (each needs a LIVE smoke test — agent can't drive the Electron GUI):
- **Basic tab shows main-lane clip settings** — `findDocMainClip` + a base-clip editor (info /
  split / delete / detach audio) in `BasicPanel.tsx`. (Transform/zoom deferred to doc-native motion.)
- **Transcript word highlighter aligned** — single-source doc timelines run the playhead in EDITED
  time but words are SOURCE time; `docEditedToSource`/`docSourceToEdited` in `TranscriptPanel.tsx`
  map both ways through the main lane (guarded to single-source; montage/legacy untouched). Fixes the
  highlight AND double-click-to-seek. Verified with a headless domain harness.
- **Magnet-off gaps play as BLACK** — `SequencePreview` now runs the transport in real timeline time
  in doc mode (editedStart==start, editedTotal==total incl. gaps) and the rAF loop TRAVERSES dead
  space on the wall clock (video paused, `inGap` shows black), resuming at the next clip. Slider maps
  straight to real time so scrubbing parks in the gap.
- **Reopen-black fixed** — cached media fires `loadedmetadata` before the remounted <video>'s handler
  attaches, so the initial seek never ran → black. Added a `readyState>=HAVE_METADATA` catch effect in
  `SequencePreview` (guarded against double-seek).
- **Drag-resizable panels** — the dividers already existed; the real bug was CSS `min/max-width` on
  `.col-left/.col-right` fighting the inline drag width. Removed them (JS clamps govern), widened
  dividers to 8px + centre grip, and locked cursor/selection during the drag (`App.tsx`, `styles.css`).
- **Cut-engine seam quality in doc mode** — the cut routing now passes the media waveform to
  `computeKeepRanges`, so Fast/Pro/word/silence seams valley-snap + edge-blip-absorb like legacy
  (`TimelinePanel.tsx`). Cleaned a dead ternary in `smartsmooth.ts` finalizer.
- **Mobile UI** — bigger touch targets (transport, zoom, sheet close), safe-area floor, export-chip
  grid, and short/narrow/landscape media queries (`styles.css`).

NOTE: detection-heuristic tuning for Fast/Pro cut was deliberately NOT changed blind — those engines
are tuned + tested; recall/precision changes need real-media A/B validation (do interactively).
Deferred (unchanged): the doc-native rip-out chain (§6b: timeline-always-authoritative → remove dead
legacy → remove overlay/text creation). Not tackled tonight — runtime-risky, needs live testing.

## 1. Goal (user's directive)
Make the from-scratch multi-track timeline the **real, persistent source of truth** —
**no "flatten to video,"** drag any clip into any lane, every function works natively
on a **multi-clip main lane**, and preview + export reflect the document.

## 2. Architecture ("document mode")
Document mode activates the moment the user makes any timeline edit: `project.timeline`
(a `TimelineDocument`, see `src/shared/types.ts:290`) gets set (lazy migration). From
then on the document is authoritative and is **never** rebuilt from the legacy fields.

- **Engine** (`src/shared/timeline/engine.ts`) holds the undoable document. Framework-
  agnostic; UI subscribes via `useSyncExternalStore`.
- **`TimelinePanel.tsx`** owns the engine and: (a) hydrates from `project.timeline` if
  present else `projectToDocument(project)`; (b) persists every edit to `project.timeline`
  via the `setTimelineDoc` store action, guarded by an `applying` ref + `lastDoc` identity
  check; (c) the legacy `sig`-rebuild ONLY runs while `project.timeline` is unset.
- **Shared engine handle** (`src/renderer/src/timelineEngine.ts`): `setSharedEngine` /
  `getSharedEngine` / `useSharedEngineSnapshot`. Lets the preview + panels (outside the
  timeline tree) read AND edit the same document.
- **Preview**: `VideoPreview.tsx` routes to `SequencePreview.tsx` when `project.timeline`
  exists. `SequencePreview` in `docMode` builds main-lane segments from the doc, plays them,
  composites `OverlayLayer`/`TextLayer` (doc-aware), and mixes doc audio lanes via `DocAudio`.
- **Export**: `store.exportVideo` folds `documentToProject(project.timeline, project)` so the
  rendered file matches the preview (reuses the existing ffmpeg montage compositor).

### Key conventions
- **Overlay placement** lives on the doc clip's `metadata`: `ovX`, `ovY` (top-left frac),
  `ovScale` (width frac), `ovZoomStart`/`ovZoomEnd` (Ken Burns), plus first-class `clip.crop`.
  Round-trips via `bridge.ts` `overlayMetadata()` / `legacyClipFrom()`.
- **Text position**: `clip.transform.x.static` / `y.static` = offset-from-centre (legacy x/y
  are centre fracs, so forward bridge does `x - 0.5`).
- **Playhead domain**: in doc mode `store.project.playhead` = **edited seconds**;
  `TimelinePanel` maps it directly to engine frames (`secondsToFrames`/`framesToSeconds`, no
  cut-collapse). `SequencePreview` docMode anchors each seg at its **real** timeline position
  `framesToSeconds(clip.start)` (so magnet-off GAPS are honoured) and keeps `editedStart` =
  collapsed sum for the transport slider only.
- **Cuts**: `documentMainKeeps(doc)` + `applyDeletionsToDocument(doc, trackId, ranges)` already
  exist in `model.ts` for routing cut ranges into the main lane (needed for Stage 4 #1).

## 3. Stage status
- **Stage 0 — Toolbar** ✅ (`TimelineToolbar.tsx`: Magnet/Snap/Wave%/Detach/+Track/Import/Undo/Redo)
- **Stage 1 — Persist & authoritative document** ✅
- **Stage 2 — Doc-driven preview** ✅
- **Stage 3 — Doc-driven export** ✅
- **Stage 4 — Coherence** ⏳ PARTIAL — cut→doc, audio-export, drop-insert, Ken-Burns-rip-out DONE;
  then user pivoted to full doc-native rip-out (retire legacy, timeline always authoritative). See §6/§6b.
- Extras done: drag-drop library→lane; Basic tab doc-aware; many bug fixes (§5).

## 4. Git
- Repo INITIALIZED this session (`.git` was empty/broken before). Branch **main**.
- Initial commit **caf1d98** contains the whole codebase + all migration work. Working tree
  was clean at handoff. `node_modules`, `out/`, `release/`, `resources/bin*`, `resources/models`,
  `tools/`, `test videos/`, `*.env`, `*.log` are git-ignored.

## 5. Confirmed working / fixed this session
Toolbar · drag-drop media onto lanes · splits persist · overlays survive Fast/Pro cut.
Fixes: overlay-reset-after-cut; ffmpeg thumbnail error flood (images bypass ffmpeg in
`mediaManager.getFrames`, waveform/thumb failures cached — no infinite retry); split-vanishing
(removed the destructive main-lane rebuild); per-clip waveform slicing (`MediaData.clipPeaks`,
used by `ClipView`+`MobileTimeline` — was drawing the whole file per split); magnet-off gap =
black in preview; detached audio no longer double-plays in the preview (base `<video>` muted
when the active main clip's `audioDetached`/`muted`); Basic tab edits selected overlay in doc
mode; paused-preview re-seek + re-mount seek.

## 6. Stage 4 plan — status (PIVOTED mid-session, see §6b)
1. **Cut engine → document** ✅ DONE. `removedRangesToMainFrames` (bridge.ts) maps removed
   base/virtual-second ranges → main-lane edited-frame ranges by SOURCE intersection (already-cut
   footage maps to nothing → idempotent, manual splits/drops survive); a cut-signature effect in
   `TimelinePanel.tsx` dispatches `Commands.applyDeletions`. Test: `verify-timeline-cutroute.ts`.
   Known gap: RESTORING a cut word can't re-add footage to the edited lane (no-op in doc mode).
2. **Detached/extra audio in export** ✅ DONE. `documentToProject` mutes detached/muted base
   segments and folds ALL doc audio lanes into `ExtraAudioClip[] project.extraAudio` (music slot
   cleared); `ffmpeg.ts` mixes them, GATED so legacy exports (no extraAudio) stay byte-identical.
   Test: `verify-timeline-audioexport.ts`.
3. **Drop onto main at drop point** ✅ DONE. `insertClipIntoMainInDoc`/`Commands.insertToMain`
   (boundary insert by midpoint rule + ripple); `Timeline.tsx` onDrop uses it. Test: `verify-timeline-insert.ts`.

## 6b. PIVOT (user directive this session): go fully doc-native, retire legacy
The user chose **full rip-out** of legacy + **timeline document ALWAYS authoritative** (retire
single-clip mode; auto-migrate every project to a doc on import). Zoom/pan/auto-zoom + overlays +
text will be REBUILT doc-native later. Remaining work, IN THIS ORDER (they are interdependent):

- **Ken Burns rip-out** ✅ DONE this session. Deleted `baseZooms`/`baseKeyframes`/`ZoomKeyframe`/`Ease`
  from types, `src/shared/motion.ts` (whole file), the ffmpeg base-zoom zoompan block + `fnum`/`easeExpr`/
  `kfExpr` helpers (KEPT `zoompanStage`/`superFactor` — still used by OVERLAY clip zoom), the VideoPreview
  base-zoom effects, BasicPanel base-zoom+keyframe UI, store `setBaseZoom`/`add|update|removeBaseKeyframe`,
  MCP `set_base_zoom`, TranscriptPanel "Auto Zoom" button. Deleted `verify-zoom-smoothness.ts`/`verify-keyframe-export.ts`.
- **#4 Timeline ALWAYS authoritative** ⏳ NEXT (keystone; RUNTIME-RISKY, needs live test). Every project
  gets `project.timeline` from import so the app is always doc-mode. Cleanest = rework the TimelinePanel
  sync spine: build+persist the doc when a `baseStructureKey` (media path/dur + baseSequence source ids —
  NOT cuts/tracks/texts/music) first appears or changes; cuts route incrementally (already), manual doc
  edits persist and are never rebuilt away. Seeding at the many import entry points is fragile (structure
  can change after seeding) — prefer the structural-key approach. Editor already co-mounts VideoPreview +
  TimelinePanel (App.tsx:144/153), so the shared engine is always available.
- **#6 Remove dead legacy preview/export** ⏳ AFTER #4. Once always-authoritative, delete VideoPreview's
  legacy single-clip player block + its zoom-less playback effects (SequencePreview is the only path), and
  any single-clip-only ffmpeg branches doc export doesn't reuse. Also verify re-drop-black is gone (live).
- **#7 Remove legacy overlay/text CREATION** ⏳ AFTER #6 (BLOCKED: legacy TextLayer/OverlayLayer still call
  updateText etc.). Then delete: store creation actions (addOverlayAsset/updateOverlayRule/removeOverlayAsset/
  generateOverlays/clearGeneratedOverlays + addText/updateText/removeText), `overlayAssets`/`overlayRules` on
  Project, OverlayPanel.tsx, TextPanel.tsx, `main/overlay-rules.ts`, `shared/overlay.ts`, ToolsPanel text+overlays
  tabs, TranscriptPanel ZoomBroll, MobileApp usages, MCP `add_broll`/`add_text`, the generateOverlays IPC chain
  (preload/main/server/webapi/ipc). KEEP doc overlay/text lanes + rendering + bridge migration (open old projects).

Build/verify each step: `npm run typecheck && npm run build`; timeline suite = all `scripts/verify-timeline-*.ts` (12, green).

## 7. Crucial files to read (why)
- `src/shared/types.ts` — `Project` (esp. `timeline?`), legacy `Clip`/`SequenceClip`/`TextClip`.
- `src/shared/timeline/types.ts` — doc `Clip`/`Transform`/`Crop`/`Track`/`TimelineDocument`.
- `src/shared/timeline/model.ts` — doc ops: split/trim/move/magnet, `documentMainKeeps`,
  `applyDeletionsToDocument`, `detachAudioInDoc`, `setClip{Metadata,CropInDoc,TransformStatic}`.
- `src/shared/timeline/commands.ts` — command vocabulary (setOverlayPlacement/Crop, applyDeletions…).
- `src/shared/timeline/bridge.ts` — `projectToDocument` (forward) / `documentToProject` +
  `legacyClipFrom` (reverse) / `projectStructureKey`.
- `src/renderer/src/components/timeline/TimelinePanel.tsx` — the sync spine (persist/hydrate/rebuild).
- `src/renderer/src/timelineEngine.ts` — shared engine handle.
- `src/renderer/src/components/SequencePreview.tsx` — doc-driven playback (segs/gaps/mute/DocAudio/seek).
- `src/renderer/src/components/{OverlayLayer,TextLayer,BasicPanel}.tsx` — doc-aware panels/layers.
- `src/renderer/src/store.ts` — `setTimelineDoc`, `exportVideo` fold, legacy cut actions.
- `src/main/ffmpeg.ts` — `exportProject`, `extractThumbnails`.

## 8. Build / verify
- `npm run typecheck` (node + web), `npm run build` (electron-vite). Both clean at handoff.
- Engine unit harnesses: `npx tsx scripts/verify-timeline-core.ts` (+ other `verify-timeline-*`).
- Electron dev: `npm run dev`. Web mode: `npm run web` (Express).

## 9. Gotchas / working agreements
- **Cannot drive the Electron GUI from the agent** — the user is the live tester; verify with
  typecheck/build + reasoning, hand off for live checks.
- **Reporting style**: code silently (no step-by-step narration), give a **3-4 line** summary at
  the end, and **ask before editing big/core files** (store, preview, ffmpeg, shared model).
- **Do NOT restart the web server / cloudflared tunnel** unless asked (user tests live from phone).
- The removed main-lane rebuild means **legacy Fast/Pro cuts don't auto-reflect in doc mode**
  until Stage 4 #1 — this is intentional (it was wiping manual edits), not a regression to "fix"
  by re-adding the rebuild.
