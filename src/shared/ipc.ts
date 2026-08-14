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
  cutCutPro: 'media:cutCutPro',
  retakeAwareCut: 'media:retakeAwareCut', // Retake-Aware Cut Beta (cut_mode: retake_aware_beta)
  generateOverlays: 'media:generateOverlays',
  suggestOverlays: 'media:suggestOverlays',
  describeOverlayImage: 'media:describeOverlayImage',
  matchMoment: 'media:matchMoment',
  openaiStatus: 'tools:openaiStatus',
  whisperModels: 'tools:whisperModels',
  waveform: 'media:waveform',
  thumbnails: 'media:thumbnails',
  previewAudioWav: 'media:previewAudioWav', // desktop-only: native PCM for the preview audio engine
  sttAudioWav: 'media:sttAudioWav', // desktop-only: 16k mono WAV for the cloud STT engines
  buildPreviewProxy: 'media:buildPreviewProxy', // flatten the current edit for seamless preview
  existingPreviewProxy: 'media:existingPreviewProxy', // is a proxy for this edit already on disk?
  buildPreviewProxyManual: 'media:buildPreviewProxyManual', // user-requested 720p proxy
  conditionPreviewMedia: 'media:conditionPreviewMedia', // import-time edit-friendly copy (dense keyframes)
  export: 'project:export',
  revealPath: 'shell:revealPath', // show a finished export in the file manager
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
