// Cloud build project library — Postgres rows (RLS: owner-only) instead of the
// PC server's per-user JSON files. The project JSONB embeds the transcript and
// timeline; media ids stay webmedia: (device-local) — nothing heavy ever lands
// here.
import type { Project, ProjectMeta, ProjectRec } from '@shared/types'
import { getSupabase } from './supabase'

// Same cap the PC server enforced on the thumb data-URL (index.ts:626).
const THUMB_MAX = 400_000

interface Row {
  id: string
  name: string
  thumb: string | null
  project?: Project | null
  created_at: string
  updated_at: string
}

function toMeta(r: Row): ProjectMeta {
  return {
    id: r.id,
    name: r.name,
    thumb: r.thumb ?? '',
    createdAt: new Date(r.created_at).getTime(),
    updatedAt: new Date(r.updated_at).getTime()
  }
}

export async function cloudListProjects(): Promise<ProjectMeta[]> {
  const { data, error } = await getSupabase()
    .from('projects')
    .select('id,name,thumb,created_at,updated_at')
    .order('updated_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data as Row[]).map(toMeta)
}

export async function cloudCreateProject(
  name: string,
  project: Project | null
): Promise<{ id: string; name: string }> {
  const { data, error } = await getSupabase()
    .from('projects')
    .insert({ name: name || 'Untitled', project })
    .select('id,name')
    .single()
  if (error) throw new Error(error.message)
  return { id: data.id, name: data.name }
}

export async function cloudGetProject(id: string): Promise<ProjectRec | null> {
  const { data, error } = await getSupabase()
    .from('projects')
    .select('id,name,thumb,project,created_at,updated_at')
    .eq('id', id)
    .maybeSingle()
  if (error || !data) return null
  const r = data as Row
  return { ...toMeta(r), project: r.project ?? null }
}

export async function cloudSaveProject(
  id: string,
  patch: { name?: string; project?: Project; thumb?: string }
): Promise<void> {
  const row: Record<string, unknown> = {}
  if (patch.name !== undefined) row.name = patch.name
  if (patch.project !== undefined) row.project = patch.project
  if (patch.thumb !== undefined && patch.thumb.length <= THUMB_MAX) row.thumb = patch.thumb
  if (!Object.keys(row).length) return
  const { error } = await getSupabase().from('projects').update(row).eq('id', id)
  if (error) throw new Error(error.message)
}

export async function cloudDeleteProject(id: string): Promise<void> {
  const { error } = await getSupabase().from('projects').delete().eq('id', id)
  if (error) throw new Error(error.message)
}
