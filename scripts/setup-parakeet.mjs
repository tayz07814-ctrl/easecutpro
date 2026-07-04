// Download the Parakeet-TDT-0.6b-v3 (int8) model for the offline Parakeet engine.
// ~630 MB. Run once:  node scripts/setup-parakeet.mjs
import { mkdir, rm } from 'fs/promises'
import { createWriteStream, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODELS = join(ROOT, 'resources', 'models')
const DEST = join(MODELS, 'parakeet')
const TAR = join(MODELS, 'parakeet.tar.bz2')
const URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2'

const need = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']
if (need.every((f) => existsSync(join(DEST, f)))) {
  console.log('✓ Parakeet model already installed at', DEST)
  process.exit(0)
}

await mkdir(DEST, { recursive: true })
console.log('Downloading Parakeet-TDT-0.6b-v3 (int8), ~630 MB …')
const res = await fetch(URL)
if (!res.ok || !res.body) {
  console.error('Download failed:', res.status, res.statusText)
  process.exit(1)
}
const total = Number(res.headers.get('content-length') || 0)
let got = 0
const reader = res.body.getReader()
const out = createWriteStream(TAR)
const stream = new Readable({
  async read() {
    const { done, value } = await reader.read()
    if (done) return this.push(null)
    got += value.length
    if (total) process.stdout.write(`\r  ${(got / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`)
    this.push(Buffer.from(value))
  }
})
await pipeline(stream, out)

console.log('\nExtracting (system tar; needs bzip2 support — built into Windows 10+ tar) …')
const r = spawnSync('tar', ['xf', TAR, '-C', DEST, '--strip-components=1'], { stdio: 'inherit', shell: true })
if (r.status !== 0) {
  console.error('\nExtract failed. Make sure `tar` is available (Windows 10+ has it).')
  console.error('You can also extract', TAR, 'manually into', DEST, '(flatten the top folder).')
  process.exit(1)
}
await rm(TAR, { force: true })

const ok = need.every((f) => existsSync(join(DEST, f)))
console.log(ok ? `\n✓ Done. Parakeet model at ${DEST}` : '\n✗ Some model files are missing — check the extraction.')
console.log('Restart the app/server — "Parakeet" appears in the transcription model dropdown (Local engine).')
process.exit(ok ? 0 : 1)
