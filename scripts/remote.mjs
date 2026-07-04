// One command to put EaseCutPro on the internet.
//
//   npm run remote        -> Cloudflare quick tunnel (random URL, most reliable)
//   npm run remote:named  -> localtunnel, branded URL  https://easecutpro.loca.lt
//
// Env:
//   EC_TUNNEL=cloudflare|lt   pick the provider (default cloudflare)
//   EC_SUBDOMAIN=easecutpro   localtunnel subdomain (default easecutpro)
//   EC_TOKEN=...              access token (else generated + saved to .ectoken)
//   EC_PORT=8787              port
//
// Stop everything with Ctrl+C.
import { spawn, spawnSync } from 'child_process'
import { randomBytes } from 'crypto'
import https from 'https'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = process.env.EC_PORT || '8787'
const PROVIDER = (process.env.EC_TUNNEL || process.argv[2] || 'cloudflare').toLowerCase()
const SUBDOMAIN = (process.env.EC_SUBDOMAIN || 'easecutpro').toLowerCase().replace(/[^a-z0-9-]/g, '')

// ---- token: env > saved file > generated (and saved) ----
const tokenFile = path.join(ROOT, '.ectoken')
let token = (process.env.EC_TOKEN || '').trim()
if (!token && fs.existsSync(tokenFile)) token = fs.readFileSync(tokenFile, 'utf8').trim()
if (!token) {
  token = randomBytes(9).toString('base64url')
  fs.writeFileSync(tokenFile, token)
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

// ---- start the server ----
const server = spawn('npx tsx src/server/index.ts', {
  cwd: ROOT,
  env: { ...process.env, EC_SIGNUP_CODE: token, EC_PORT: PORT },
  shell: true
})
server.stdout.on('data', (d) => process.stdout.write('[server] ' + d))
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d))

// ---- start the tunnel ----
let cf = null
let lt = null
if (PROVIDER === 'lt' || PROVIDER === 'localtunnel') startLocaltunnel()
else startCloudflared()

function startCloudflared() {
  const localCf = path.join(ROOT, 'tools', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
  const bin = fs.existsSync(localCf) ? localCf : 'cloudflared'
  cf = spawn(bin, ['tunnel', '--url', `http://localhost:${PORT}`], { cwd: ROOT })
  let printed = false
  const scan = (buf) => {
    const m = buf.toString().match(/https:\/\/[-a-z0-9]+\.trycloudflare\.com/i)
    if (m && !printed) {
      printed = true
      banner(m[0])
    }
  }
  cf.stdout.on('data', scan)
  cf.stderr.on('data', scan)
  cf.on('error', (e) => console.error('\ncloudflared error:', e.message, '\n'))
  cf.on('exit', shutdown)
}

async function startLocaltunnel() {
  const { default: localtunnel } = await import('localtunnel')
  let tunnel
  try {
    tunnel = await localtunnel({ port: Number(PORT), subdomain: SUBDOMAIN })
  } catch (e) {
    console.error('\nlocaltunnel failed to start:', e.message)
    console.error('The subdomain may be taken — try EC_SUBDOMAIN=easecutpro-yourname, or use "npm run remote".\n')
    shutdown()
    return
  }
  lt = tunnel
  const ip = await publicIp().catch(() => null)
  banner(tunnel.url, ip)
  tunnel.on('close', shutdown)
}

function publicIp() {
  return new Promise((resolve, reject) => {
    const req = https.get('https://api.ipify.org', (res) => {
      let s = ''
      res.on('data', (d) => (s += d))
      res.on('end', () => resolve(s.trim()))
    })
    req.on('error', reject)
    req.setTimeout(4000, () => req.destroy(new Error('timeout')))
  })
}

function banner(url, ip) {
  const line = '═'.repeat(54)
  console.log(`\n╔${line}╗`)
  console.log('   EaseCutPro is LIVE on the internet')
  console.log('')
  console.log(`   URL:          ${url}`)
  console.log(`   Signup code:  ${token}`)
  if (ip) {
    console.log('')
    console.log(`   If loca.lt shows a reminder page, the password is`)
    console.log(`   your public IP:  ${ip}`)
  }
  console.log('')
  console.log('   Open the URL, sign up with the code (first time),')
  console.log('   then log in with your email + password.')
  console.log('   Stop with Ctrl+C.')
  console.log(`╚${line}╝\n`)
}

// ---- cleanup ----
let stopping = false
function shutdown() {
  if (stopping) return
  stopping = true
  try {
    server.kill()
  } catch {}
  try {
    if (cf) cf.kill()
  } catch {}
  try {
    if (lt) lt.close()
  } catch {}
  setTimeout(() => process.exit(0), 300)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
server.on('exit', shutdown)
