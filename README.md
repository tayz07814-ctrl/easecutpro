# EaseCutPro

An **offline, native Windows** transcript-based video editor — a lightweight, Descript-style tool.

- 🎙️ **Automatic transcription** (word-level timestamps), 100% offline
- ✂️ **Transcript editing** — select words/sentences and delete to cut the video
- 🔇 **Silence removal** — detect pauses, then shorten or remove them
- 🧲 **Timeline** with magnet/snap, manual clip drag, split
- 🎬 **3 stacked tracks** — base A-roll (derived from the edit) + 2 overlay/B-roll tracks
- ⬆️ **Export** to MP4 via ffmpeg

Built with **Electron + React + TypeScript**, **ffmpeg**, and **whisper.cpp**.

---

## Run it

```powershell
npm install      # deps (Electron, React, Vite, etc.)
npm run dev      # dev mode with hot reload
# or
npm run build    # build bundles
npm run start    # run the built app
npm run dist     # package a Windows installer (.exe via electron-builder)
```

### Requirements
- **Node.js** 18+ (tested on 26)
- **ffmpeg + ffprobe** on PATH (or dropped into `resources/bin/`). Already detected if `ffmpeg -version` works.

---

## Transcription: stub vs. real

Out of the box, EaseCutPro generates a **placeholder transcript** so you can try the
full editing flow immediately. The toolbar shows `Whisper: stub` until a real engine is present.

To enable **real offline transcription** with [whisper.cpp](https://github.com/ggerganov/whisper.cpp):

1. Get a whisper.cpp Windows build (`whisper-cli.exe`, or `main.exe`). Either
   download a prebuilt release or build it yourself.
2. Download a model, e.g. `ggml-base.en.bin` (good speed/accuracy balance) from
   the whisper.cpp model repo.
3. Place them here:

   ```
   resources/
     bin/
       whisper-cli.exe        # (or whisper.exe / main.exe)
     models/
       ggml-base.en.bin       # (or ggml-small.en.bin, etc.)
   ```

4. Restart the app. The badge should switch to `Whisper ✓`. Re-import your media
   to get a real, word-accurate transcript.

> The transcription wrapper invokes whisper.cpp with `-oj -ml 1 -sow` to get
> per-word JSON timestamps, which power the "delete words = cut video" feature.

---

## How the editing model works

- **Base track (A-roll)** is *derived*: the app computes **keep ranges** =
  full source minus (deleted words) minus (removed/shortened silences).
  The preview plays the source and **skips cut regions** automatically.
- **Overlay tracks 1 & 2** hold manually placed B-roll/overlay clips you can
  drag (with magnet snapping to clip edges, cut boundaries, and the playhead),
  split at the playhead, and delete.
- **Export** re-stitches the kept ranges with ffmpeg (`trim`/`concat`).

### Keyboard
- `Del` / `Backspace` — cut selected transcript words
- `Esc` — clear selection
- Click / Shift-click / Ctrl-click — select words; double-click a word to play

---

## Project structure

```
src/
  shared/      types, IPC channel names, keep-range math (used by main + renderer)
  main/        Electron main: ffmpeg wrapper, whisper wrapper, IPC, file dialogs
  preload/     contextBridge API exposed to the renderer
  renderer/    React UI: Toolbar, VideoPreview, TranscriptPanel, SilencePanel, Timeline
```

---

## Status / roadmap

This is a working MVP foundation. Natural next steps:
- Overlay clips actually composited into the export (currently base-track export)
- Clip trimming handles (resize in/out on the timeline)
- Undo/redo history
- Waveform rendering on the base lane
- Per-overlay volume / opacity / position controls
