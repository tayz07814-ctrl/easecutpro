const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const { spawn, execFile } = require('child_process')
const path = require('path')

// ffmpeg / ffprobe are resolved from PATH (they're installed on this machine).
const FFMPEG = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
const FFPROBE = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'

let win = null
const running = new Map() // jobId -> child process

function createWindow() {
  win = new BrowserWindow({
    width: 920,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: '#1e1e22',
    title: 'Batch Transcoder',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.removeMenu()
  win.loadFile(path.join(__dirname, 'index.html'))
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())

// --- Pick input files ---
ipcMain.handle('pick-files', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Select videos',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'flv', 'wmv', 'mpg', 'mpeg', 'ts'] },
      { name: 'All files', extensions: ['*'] }
    ]
  })
  return r.canceled ? [] : r.filePaths
})

// --- Pick output folder ---
ipcMain.handle('pick-output', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Select output folder',
    properties: ['openDirectory', 'createDirectory']
  })
  return r.canceled ? null : r.filePaths[0]
})

// --- Probe a file for duration + resolution ---
ipcMain.handle('probe', async (_e, file) => {
  return new Promise((resolve) => {
    execFile(
      FFPROBE,
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'format=duration:stream=width,height',
        '-of', 'json',
        file
      ],
      { timeout: 20000 },
      (err, stdout) => {
        if (err) return resolve({ ok: false })
        try {
          const j = JSON.parse(stdout)
          const dur = parseFloat(j.format && j.format.duration) || 0
          const s = (j.streams && j.streams[0]) || {}
          resolve({ ok: true, duration: dur, width: s.width || 0, height: s.height || 0 })
        } catch {
          resolve({ ok: false })
        }
      }
    )
  })
})

ipcMain.handle('open-folder', async (_e, p) => {
  shell.showItemInFolder(p)
})

ipcMain.handle('cancel', async (_e, jobId) => {
  const proc = running.get(jobId)
  if (proc) {
    try { proc.kill('SIGKILL') } catch {}
    running.delete(jobId)
  }
})

// --- Transcode one file ---
// opts: { jobId, input, output, height (0=keep), bitrate (kbps), preset, codec, duration }
ipcMain.handle('transcode', async (_e, opts) => {
  const { jobId, input, output, height, bitrate, preset, codec, duration } = opts

  const vcodec = codec === 'h265' ? 'libx265' : 'libx264'
  const args = ['-y', '-i', input]

  // Scale: keep aspect ratio, force even dimensions. height=0 means keep original.
  if (height && height > 0) {
    args.push('-vf', `scale=-2:${height}:flags=lanczos`)
  }

  const kbps = Math.max(1000, Math.round(bitrate))
  args.push(
    '-c:v', vcodec,
    '-preset', preset || 'medium',
    '-b:v', `${kbps}k`,
    '-maxrate', `${Math.round(kbps * 1.45)}k`,
    '-bufsize', `${Math.round(kbps * 2)}k`,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    '-nostats',
    output
  )

  return new Promise((resolve) => {
    const proc = spawn(FFMPEG, args, { windowsHide: true })
    running.set(jobId, proc)
    let stderrTail = ''

    // ffmpeg -progress writes key=value lines to stdout; out_time_ms gives position.
    proc.stdout.on('data', (buf) => {
      const text = buf.toString()
      const m = text.match(/out_time_ms=(\d+)/g)
      if (m && duration > 0) {
        const last = m[m.length - 1]
        const us = parseInt(last.split('=')[1], 10)
        const sec = us / 1_000_000
        const pct = Math.min(99, Math.round((sec / duration) * 100))
        win.webContents.send('progress', { jobId, percent: pct })
      }
    })

    proc.stderr.on('data', (buf) => {
      stderrTail = (stderrTail + buf.toString()).slice(-2000)
    })

    proc.on('error', (e) => {
      running.delete(jobId)
      resolve({ ok: false, error: e.message })
    })

    proc.on('close', (code) => {
      running.delete(jobId)
      if (code === 0) resolve({ ok: true })
      else resolve({ ok: false, error: stderrTail || `ffmpeg exited with code ${code}` })
    })
  })
})
