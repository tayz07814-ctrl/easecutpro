// Unified project library — works on desktop (Electron IPC -> local files) and
// web (HTTP -> per-user server store), both through window.api.
import { IS_WEB } from './platform'
import { uploadAndServerize } from './webapi'
import type { Project, ProjectMeta, ProjectRec } from '@shared/types'

export type { ProjectMeta, ProjectRec }

export const listProjects = (): Promise<ProjectMeta[]> => window.api.listProjects()
export const getProject = (id: string): Promise<ProjectRec | null> => window.api.getProject(id)
export const createProject = (name: string, project: Project | null): Promise<{ id: string; name: string }> =>
  window.api.createProject(name, project)
export const saveProject = (
  id: string,
  patch: { name?: string; project?: Project; thumb?: string }
): Promise<void> => window.api.saveProjectRecord(id, patch)
export const deleteProject = (id: string): Promise<void> => window.api.deleteProjectRecord(id)

/** Prepare a project for saving: web uploads any browser-local media; desktop keeps local paths. */
export async function serializeProject(project: Project): Promise<Project> {
  return IS_WEB ? uploadAndServerize(project) : project
}
