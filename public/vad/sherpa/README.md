# ten-vad (sherpa-onnx WASM) — opt-in alternate VAD

Flag-gated alternate to the default Silero VAD. Code lives in
`src/renderer/src/cloud/tenvad.ts`; the engine is selected in
`src/renderer/src/cloud/vad.ts` (`vadEngine()`). Silero stays the default —
nothing here affects production until you flip the flag.

## 1. Drop the assets here (`public/vad/sherpa/`)

From a **k2-fsa/sherpa-onnx** release's `wasm/vad` build:

- `sherpa-onnx-wasm-main-vad.js`   (Emscripten glue)
- `sherpa-onnx-wasm-main-vad.wasm`
- `sherpa-onnx-wasm-main-vad.data` (only if the build ships one)
- `sherpa-onnx-vad.js`             (JS wrapper — defines `createVad()`/`Vad`)

And the model (rename to `ten-vad.onnx`):

- `ten-vad.onnx`   (sherpa's ten-vad export)

> Do **not** commit these binaries to git — they're multi-MB. Keep them local /
> in the deploy artifact only (this dir is `.gitignore`-worthy for `*.wasm`,
> `*.data`, `*.onnx`).

## 2. Turn it on (per browser, no redeploy)

In the app's devtools console:

```js
localStorage.setItem('ec:vadEngine', 'tenvad')   // 'silero' or clear to go back
```

Then run a Retake / silence pass. Watch the console for `ten-vad:` errors.

## 3. Verify before making it the default

The audio pipeline (16k resample → windowed `acceptWaveform` → drain) is
straightforward; the **only** parts that can differ between sherpa builds are the
module loading and the exact `createVad`/drain method names — the spots marked
`⚠️ NEEDS BROWSER VERIFICATION` in `tenvad.ts`. Confirm on a few real clips that
silence lands where you expect, then we flip the default in `vadEngine()`.
