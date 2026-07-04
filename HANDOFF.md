# EaseCutPro — Timeline Migration Handoff

> Read this first when picking up the "document-driven timeline" work. Companion
> memory: `~/.claude/projects/C--easecutpro/memory/easecutpro-doc-timeline.md`
> (auto-loaded). Approved plan: `~/.claude/plans/moonlit-swinging-waffle.md`.

## 0. Current state (all typecheck + build + 12 timeline verify-suites GREEN)
Everything below is verified headlessly (typecheck/build/pure tests) but NOT run — the agent can't
drive the Electron/mobile GUI, so **each feature needs a live smoke test**. Recent commits:
`ed6cb5b` (Stage 4 #1-3 + Ken Burns rip-out + preview/UX) · `822e481` (earlier) · `206b428` (black-frame
hardening, waveform bars, mobile split/trim/scroll) · then the **mobile CapCut UI** (this commit).

### Done & working (doc mode is authoritative once a project has `project.timeline`)
- **Cuts → document** (`removedRangesToMainFrames` in bridge.ts + a cut-signature effect in
  TimelinePanel.tsx; waveform passed so seams valley-snap). **Detached/extra audio in export**
  (`project.extraAudio` + generalized ffmpeg amix, gated so legacy exports are byte-identical).
  **Drop-at-point insert** (`insertClipIntoMainInDoc`).
- **Ken Burns base-zoom RIPPED OUT** end-to-end (types, motion.ts, ffmpeg base-zoom block, BasicPanel,
  store, MCP). Overlay-clip zoom kept.
- **Basic tab base-clip controls**: Size/Zoom/Pan/Speed/Volume for main-lane clips, rendered on the
  base `<video>` in SequencePreview (transform + `v.volume` + `v.playbackRate`; speed math is identity
  for un-sped clips). Commands: `setClipGain`, `setClipMetadata`, `setClipText`, `setClipSpeed`.
  **These now render IDENTICALLY in export** (was the #1 gap — see Known GAPS → DONE).
- **Text overlays doc-native** (TextPanel add/edit/style/position/delete via engine). **Overlay clips
  play their own audio** + Ken Burns rides the shared play clock (over gaps too). **Transcript word
  highlighter** maps edited↔source through the main lane (single-source guard).
- **Preview black-frame fixes** (the big recurring bug): remount seek via onLoadedData/onCanPlay +
  reset loadedSrcRef on unmount + re-key on segsKey + idempotent onLoaded + a fresh-mount NUDGE (writing
  currentTime 0 to a 0 element is a no-op → black); `displayIdx` shows the last frame past-the-end
  instead of black (interior magnet-off gaps still black). Removed the stale "Montage · N clips" badge.
- **Timeline**: lanes fill the measured viewport (no blank strip when zoomed out); waveform = teal
  vertical bars (mountains/valleys); always-visible desktop trim handles + touch trim on mobile;
  drag-resizable panel widths + per-track height (engine.applyLive).
- **Mobile CapCut UI** (NEW — `src/renderer/src/components/mobile/`): monochrome line-icon set
  (`Icon.tsx`); context dock (`MobileTools.tsx`) — nothing selected → Import media + Cut Lord; video/
  overlay clip → tool row (split/speed/zoom/crop/adjust/volume/animation/extract/remove-bg) each opening
  a CHILD PANEL; text + audio clips get their own toolbars; quick-action bar (replace/lock/duplicate/
  delete/more). Transport redesigned (undo/redo · play · keyframes · magnet/snap/delete, monochrome).
  `+` adds an overlay track; compact zoom on the timeline. MobileApp/MobileTimeline are doc-aware.

### Known GAPS / next work
- **EXPORT parity for base-clip transforms/speed/volume** ✅ DONE. `SequenceClip` now carries optional
  `speed/gain/size/zoomStart/zoomEnd/panX/panY`; `documentToProject` fills them from each main-lane doc
  clip (metadata `ov*` + `clip.gain/speed`) EXACTLY as SequencePreview reads them; `virtualKeepsToClipSegments`
  threads the owning `clipId` so the exporter maps each kept segment back to its clip. `concatSegmentsToFile`
  (the montage pre-concat) now applies per-clip Size/Zoom/Pan + speed + volume as filter chains — the no-effect
  graph is byte-identical (so legacy montage / flatten / combine are unchanged). Helpers in ffmpeg.ts:
  `baseTransformFilter` (CSS scale-about-focal-origin → crop for zoom-in / scale+pad for shrink / `zoompanStage`
  for animated Ken Burns) + `atempoChain`. GOTCHA baked in: a plain `fps` filter AFTER zoompan explodes the
  frame count (zoompan emits a tiny timebase) — the zoompan path rebuilds PTS from the frame index
  (`setpts=N/(fps*speed)/TB`) before conforming, and every transformed seg re-asserts `setsar=1` (concat rejects
  mixed SAR). Verified end-to-end with real ffmpeg (crop+pan, animated KB, shrink+pad, 1.5×/0.5× speed, gain) +
  `scripts/verify-timeline-exporttransform.ts`. Covers Electron + web export (both fold the doc client-side).
  Note: main-lane GAPS (magnet-off) are still collapsed by the concat, and an explicit `project.aspectW/H`
  override isn't applied to the montage canvas — both pre-existing, unchanged.
- **Mobile honest-STUBS** (toast "coming soon", no backing feature): Remove BG, live animation preview
  (choice is saved on clip.metadata.overlayAnimation), keyframes (◆ buttons), replace, lock, more, fade.
- **Detection-heuristic tuning** for Fast/Pro cut deliberately NOT changed blind — tuned + tested; needs
  real-media A/B validation.
- **Deferred doc-native rip-out chain** (§6b): timeline-always-authoritative → remove dead legacy
  preview/export → remove legacy overlay/text CREATION. Runtime-risky, needs live testing; not started.

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
