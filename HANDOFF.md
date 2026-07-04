# EaseCutPro — Timeline Migration Handoff

> Read this first when picking up the "document-driven timeline" work. Companion
> memory: `~/.claude/projects/C--easecutpro/memory/easecutpro-doc-timeline.md`
> (auto-loaded). Approved plan: `~/.claude/plans/moonlit-swinging-waffle.md`.

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
- **Stage 4 — Coherence (cuts/motion/audio/drops)** ⏳ NOT STARTED — see §6.
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

## 6. Stage 4 plan (ordered most-broken → nice-to-have)
1. **Cut engine → document** *(biggest; unblocks transcript workflow in doc mode)*. Fast/Pro
   Cut, silence, word/filler deletes still write only the legacy transcript. Since the
   destructive rebuild was removed, they no longer touch the doc main lane. Route their
   deletions into the main lane (ripple-delete via `Commands.applyDeletions`) **without**
   wiping manual splits/drops. Touch: `store.ts` cut actions (`selectFastCuts`, `runProCut`,
   `deleteSelected`, silence apply), `TimelinePanel.tsx`, `commands.ts`/`model.ts`.
2. **Detached audio in export** — mute fix is preview-only; `documentToProject` drops audio
   lanes and keeps the video's own audio. Fold audio lanes through the export.
3. **Drop onto main at the drop point** (insert + ripple) instead of append-to-end — see the
   `onDrop` handler in `Timeline.tsx` (uses `C.importToMain` which appends).
4. **Base Ken Burns → document** — migrate legacy `baseZooms`/`baseKeyframes` into main-lane
   clip transform keyframes on hydrate; wire the zoom UI + doc preview (base zoom not shown in
   doc mode). Touch: `bridge.ts`, `SequencePreview` render, `BasicPanel` base branch, `motion.ts`.
5. **Legacy panels → document** — "Generate overlays" (AI) + `TextPanel` add-text write legacy
   fields; route them into the doc so they appear in doc mode. Plus base-clip Basic-tab editing.
6. **Verify re-drop-black is gone** — should be fixed by the `onLoaded`/gap seek changes.

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
