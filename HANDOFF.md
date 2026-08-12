# HANDOFF — EaseCutPro (2026-08-13)

> Current entry point. Older, still-valid handoffs:
> `HANDOFF-TIMELINE-MIGRATION.md` (doc-driven timeline),
> `HANDOFF-NATIVE-WINDOWS.md` (the brief this session answered),
> `HANDOFF-NEXT.md` (2026-07-10 session).

This session took the desktop build from "web app in an Electron shell" to a
publishable Windows app, then spent most of its time on **performance and
correctness on low-end machines**. Everything below was measured, not assumed —
where a number appears, it came from a run on this machine.

---

## 0. Where things are

| | |
|---|---|
| **Repo** | `C:\easecutpro` — fresh clone of `main`, deps installed. **Use this one.** |
| ~~`C:\easecutpro-main`~~ | stale snapshot, ~8700 lines behind on `store.ts`. Delete when comfortable. |
| **GitHub** | `tayz07814-ctrl/easecutpro` (public), default branch `main` |
| **Web** | Vercel auto-deploys `main` → easecutpro.com. Pushing IS deploying. |
| **Installer** | `release\EaseCutPro-Setup-0.1.0.exe` (~230 MB, ffmpeg bundled) |

**Gitignored assets a fresh clone will NOT have** — carry them by hand:
`resources/bin/` (ffmpeg.exe + ffprobe.exe, ~194 MB) and `.env`
(`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`).

**npm 11 blocks postinstall scripts.** A plain `npm install` leaves Electron and
esbuild unpacked and nothing works. Fix:
`npm approve-scripts electron esbuild && npm rebuild`. If Electron still won't
launch, extract `%LOCALAPPDATA%\electron\Cache\electron-v31.7.7-win32-x64.zip`
into `node_modules/electron/dist`.

---

## 1. What the desktop build is now

**A hybrid: native media, cloud brains.** Media (import, preview, waveform,
filmstrip, export) runs through the bundled ffmpeg on the user's machine. Auth
and every AI feature go through Supabase — the same edge functions the web app
uses — so **the installer ships with no API keys** and every AI run is
authenticated and metered per account.

Key flags in `platform.ts`:
- `IS_WEB` — no Electron preload (`window.api` absent)
- `IS_CLOUD` — the cloud **web shell** (Vercel build)
- `IS_DESKTOP_CLOUD` — the desktop hybrid
- `IS_CLOUD_BACKEND` — `IS_CLOUD || IS_DESKTOP_CLOUD`. **Use this one** whenever
  the question is "does this go through Supabase?" Several bugs this session
  were `IS_CLOUD` where `IS_CLOUD_BACKEND` was meant.

`window.api` is contextBridge-frozen, so the AI methods are **not** monkey-
patched onto it — call sites use `aiApi()` (`cloud/desktopHybrid.ts`). Assigning
to `window.api` throws and blanks the app (that was the black-screen bug).

---

## 2. Performance work — the measured findings

Each of these was found by instrumenting the packaged app over the Chrome
DevTools Protocol, not by reading code. **Three theories were wrong before the
measurement was right** — measure first.

### Preview stutter: decoder thrash, not decode speed
110 decoder restarts in 10s (~11 seeks/second), 3868 ms cumulative stall — 39%
of playback. Hardware decode was fine; media I/O was fine (75 MB/s).

Two rules each forced a seek per cut. Phone H.264 keyframes sit ~3s apart, so a
seek re-decodes up to a whole GOP. Now a **forward** jump inside one GOP decodes
*through* the cut (`FORWARD_DECODE_S`, wcPlayer.ts) and pre-warm skips seams the
live pipe will pass anyway. **110 → 3 restarts, 3868 → 151 ms, 21.8 → 27.7 fps.**

Frame-skip is deliberately **jump-gated**: discarding every merely-late frame
measured *worse* (12.6 fps) because most frames are slightly late.

### Export progress loop: the bar lied, the export was fine
"Climbs to 30-70% then restarts, forever." A live capture showed the real
percentages perfectly monotonic. The smoother advanced at a floor of 1.5%/s
regardless of the job and reset when the truth fell 25 points behind — a
10-minute render moves ~0.17%/s, so the fake creep outran reality and tripped
its own reset. `scripts/verify-progress-smoothing.ts` fails the old maths with
20 resets on a 10-min job, 67 on a 30-min one, 0 on an 8-second one (which is
why short exports never showed it).

### Startup: −566 KB
`@ricky0123/vad-web` was a static import and drags the whole onnxruntime-web JS
with it, so every launch parsed a neural VAD that only runs on Clean Silence.
Lazy now. Startup chunk **2772 → 2206 KB**.

### Idle CPU: 60 fps → ~10 fps
The preview reconciler is one rAF loop with `[]` deps — it repainted 60×/s for
as long as the editor was open. Paused, it now works ~10×/s; a moved playhead
releases the throttle instantly so scrubbing is unchanged. **Playback untouched.**

