/*
 * Electron main process.
 *
 * Owns the window, wires IPC between the UI and the Downloader, fixes binary
 * permissions on first run, reports CPU load, and cleans up stale temp folders.
 */

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const Downloader = require('./downloader');

let mainWindow;
let currentDownloader = null;
let cpuTimer = null;

// Total vs idle CPU ticks across all cores at this instant.
function cpuSnapshot() {
    let idle = 0, total = 0;
    for (const cpu of os.cpus()) {
        for (const t of Object.values(cpu.times)) total += t;
        idle += cpu.times.idle;
    }
    return { idle, total };
}

// On a clean run every download removes its own temp folder. If a previous run
// was force-killed mid-download, its folder is orphaned in the OS temp dir.
// Sweep those on startup. Runs fully async so it never blocks the UI, and the
// 1h age guard makes sure we never touch a download that's still in progress
// (including one owned by a second running instance).
async function sweepOrphanTempDirs() {
    try {
        const tmp     = os.tmpdir();
        const entries = await fs.promises.readdir(tmp, { withFileTypes: true });
        const maxAge  = 60 * 60 * 1000; // 1 hour
        const now     = Date.now();

        await Promise.all(entries.map(async (ent) => {
            if (!ent.isDirectory() || !ent.name.startsWith('dstk_')) return;
            const dir = path.join(tmp, ent.name);
            try {
                const st = await fs.promises.stat(dir);
                if (now - st.mtimeMs < maxAge) return; // probably still in use
                await fs.promises.rm(dir, { recursive: true, force: true });
            } catch (e) { /* locked or already gone — get it next launch */ }
        }));
    } catch (e) { /* temp dir unreadable — nothing we can do, not fatal */ }
}

// Push CPU usage to the UI once a second so the status dot can blink faster
// the busier the machine is.
function startCpuMonitor() {
    let last = cpuSnapshot();
    cpuTimer = setInterval(() => {
        const cur       = cpuSnapshot();
        const idleDiff  = cur.idle  - last.idle;
        const totalDiff = cur.total - last.total;
        last = cur;
        let pct = totalDiff > 0 ? (1 - idleDiff / totalDiff) * 100 : 0;
        pct = Math.max(0, Math.min(100, Math.round(pct)));
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('cpu-usage', pct);
        }
    }, 1000);
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 850,
        height: 720,
        resizable: false,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
        },
        title: 'Downstika',
        icon: path.join(__dirname, 'build', 'icon.png'),
    });
    mainWindow.loadFile('renderer/index.html');
}

app.whenReady().then(() => {
    // The bundled binaries need the execute bit on macOS/Linux. Cover both the
    // packaged location (resourcesPath) and the dev location (__dirname) — a
    // packaged app only has the former, and without +x it can't spawn them.
    if (process.platform !== 'win32') {
        const folder = process.platform === 'darwin'
            ? (process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64')
            : 'linux';
        const binaries = ['N_m3u8DL-RE', 'ffmpeg', 'ffprobe'];
        const bases    = [process.resourcesPath, __dirname].filter(Boolean);
        for (const base of bases) {
            for (const bin of binaries) {
                const binPath = path.join(base, folder, bin);
                try {
                    if (fs.existsSync(binPath)) fs.chmodSync(binPath, 0o755);
                } catch (e) { /* not fatal */ }
            }
        }
    }

    createWindow();
    startCpuMonitor();

    // Run the orphan sweep only after the UI has painted, and don't await it,
    // so it adds nothing to startup time.
    mainWindow.webContents.once('did-finish-load', () => { sweepOrphanTempDirs(); });
});

app.on('window-all-closed', () => {
    if (cpuTimer) clearInterval(cpuTimer);
    app.quit();
});

// Start downloading the queued courses.
ipcMain.handle('start-downloads', async (event, { urls, config }) => {
    // No save folder chosen → default to the OS Downloads folder. It's always
    // user-writable, unlike a relative path when launched from a shortcut.
    if (!config.savePath) {
        config.savePath = path.join(app.getPath('downloads'), 'domestika_courses');
    }

    currentDownloader = new Downloader(config);

    currentDownloader.on('log',               msg  => mainWindow.webContents.send('log', msg));
    currentDownloader.on('download-start',    data => mainWindow.webContents.send('download-start', data));
    currentDownloader.on('download-done',     data => mainWindow.webContents.send('download-done', data));
    currentDownloader.on('download-progress', data => mainWindow.webContents.send('download-progress', data));
    currentDownloader.on('course-done',       data => mainWindow.webContents.send('course-done', data));
    currentDownloader.on('download-retry',    data => mainWindow.webContents.send('download-retry', data));

    for (const url of urls) {
        if (currentDownloader.stopped) break;
        await currentDownloader.downloadCourse(url);
    }

    const wasStopped  = currentDownloader.stopped;
    const hasFailures = currentDownloader.failedVideoData.length > 0;
    mainWindow.webContents.send('all-done', { stopped: wasStopped, hasFailures });

    // Keep the instance around if there are failures, so the user can retry
    // individual videos without re-scraping the whole course.
    if (!hasFailures) currentDownloader = null;
});

// Retry one failed video (the per-item retry button).
ipcMain.handle('retry-video', async (e, title) => {
    if (!currentDownloader) return;
    await currentDownloader.retryVideo(title);
    if (currentDownloader.failedVideoData.length === 0) currentDownloader = null;
});

// Playback controls.
ipcMain.handle('stop-downloads',   () => currentDownloader?.stop());
ipcMain.handle('pause-downloads',  () => currentDownloader?.pause());
ipcMain.handle('resume-downloads', () => currentDownloader?.resume());
ipcMain.handle('skip-download',    () => currentDownloader?.skipCurrent());
ipcMain.handle('cancel-video',     (e, title) => currentDownloader?.cancelVideo(title));

// Folder picker for the Save Location field.
ipcMain.handle('choose-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose save location for downloaded videos',
        properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
});
