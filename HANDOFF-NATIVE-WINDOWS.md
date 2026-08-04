# Prompt: native Windows build (ffmpeg instead of WebCodecs / wasm)

Copy everything below the line into Claude Code after cloning this repo on Windows.

---

## Goal

This repo already ships an Electron desktop app, but its renderer was built
web-first: preview, export, waveforms, thumbnails and audio extraction all run
through WebCodecs, WebAudio and mediabunny/ffmpeg.wasm inside the webview, even
when running in Electron. I want the **Windows desktop build to use the bundled
native ffmpeg for all of it** — faster, no browser codec limits, no wasm, and
correct A/V sync.

Do not delete the web paths. `easecutpro.com` (Vercel static + Supabase) ships
from the same renderer and must keep working exactly as it does today. Every
change branches on the existing platform flag.

## What already exists — do not rebuild

- **Electron shell**: `npm run dev`, `npm run build`, `npm run dist`
  (`electron-vite build && electron-builder --win`), `npm run package`
  (electron-packager win32).
- **Native ffmpeg module**: `src/main/ffmpeg.ts` — already has `probe`,
  `extractWaveform`, `extractThumbnails`, `exportProject`, `combineClips`,
  `extractAudioM4a`. Binaries resolve via `src/main/binaries.ts`.
- **IPC plumbing**: channel registry `src/shared/ipc.ts`, handlers in
  `src/main/index.ts` (`ipcMain.handle`), bridge `src/preload/index.ts`,
  renderer shim `src/renderer/src/platform.ts`.
- **Platform flag**: `IS_WEB` in `platform.ts` is `true` when `window.api` is
  absent (no preload). That is the branch point — use it, don't add a new one,
  and don't UA-sniff.

## The web-media code to route through native ffmpeg on desktop

Read each one first; several carry long comments explaining bugs that were
already fixed there. Do not regress those fixes — port them.

| File | What it does in the browser today |
|---|---|
| `src/renderer/src/export/localExport.ts` | WebCodecs export orchestrator (`FPS = 30`), OfflineAudioContext audio mix |
| `src/renderer/src/export/localExportMB.ts` | mediabunny variant of the same export |
| `src/renderer/src/export/encoderWorker.ts` | H.264 encode + MP4 mux worker |
| `src/renderer/src/export/decodeSource.ts` | mediabunny demux/decode |
| `src/renderer/src/export/overlays.ts` | canvas compositing for text/overlay bake |
| `src/renderer/src/preview/wcPlayer.ts` | WebCodecs preview player |
| `src/renderer/src/previewAudio.ts` | WebAudio gapless preview audio (`SeamlessAudio`) |
| `src/renderer/src/webmedia.ts` | browser decode: waveform, 16k WAV extract, thumbnails, MP4 `elst` parse |
| `src/renderer/src/components/DocPreview.tsx` | drives preview elements + the audio engine |
| `src/renderer/src/cloud/autoZoom.ts` | mediabunny frame sampling |

## Constraints

1. **Web build must not change behaviour.** `npm run build:cloud` must still
   produce a working browser app using the existing WebCodecs paths.
2. **One timeline model.** The document (`src/shared/timeline/`) is
   authoritative for both. Native and web exporters must produce the same cut
   points, durations and overlay placement from the same doc.
3. **No new fps guessing.** `webmedia.ts` currently hardcodes
   `fps: 30 // unknown in the browser`. On desktop, get the real fps, duration
   and rotation from `ffprobe` via the existing `probe` IPC and use it.
4. **Preview is not a drop-in.** ffmpeg cannot replace a realtime scrub/play
   loop by itself. Plan it explicitly before writing code — the repo already
   has a "preview proxy" precedent (flatten-and-play). Options: prerendered
   proxy, piped rawvideo into a canvas, or an embedded player. Tell me the
   trade-offs and let me pick before you build it.

## Known traps — read these before touching audio

- **Phone `.mov` audio delay.** QuickTime files carry an `elst` empty edit that
  delays the audio track. `decodeAudioData` discards it. `mp4AudioStartOffset()`
  and `padLeadingSilence()` in `webmedia.ts` recover it; ffmpeg does it with
  `aresample=async=1:first_pts=0`. Every audio path must apply one or the other.
  A path that misses it plays early and desyncs lip sync.
- **Frame-quantised video vs sample-exact audio.** `trim` keeps whole frames,
  `atrim` cuts at exact samples. If a per-segment mismatch is allowed, `concat`
  sums it across cuts and drift grows with cut count. `src/main/ffmpeg.ts`
  (`exportProject`) now pins both streams of each segment to the same
  `segDur` with `tpad`/`apad` + `trim`. `localExport.ts` `renderAudio` does the
  equivalent. Any new export path must do the same.
- **Both of the above are worst on variable-frame-rate `.mov`** (iPhone), which
  is the most common real input.

## Sequence

1. Survey and report first: what runs natively today, what still goes through
   WebCodecs/wasm in the Electron build, and the actual gap list. Do not start
   editing until I have seen it.
2. Propose the preview architecture (see constraint 4) and wait for my choice.
3. Then implement, smallest useful slices first, in this order:
   export → waveform/thumbnails → audio extraction → preview.
4. Bundle ffmpeg/ffprobe into the Windows artifact and confirm
   `src/main/binaries.ts` resolves them from the packaged app, not from PATH.

## Verify before you tell me it works

```
npm run typecheck        # node + web + edge
npm run build            # electron-vite
npm run build:cloud      # web build must still pass
npm run dist             # Windows installer
```

Then run the packaged app and check, on a real iPhone `.mov` with 20+ cuts:

- lip sync holds at the START, MIDDLE and END of the exported file
- preview lip sync matches the export
- waveform lines up with the picture
- export finishes faster than the current WebCodecs path

State plainly what you tested and what you did not. If you cannot verify
something, say so rather than assuming it works.
