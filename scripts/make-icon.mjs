// Generate the Windows app icon from the committed brand mark.
//
//   node scripts/make-icon.mjs
//
// The .ico is a build artifact (icons/*.ico is gitignored), but its SOURCE is
// seo/favicon.svg — the same mark the website uses — so the desktop app, the
// installer, the shortcuts and the favicon can never drift apart. Wired into the
// prebuild/predist hooks, so a clean checkout always produces a branded build
// instead of silently falling back to the stock Electron icon.
//
// Rasterises through Electron (already a dependency) because nothing else in the
// toolchain turns an SVG into pixels. The ICO container is then written by hand,
// which is easy: the format may embed PNGs verbatim.

import { spawn } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const svgPath = join(root, 'seo', 'favicon.svg')
const outDir = join(root, 'icons')
const outIco = join(outDir, 'icon.ico')

// Windows picks per context; 256 is what Explorer and the installer show.
const SIZES = [16, 24, 32, 48, 64, 128, 256]

if (!existsSync(svgPath)) {
  console.warn(`[icon] no ${svgPath} — leaving the existing icon alone`)
  process.exit(0)
}

const electronExe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

/** Render the SVG at each size in a hidden Electron window; return PNG buffers. */
function renderPngs() {
  const svg = readFileSync(svgPath, 'utf8')
  const helper = join(root, 'scripts', '.icon-render.cjs')
  const script = `const { app, BrowserWindow } = require('electron')
const SVG = ${JSON.stringify(svg)}
const SIZES = ${JSON.stringify(SIZES)}
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 320, height: 320 })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0"></body>'))
  const out = []
  for (const s of SIZES) {
    const png = await win.webContents.executeJavaScript(
      '(async () => {' +
      '  const img = new Image();' +
      '  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(' + JSON.stringify(SVG) + ');' +
      '  await img.decode();' +
      '  const c = document.createElement("canvas");' +
      '  c.width = c.height = ' + s + ';' +
      '  const x = c.getContext("2d");' +
      '  x.clearRect(0, 0, ' + s + ', ' + s + ');' +
      '  x.drawImage(img, 0, 0, ' + s + ', ' + s + ');' +
      '  return c.toDataURL("image/png").split(",")[1];' +
      '})()'
    )
    out.push(png)
  }
  process.stdout.write('@@ICON@@' + JSON.stringify(out))
  app.exit(0)
})`
  writeFileSync(helper, script, 'utf8')

  return new Promise((resolve, reject) => {
    const p = spawn(electronExe, [helper], { cwd: root, windowsHide: true })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('error', reject)
    p.on('close', (code) => {
      try {
        unlinkSync(helper)
      } catch {
        /* best effort */
      }
      const marker = out.indexOf('@@ICON@@')
      if (marker < 0) return reject(new Error(`render failed (exit ${code}): ${err.slice(-300)}`))
      try {
        resolve(JSON.parse(out.slice(marker + 8)).map((b) => Buffer.from(b, 'base64')))
      } catch (e) {
        reject(new Error(`bad render output: ${String(e)}`))
      }
    })
  })
}

/** Pack PNGs into an .ico (the format allows PNG payloads directly). */
function buildIco(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(pngs.length, 4)
  const entries = []
  let offset = 6 + pngs.length * 16
  pngs.forEach((png, i) => {
    const s = SIZES[i]
    const e = Buffer.alloc(16)
    e.writeUInt8(s >= 256 ? 0 : s, 0) // 0 encodes 256
    e.writeUInt8(s >= 256 ? 0 : s, 1)
    e.writeUInt8(0, 2) // palette entries
    e.writeUInt8(0, 3) // reserved
    e.writeUInt16LE(1, 4) // colour planes
    e.writeUInt16LE(32, 6) // bits per pixel
    e.writeUInt32LE(png.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += png.length
    entries.push(e)
  })
  return Buffer.concat([header, ...entries, ...pngs])
}

try {
  if (!existsSync(electronExe)) throw new Error('electron binary not unpacked (npm approve-scripts electron && npm rebuild)')
  const pngs = await renderPngs()
  if (pngs.length !== SIZES.length) throw new Error(`expected ${SIZES.length} sizes, got ${pngs.length}`)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(outIco, buildIco(pngs))
  console.log(`[icon] wrote ${outIco} (${SIZES.join(', ')}px, ${(buildIco(pngs).length / 1024).toFixed(1)} KB)`)
} catch (e) {
  // Never block a build over the icon — a stock-icon build still ships.
  console.warn(`[icon] could not generate: ${e.message}`)
}
