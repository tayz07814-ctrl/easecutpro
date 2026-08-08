// Stage the static assets the cloud build serves from /vad/ — the Silero VAD
// ONNX model(s) + worklet from @ricky0123/vad-web and the onnxruntime-web
// wasm runtime. Copied into .cloud-public/ (gitignored), which
// vite.config.cloud.ts uses as publicDir.
import { copyFileSync, mkdirSync, readdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
// Staged for BOTH shells: .cloud-public/vad is the cloud build's publicDir
// (served at /vad/); src/renderer/public/vad rides into the Electron renderer
// bundle (out/renderer/vad) so the desktop build's silence engine has the
// same assets — served there via the ecvad:// protocol (file:// pages can't
// fetch). Both dirs are gitignored artifacts.
const outDirs = [join(root, '.cloud-public', 'vad'), join(root, 'src', 'renderer', 'public', 'vad')]
for (const d of outDirs) mkdirSync(d, { recursive: true })

/** Copy every file in dir matching re into EACH target dir; ok if the dir is
 *  missing. Defaults to the VAD outputs; the SEO statics pass their own. */
function copyMatching(dir, re, targets = outDirs) {
  if (!existsSync(dir)) {
    console.warn(`[cloud-assets] missing: ${dir} (npm install?)`)
    return 0
  }
  let n = 0
  for (const f of readdirSync(dir)) {
    if (!re.test(f)) continue
    for (const target of targets) copyFileSync(join(dir, f), join(target, f))
    n++
  }
  return n
}

const vadDist = join(root, 'node_modules', '@ricky0123', 'vad-web', 'dist')
const ortDist = join(root, 'node_modules', 'onnxruntime-web', 'dist')
const fsmnDir = join(root, 'assets', 'fsmn-vad')

const nVad = copyMatching(vadDist, /\.(onnx|worklet\.bundle\.min\.js)$|^vad\.worklet/)
const nOrt = copyMatching(ortDist, /^ort-wasm.*\.(wasm|mjs|jsep\.mjs)$|^ort\..*wasm.*\.(wasm|mjs)$/)
let nFsmn = 0
for (const [source, target] of [
  ['model_quant.onnx', 'fsmn-vad-quant.onnx'],
  ['vad.mvn', 'fsmn-vad.mvn']
]) {
  const path = join(fsmnDir, source)
  if (!existsSync(path)) continue
  for (const outDir of outDirs) copyFileSync(path, join(outDir, target))
  nFsmn++
}

// SEO statics committed under seo/: robots.txt, sitemap.xml, favicon, and the
// prerendered marketing pages (seo/pages/*.html). They're copied into the
// publicDir root so Vercel serves them from / (vercel.json maps the pretty
// URLs like /descript-alternative onto the .html files). Web-only — the
// desktop bundle has no use for them.
const seoDir = join(root, 'seo')
const pubRoot = join(root, '.cloud-public')
const nSeo =
  copyMatching(seoDir, /\.(txt|xml|svg|css|png)$/, [pubRoot]) +
  copyMatching(join(seoDir, 'pages'), /\.html$/, [pubRoot])

console.log(
  `[cloud-assets] staged ${nVad} vad-web + ${nOrt} onnxruntime + ${nFsmn} FSMN + ${nSeo} SEO files -> ${outDirs.join(', ')}`
)
if (!nVad || !nOrt || nFsmn !== 2 || !nSeo) process.exitCode = 1
