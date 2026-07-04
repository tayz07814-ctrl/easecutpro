import { writeFile, readFile, readdir, mkdir, unlink } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import type { Project, ProjectMeta, ProjectRec } from '../shared/types'

// ---- Single-file save/load (the old Save/Open dialogs) ----
export async function saveProject(path: string, project: Project): Promise<void> {
  await writeFile(path, JSON.stringify(project, null, 2), 'utf8')
}
export async function loadProject(path: string): Promise<Project> {
  const raw = await readFile(path, 'utf8')
  return JSON.parse(raw) as Project
}

// ---- Project library (CapCut-style) ----
// Shared between the desktop editor and the MCP server (Claude) so Claude's
// edits appear when you open the project in the editor.
export function defaultProjectsRoot(): string {
  return join(homedir(), '.easecutpro')
}
let PROJECTS_DIR = join(defaultProjectsRoot(), 'projects')
export function setProjectsDir(rootDir: string): void {
  PROJECTS_DIR = join(rootDir, 'projects')
}
function safeId(id: string): string {
  return String(id).replace(/[^a-zA-Z0-9-]/g, '')
}
function recPath(id: string): string {
  return join(PROJECTS_DIR, `${safeId(id)}.json`)
}
async function ensureDir(): Promise<void> {
  await mkdir(PROJECTS_DIR, { recursive: true })
}

export async function listProjectRecords(): Promise<ProjectMeta[]> {
  await ensureDir()
  const out: ProjectMeta[] = []
  for (const f of (await readdir(PROJECTS_DIR)).filter((f) => f.endsWith('.json'))) {
    try {
      const r: ProjectRec = JSON.parse(await readFile(join(PROJECTS_DIR, f), 'utf8'))
      out.push({ id: r.id, name: r.name, thumb: r.thumb || '', createdAt: r.createdAt, updatedAt: r.updatedAt })
    } catch {
      /* skip corrupt */
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  return out
}

export async function createProjectRecord(
  name: string,
  project: Project | null
): Promise<{ id: string; name: string }> {
  await ensureDir()
  const id = randomUUID()
  const now = Date.now()
  const rec: ProjectRec = {
    id,
    name: String(name || 'Untitled project').slice(0, 80),
    project: project ?? null,
    thumb: '',
    createdAt: now,
    updatedAt: now
  }
  await writeFile(recPath(id), JSON.stringify(rec))
  return { id, name: rec.name }
}

export async function getProjectRecord(id: string): Promise<ProjectRec | null> {
  try {
    return JSON.parse(await readFile(recPath(id), 'utf8')) as ProjectRec
  } catch {
    return null
  }
}

export async function saveProjectRecord(
  id: string,
  patch: { name?: string; project?: Project; thumb?: string }
): Promise<void> {
  let rec: ProjectRec
  try {
    rec = JSON.parse(await readFile(recPath(id), 'utf8')) as ProjectRec
  } catch {
    return
  }
  if (patch.name != null) rec.name = String(patch.name).slice(0, 80)
  if (patch.project != null) rec.project = patch.project
  if (patch.thumb != null) rec.thumb = String(patch.thumb)
  rec.updatedAt = Date.now()
  await writeFile(recPath(id), JSON.stringify(rec))
}

export async function deleteProjectRecord(id: string): Promise<void> {
  try {
    await unlink(recPath(id))
  } catch {
    /* already gone */
  }
}
