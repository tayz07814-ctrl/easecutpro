const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  pickOutput: () => ipcRenderer.invoke('pick-output'),
  probe: (file) => ipcRenderer.invoke('probe', file),
  transcode: (opts) => ipcRenderer.invoke('transcode', opts),
  cancel: (jobId) => ipcRenderer.invoke('cancel', jobId),
  openFolder: (p) => ipcRenderer.invoke('open-folder', p),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, data) => cb(data))
})
