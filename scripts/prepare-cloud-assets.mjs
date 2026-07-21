// Stage the static assets the cloud build serves from /vad/ — the Silero VAD
// ONNX model(s) + worklet from @ricky0123/vad-web and the onnxruntime-web
// wasm runtime. Copied into .cloud-public/ (gitignored), which
// vite.config.cloud.ts uses as publicDir.
import { copyFileSync, mkdirSync, readdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, '.cloud-public', 'vad')
mkdirSync(outDir, { recursive: true })

/** Copy every file in dir matching re; ok if the dir is missing. */
function copyMatching(dir, re) {
  if (!existsSync(dir)) {
    console.warn(`[cloud-assets] missing: ${dir} (npm install?)`)
    return 0
  }
  let n = 0
  for (const f of readdirSync(dir)) {
    if (!re.test(f)) continue
    copyFileSync(join(dir, f), join(outDir, f))
    n++
  }
  return n
}

const vadDist = join(root, 'node_modules', '@ricky0123', 'vad-web', 'dist')
const ortDist = join(root, 'node_modules', 'onnxruntime-web', 'dist')

const nVad = copyMatching(vadDist, /\.(onnx|worklet\.bundle\.min\.js)$|^vad\.worklet/)
const nOrt = copyMatching(ortDist, /^ort-wasm.*\.(wasm|mjs|jsep\.mjs)$|^ort\..*wasm.*\.(wasm|mjs)$/)

console.log(`[cloud-assets] staged ${nVad} vad-web + ${nOrt} onnxruntime files -> ${outDir}`)
if (!nVad || !nOrt) process.exitCode = 1
