// Centralized IPC channel names so main/preload/renderer stay in sync.
export const IPC = {
  openMediaDialog: 'media:openDialog',
  openMediaDialogMulti: 'media:openDialogMulti',
  importFolder: 'media:importFolder',
  combineClips: 'media:combineClips',
  probe: 'media:probe',
  transcribe: 'media:transcribe',
  suggestCuts: 'media:suggestCuts',
  fastCut: 'media:fastCut',
  cutJudge: 'media:cutJudge',
  saveSmartCutDebug: 'media:saveSmartCutDebug',
  cutCutPro: 'media:cutCutPro',
  generateOverlays: 'media:generateOverlays',
  openaiStatus: 'tools:openaiStatus',
  whisperModels: 'tools:whisperModels',
  detectSilence: 'media:detectSilence',
  waveform: 'media:waveform',
  thumbnails: 'media:thumbnails',
  export: 'project:export',
  saveProject: 'project:save',
  loadProject: 'project:load',
  // Project library (CapCut-style local projects)
  listProjects: 'projects:list',
  createProject: 'projects:create',
  getProject: 'projects:get',
  saveProjectRecord: 'projects:saveRecord',
  deleteProjectRecord: 'projects:deleteRecord',
  toolStatus: 'tools:status',
  progress: 'job:progress' // main -> renderer event
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
