/*
 * Preload bridge.
 *
 * Runs in an isolated context and is the only place the renderer can talk to
 * the main process from. We expose a small, explicit `window.api` surface
 * instead of handing the renderer full ipcRenderer access.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Turn process.platform into something friendly for the UI badge.
function detectOS() {
    if (process.platform === 'win32')  return 'Windows';
    if (process.platform === 'darwin') return process.arch === 'arm64' ? 'macOS (Apple Silicon)' : 'macOS (Intel)';
    if (process.platform === 'linux')  return 'Linux';
    return process.platform;
}

contextBridge.exposeInMainWorld('api', {

    // Detected once at startup, shown read-only in the UI.
    osName: detectOS(),

    // Commands the renderer can trigger.
    startDownloads:  (urls, config) => ipcRenderer.invoke('start-downloads', { urls, config }),
    stopDownloads:   ()             => ipcRenderer.invoke('stop-downloads'),
    pauseDownloads:  ()             => ipcRenderer.invoke('pause-downloads'),
    resumeDownloads: ()             => ipcRenderer.invoke('resume-downloads'),
    skipDownload:    ()             => ipcRenderer.invoke('skip-download'),
    cancelVideo:     (title)        => ipcRenderer.invoke('cancel-video', title),
    chooseFolder:    ()             => ipcRenderer.invoke('choose-folder'),
    retryVideo:      (title)        => ipcRenderer.invoke('retry-video', title),

    // Events the main process pushes back to the UI.
    onLog:              (cb) => ipcRenderer.on('log',               (e, d) => cb(d)),
    onDownloadStart:    (cb) => ipcRenderer.on('download-start',    (e, d) => cb(d)),
    onDownloadDone:     (cb) => ipcRenderer.on('download-done',     (e, d) => cb(d)),
    onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (e, d) => cb(d)),
    onCourseDone:       (cb) => ipcRenderer.on('course-done',       (e, d) => cb(d)),
    onAllDone:          (cb) => ipcRenderer.on('all-done',          (e, d) => cb(d)),
    onDownloadRetry:    (cb) => ipcRenderer.on('download-retry',    (e, d) => cb(d)),
    onCpuUsage:         (cb) => ipcRenderer.on('cpu-usage',         (e, d) => cb(d)),
});
