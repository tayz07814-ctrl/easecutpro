// Compat shim. The project library is now DEVICE-LOCAL (IndexedDB) — local
// projects never live in the cloud; moving a project between devices means
// uploading it to a Cloud Cowork space first. The real implementation (plus a
// one-time migration that claims any old Supabase `projects` rows onto the
// device) lives in ../local/library. This file only re-exports under the old
// names so cloud/api.ts's wiring stays put.
export {
  localListProjects as cloudListProjects,
  localCreateProject as cloudCreateProject,
  localGetProject as cloudGetProject,
  localSaveProject as cloudSaveProject,
  localDeleteProject as cloudDeleteProject
} from '../local/library'