### Filmstrip: 6.1× faster, memory bounded, zoom-aware
`-vf fps=1/N` is an *output* filter — ffmpeg decoded **every frame** and threw
almost all away (~18,000 frames for ~300 stills on a 10-min clip).
`-skip_frame nokey` moves the work into the decoder: **1300 → 212 ms**. Count is
capped (`MAX_STRIP_FRAMES`), and zooming in fetches a **detail strip for the
visible window only** (50 frames at 0.2s over 10s in 90 ms).

### Giant canvases (the white waveform)
Both timeline strips rasterised the **whole clip**. At zoom a clip measured
**182,200 px** wide — past the browser's max canvas dimension, so the backing
store fails and paints solid white. Both now rasterise only the visible window.
**This scales with duration × zoom**, so capping zoom does not fix it: a 60-min
clip passes the limit at ~18 px/s. `MAX_ZOOM` was still lowered 6000 → 2000 as a
sane guardrail (a frame is ~65 px at 30 fps there).

### ffmpeg concurrency + caching
Heavy ffmpeg work queues through a 4-slot gate (`runGated`) — creators saw 4-7
processes fighting on weak laptops. `ffprobe` is deliberately **not** gated.
Waveforms and filmstrips cache by file identity (path+size+mtime) in memory and
on disk (`~/.easecutpro/cache/media`): **69 ms cold → 3 ms in a fresh process**.
The import wizard pre-decodes them behind its 1-100 bar so the editor opens ready.

---

## 3. Traps that cost real time here

- **Never override a positioned element's `position`.** `.ec-tl-filmstrip` is
  `position:absolute; inset:0`; adding inline `position:relative` dropped
  `inset:0`, collapsed the box to 0×0 and blanked the strip. An absolutely
  positioned element is *already* a containing block.
- **A provider that returns a new array every call causes a render loop.**
  `getFrames` merging with `[...a, ...b].sort()` re-ran the strip's effect →
  setState → render → new array. That was the "thumbnails glitching". Memoise
  against the inputs.
- **Size guards must be non-terminal.** `if (w<=0) { setTiles([]); return }`
  turns a transient measurement into a permanently blank component. Return
  without clearing and wait for the observer.
- **Occluded windows throttle rAF/timers to ~1 Hz.** Measure with
  `--disable-features=CalculateNativeWinOcclusion`
  `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding`
  or every number is garbage.
- **CSP:** the packaged page needs `'wasm-unsafe-eval'` or onnxruntime cannot
  compile and silence detection dies silently. It also needs the Supabase
  `connect-src` entries.
- **`file://` can't fetch siblings** — the VAD assets are served over a custom
  `ecvad://` scheme from `out/renderer/vad`.

---

## 4. Verification tooling

`npx tsx scripts/<name>.ts` — all green as of this handoff:

| harness | what it protects |
|---|---|
| `verify-progress-smoothing` | the export bar can never run away or reset |
| `verify-export-progress` | real montage export: monotonic, no ffmpeg pile-up |
| `verify-framestream` | rotation-aware probe, frame byte math, preview WAV format |
| `verify-silence-mastery`, `verify-retakeaware`, `verify-cutlord` | cut engines |
| `verify-smoothseams`, `verify-clipkeep-parity`, `verify-timeline-exporttransform` | export parity |

**Driving the packaged app**: launch with `--remote-debugging-port=9223` plus the
occlusion flags, then drive it over CDP (open a project by clicking a card,
press play, sample the canvas). That is how the seek storm and the progress loop
were found. Diagnostics left in on purpose: `window.__wcStats` (restarts, paint
sources), `window.__ecSkipMode` (A/B the skip policy without a rebuild),
`window.__jobLog` (every job-bar transition), `window.__openPricing`.

---

## 5. Open threads

**Blocking commercial sale**
1. **Code signing** — none configured. An unsigned installer triggers SmartScreen
   "Windows protected your PC" on every download. Needs an OV/EV certificate or
   Azure Trusted Signing.
2. **Auto-update** — no `electron-updater`, no publish feed. Every fix currently
   means a manual re-download.
3. **App icon** — still stock Electron. The brand mark is committed at
   `seo/favicon.svg`.
4. `FREE_MINUTES = 20` in `cloud/subscription.ts` is flagged in-code as a testing
   value to "harden server-side before public launch".

**Unverified (needs a human)**
- A long export end-to-end on the 8th-gen laptop — the whole point of the perf
  work, still not run there.
- A paid checkout end-to-end on a **non-Pro** account (webhook → Pro unlock).
- Desktop AI run signed in (transcribe → cuts) — code paths verified, not a live run.

**Worth knowing**
- Silence debug telemetry now uploads from desktop too, tagged
  `platform: desktop|web`. It contains transcript-derived data — make sure the
  privacy policy covers it.
- Judges run at `reasoning: 'high'` (the ceiling). If long transcripts start
  falling back to `deepseek-v4-pro`, set `ULTRACUT_REASONING_EFFORT=medium` in
  Supabase secrets — takes effect without a redeploy.
- Branch `claude/native-apk-build-status-7xxie2` holds substantial Flutter/Android
  work that is **not** on `main`.
