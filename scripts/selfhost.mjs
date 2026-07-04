// Production self-host launcher (your own domain, 24/7-capable).
//
//   npm run selfhost
//
// Builds the web client, starts the server with PRODUCTION settings, and runs
// your NAMED Cloudflare tunnel (mapped to your domain). The one-time setup
// (buy domain -> Cloudflare -> create tunnel -> DNS) lives in SELFHOST.md.
//
// This runs everything in the foreground (Ctrl+C to stop) — great for testing.
// For real always-on hosting, install the Windows services described in
// SELFHOST.md instead.
//
// Env:
//   EC_PORT=8787                 port the server listens on
//   EC_TUNNEL_NAME=easecutpro    name of the cloudflared named tunnel to run
//                                (else read from .cftunnel, else "easecutpro")
//   EC_SIGNUP_CODE=...           gate signups (else reuse/generate .ectoken)
import { spawn, spawnSync } from 'child_process'
import { randomBytes } from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = process.env.EC_PORT || '8787'

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8').trim()
  } catch {
    return ''
  }
}

const TUNNEL = (process.env.EC_TUNNEL_NAME || readFileSafe(path.join(ROOT, '.cftunnel')) || 'easecutpro').trim()

// ---- signup code: env > saved .ectoken > generated (and saved) ----
const tokenFile = path.join(ROOT, '.ectoken')
let code = (process.env.EC_SIGNUP_CODE || '').trim()
if (!code) code = readFileSafe(tokenFile)
if (!code) {
  code = randomBytes(9).toString('base64url')
  fs.writeFileSync(tokenFile, code)
}

// ---- ensure the client is built ----
if (!fs.existsSync(path.join(ROOT, 'out', 'renderer', 'index.html'))) {
  console.log('Building the web client (first run)…')
  const b = spawnSync('npx electron-vite build', { cwd: ROOT, stdio: 'inherit', shell: true })
  if (b.status !== 0) {
    console.error('Build failed. Run "npm run build" and check the output.')
    process.exit(1)
  }
}

// ---- start the server (production env: HTTPS cookies + gated signup) ----
const server = spawn('npx tsx src/server/index.ts', {
  cwd: ROOT,
  env: { ...process.env, EC_PORT: PORT, EC_SIGNUP_CODE: code, EC_SECURE_COOKIES: '1' },
  shell: true
})
server.stdout.on('data', (d) => process.stdout.write('[server] ' + d))
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d))

// ---- run the named Cloudflare tunnel ----
const cfBin = path.join(ROOT, 'tools', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
const bin = fs.existsSync(cfBin) ? cfBin : 'cloudflared'
const cf = spawn(bin, ['tunnel', 'run', TUNNEL], { cwd: ROOT })
cf.stdout.on('data', (d) => process.stdout.write('[tunnel] ' + d))
cf.stderr.on('data', (d) => process.stderr.write('[tunnel] ' + d))
cf.on('error', (e) => console.error('\ncloudflared error:', e.message, '\n'))

const line = '═'.repeat(54)
console.log(`\n╔${line}╗`)
console.log('   EaseCutPro self-host starting…')
console.log('')
console.log(`   server:       http://localhost:${PORT}`)
console.log(`   tunnel:       ${TUNNEL}  (→ your domain via Cloudflare)`)
console.log(`   signup code:  ${code}`)
console.log('')
console.log('   If the tunnel errors with "tunnel not found" or credentials,')
console.log('   finish the one-time setup in SELFHOST.md first.')
console.log('   Stop with Ctrl+C.')
console.log(`╚${line}╝\n`)

// ---- cleanup ----
let stopping = false
function shutdown() {
  if (stopping) return
  stopping = true
  try {
    server.kill()
  } catch {}
  try {
    cf.kill()
  } catch {}
  setTimeout(() => process.exit(0), 300)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
server.on('exit', shutdown)
cf.on('exit', shutdown)
