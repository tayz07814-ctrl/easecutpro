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
`easecut0.01` = **e4ed28e**. Tests alternate LLM cut judges via OpenRouter (the key stays
**server-side** in the `ultracut-judge` edge fn). The user tests these manually; main is unaffected.
- **Retake Beta** button → `meta-llama/llama-4-maverick` (promptVariant `sharp`, reasoning off). `e4ed28e`.
- **Ultracut Beta** button → `deepseek/deepseek-v4-flash`. `225b033` / `48b299d`.
- **Premium Cut** (3rd button) → Gemini 3.5 Flash multimodal cut engine + smooth-seam margins (100 ms
  lead-in / 300 ms tail). `78a7fe8` / `9af9445`.
- Edge fn `ultracut-judge` `MODEL_WHITELIST` includes `meta-llama/llama-4-maverick`.
- A/B (main-logged transcripts): Maverick faster / more reliable; DeepSeek more conservative, slower,
  occasional timeouts.
