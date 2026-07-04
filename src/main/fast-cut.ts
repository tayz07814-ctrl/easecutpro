// Fast Cut — Node adapter for the local Python retake-detection engine
// (the `fastcut/` package). This is the "Fast Cut" button's backend; Smart Cut
// (ai-cut.ts, web LLM) stays as the fallback.
//
// Flow: transcript words -> JSON -> engine (warm sidecar if running, else a
// one-shot CLI spawn) -> {cut_start,cut_end} ranges -> word ids to select.
// Returns the SAME AICutResult shape as suggestCutsAI so it plugs straight into
// the existing selection/delete flow.

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import http from 'http'
import type { Transcript, AICut, AICutResult } from '../shared/types'

type ProgressFn = (pct: number, msg?: string) => void

const SIDECAR_HOST = process.env.FASTCUT_HOST || '127.0.0.1'
const SIDECAR_PORT = Number(process.env.FASTCUT_PORT || 8799)

/** Locate the repo root that contains the `fastcut/` package. */
function repoRoot(): string {
  if (process.env.EC_FASTCUT_ROOT && existsSync(join(process.env.EC_FASTCUT_ROOT, 'fastcut', 'cli.py')))
    return process.env.EC_FASTCUT_ROOT
  // Search cwd and a few parents (covers `out/main` in the packaged app).
  let dir = process.cwd()
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'fastcut', 'cli.py'))) return dir
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

/** Pick the Python interpreter. Prefer the ML venv, then the core venv, then PATH.
 * Override with EC_FASTCUT_PYTHON (e.g. a hand-made 3.12 torch venv). */
function pythonPath(root: string): string {
  const env = process.env.EC_FASTCUT_PYTHON
  if (env && existsSync(env)) return env
  const cands = [
    join(root, 'fastcut', '.venv-ml', 'Scripts', 'python.exe'),
    join(root, 'fastcut', '.venv-ml', 'bin', 'python'),
    join(root, 'fastcut', '.venv', 'Scripts', 'python.exe'),
    join(root, 'fastcut', '.venv', 'bin', 'python'),
  ]
  for (const c of cands) if (existsSync(c)) return c
  return process.platform === 'win32' ? 'python' : 'python3'
}

/** Try the warm FastAPI sidecar first (models stay loaded for the GPU tiers). */
function trySidecar(payload: unknown, timeoutMs = 60000): Promise<any | null> {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(payload))
    const req = http.request(
      {
        host: SIDECAR_HOST, port: SIDECAR_PORT, path: '/detect', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': body.length },
        timeout: timeoutMs,
      },
      (res) => {
        let data = ''
        res.on('data', (d) => (data += d))
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve(null) }
        })
      }
    )
    req.on('error', () => resolve(null))   // sidecar not running -> fall back to CLI
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.write(body)
    req.end()
  })
}

/** One-shot CLI spawn (default path; heuristic core starts in ~0.3 s). */
function runCli(py: string, root: string, payload: unknown, timeoutMs = 120000): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(py, ['-m', 'fastcut.cli'], {
      cwd: root,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    let out = '', err = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('Fast Cut engine timed out')) }, timeoutMs)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) =>
      reject(new Error(`Fast Cut: cannot start Python at "${py}". Run fastcut/setup_ml.ps1 or set EC_FASTCUT_PYTHON. (${e.message})`)))
    child.on('close', (code) => {
      clearTimeout(timer)
      try {
        const parsed = JSON.parse((out || '{}').trim())
        if (parsed.error) return reject(new Error(`Fast Cut engine: ${parsed.error}`))
        resolve(parsed)
      } catch {
        reject(new Error(`Fast Cut engine failed (exit ${code}). ${err.slice(0, 300) || 'no output'}`))
      }
    })
    child.stdin.write(JSON.stringify(payload))
    child.stdin.end()
  })
}

function mapKind(k?: string): AICut['kind'] {
  switch (k) {
    case 'false_start': return 'stutter'
    case 'repetition':
    case 'partial_restart':
    case 'retake':
    default: return 'repeat'
  }
}

/** Detect retakes/repetitions with the local engine. Same contract as suggestCutsAI. */
export async function fastCutSuggest(
  transcript: Transcript,
  onProgress?: ProgressFn
): Promise<AICutResult> {
  const words = transcript.words.filter((w) => !w.deleted)
  if (words.length < 3) return { ids: [], cuts: [] }

  onProgress?.(8, 'Fast Cut analyzing transcript…')
  const payload = {
    words: words.map((w) => ({
      word: w.text,
      start: w.start,
      end: w.end,
      conf: typeof w.conf === 'number'
        ? w.conf
        : typeof w.confidence === 'number'
          ? w.confidence
          : 1,
    })),
    verbose: true,
  }

  // Warm sidecar (GPU tiers) -> else spawn the CLI (heuristic core).
  let result = await trySidecar(payload)
  if (!result) {
    const root = repoRoot()
    result = await runCli(pythonPath(root), root, payload)
  }
  onProgress?.(85, 'Mapping cuts to words…')

  const EPS = 1e-3
  const cuts: AICut[] = []
  const allIds = new Set<string>()
  for (const cut of (result.cuts ?? []) as Array<{ cut_start: number; cut_end: number; kind?: string; text?: string }>) {
    // A word belongs to the cut if it STARTS inside [cut_start, cut_end). The
    // surviving take's first word starts exactly at cut_end, so it's excluded.
    const inCut = words.filter((w) => w.start >= cut.cut_start - EPS && w.start < cut.cut_end - EPS)
    const ids = inCut.map((w) => w.id).filter((id) => !allIds.has(id))
    if (ids.length === 0) continue
    ids.forEach((id) => allIds.add(id))
    cuts.push({
      ids,
      kind: mapKind(cut.kind),
      reason: cut.kind || 'retake',
      text: cut.text || inCut.map((w) => w.text).join(' '),
    })
  }

  const tiers = result.meta?.semantic ? 'semantic' : 'heuristic'
  onProgress?.(100, allIds.size
    ? `Fast Cut (${tiers}) flagged ${allIds.size} word(s) — review, then Delete`
    : 'Fast Cut found nothing to cut')
  return { ids: [...allIds], cuts }
}

/** Is the engine reachable at all? (sidecar up, or a python + package present.) */
export function fastCutInfo(): { python: string; root: string } {
  const root = repoRoot()
  return { python: pythonPath(root), root }
}
