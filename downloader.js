/*
 * Core downloader.
 *
 * Scrapes a Domestika course with Puppeteer (using the user's session cookie),
 * collects the video playback URLs, then downloads each one with N_m3u8DL-RE,
 * optionally transcoding to H.265 with ffmpeg. Progress and state are emitted
 * as events for the UI to render.
 *
 * A note on the temp-dir dance: on Windows the full save path
 * (Downloads/<course>/<section>/<unit>/<long title>.mp4) easily blows past the
 * 260-char limit, which crashes N_m3u8DL-RE and ffmpeg. So every download runs
 * in a short temp folder and the finished files are copied to the real
 * destination afterwards using long-path-safe fs calls.
 */

const puppeteer     = require('puppeteer');
const cheerio       = require('cheerio');
const { spawn }     = require('child_process');
const util          = require('util');
// execFile (no shell) keeps paths with spaces/quotes/$ working the same on
// Windows and *nix — avoids a whole class of shell-quoting bugs.
const execFileAsync = util.promisify(require('child_process').execFile);
const fs            = require('fs');
const path          = require('path');
const os            = require('os');
const crypto        = require('crypto');
const EventEmitter  = require('events');

// Bumped per temp dir so parallel downloads can never collide on a name.
let tmpSeq = 0;

// Prefix a path with Windows' \\?\ so fs can handle >260 chars. No-op elsewhere.
function longPath(p) {
    if (process.platform !== 'win32') return p;
    const resolved = path.resolve(p);
    if (resolved.startsWith('\\\\?\\')) return resolved;
    if (resolved.startsWith('\\\\'))    return '\\\\?\\UNC\\' + resolved.slice(2);
    return '\\\\?\\' + resolved;
}

// Async "does this path exist?" — used instead of fs.existsSync so a slow
// disk / antivirus can't block the Electron main process (and freeze the UI).
async function pathExists(p) {
    try { await fs.promises.access(p); return true; }
    catch { return false; }
}

// Resolve a bundled binary for the current platform/arch. Packaged builds put
// it under resourcesPath; in dev it sits next to this file.
function getBinPath(name) {
    const { platform, arch } = process;
    let folder;
    if (platform === 'win32')                           folder = 'win';
    else if (platform === 'darwin' && arch === 'arm64') folder = 'mac-arm64';
    else if (platform === 'darwin')                     folder = 'mac-x64';
    else                                                folder = 'linux';

    const fileName = platform === 'win32' ? name + '.exe' : name;

    const packedPath = path.join(process.resourcesPath || '', folder, fileName);
    if (fs.existsSync(packedPath)) return packedPath;

    return path.join(__dirname, folder, fileName);
}

class Downloader extends EventEmitter {

    constructor(config) {
        super();
        this.config          = config;
        this.stopped         = false;
        this.paused          = false;
        this.activeProcs     = [];          // running child processes
        this.procMap         = {};          // title -> proc, for per-video cancel
        this.cancelledTitles = new Set();   // titles the user cancelled
        this.failedVideoData = [];          // videos that failed all retries

        // The access token is buried in the _credentials_ cookie value.
        const match = /accessToken":"(.*?)"/.exec(decodeURI(config.credentials || ''));
        this.access_token = match ? match[1] : null;
    }

    log(msg) { this.emit('log', msg); }

    // --- Playback controls ---

    stop() {
        this.stopped = true;
        this.paused  = false;
        for (const proc of this.activeProcs) {
            try { proc.kill(); } catch (e) {}
        }
        this.activeProcs = [];
        this.log('Downloads stopped.');
    }

    async pause() {
        if (this.paused) return;
        this.paused = true;
        for (const proc of this.activeProcs) {
            await this.suspendProcess(proc.pid);
        }
        this.log('Downloads paused.');
    }

    async resume() {
        if (!this.paused) return;
        this.paused = false;
        for (const proc of this.activeProcs) {
            await this.resumeProcess(proc.pid);
        }
        this.log('Downloads resumed.');
    }

    skipCurrent() {
        // Killing the procs makes spawnProcess resolve as 'skipped'; the queue
        // just moves on to the next video.
        for (const proc of [...this.activeProcs]) {
            try { proc.kill(); } catch (e) {}
        }
        this.log('Skipping current download(s)...');
    }

    cancelVideo(title) {
        this.cancelledTitles.add(title);
        const proc = this.procMap[title];
        if (proc) {
            try { proc.kill(); } catch (e) {}
        }
        this.log(`Download cancelled by user: ${title}`);
    }

    // There's no cross-process pause signal on Windows, so we call
    // NtSuspendProcess/NtResumeProcess via PowerShell. *nix just uses signals.
    static winSuspendScript(pid, action) {
        return [
            "if(-not([System.Management.Automation.PSTypeName]'WinProc').Type){",
            "Add-Type -MemberDefinition '[DllImport(\"ntdll.dll\")] public static extern int NtSuspendProcess(IntPtr h);",
            "[DllImport(\"ntdll.dll\")] public static extern int NtResumeProcess(IntPtr h);'",
            "-Name WinProc -Namespace Win32}",
            `$p=Get-Process -Id ${pid} -EA SilentlyContinue;`,
            `if($p){[Win32.WinProc]::${action}($p.Handle)}`,
        ].join(' ');
    }

    async suspendProcess(pid) {
        if (!pid) return;
        if (process.platform === 'win32') {
            await execFileAsync('powershell', [
                '-NoProfile', '-Command', Downloader.winSuspendScript(pid, 'NtSuspendProcess'),
            ]).catch(() => {});
        } else {
            try { process.kill(pid, 'SIGSTOP'); } catch (e) {}
        }
    }

    async resumeProcess(pid) {
        if (!pid) return;
        if (process.platform === 'win32') {
            await execFileAsync('powershell', [
                '-NoProfile', '-Command', Downloader.winSuspendScript(pid, 'NtResumeProcess'),
            ]).catch(() => {});
        } else {
            try { process.kill(pid, 'SIGCONT'); } catch (e) {}
        }
    }

    // Block a queued task while paused.
    async waitIfPaused() {
        while (this.paused && !this.stopped) {
            await new Promise(r => setTimeout(r, 200));
        }
    }

    // --- Course scraping ---

    async downloadCourse(course_url) {
        this.log('Starting: ' + course_url);

        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        const page = await browser.newPage();
        page.setDefaultNavigationTimeout(0);

        await page.setCookie({
            name: '_domestika_session', value: this.config.cookie, domain: 'www.domestika.org',
        });

        // Skip images/fonts/CSS — we only need the HTML, and this is much faster.
        await page.setRequestInterception(true);
        page.on('request', req => {
            ['stylesheet', 'font', 'image'].includes(req.resourceType()) ? req.abort() : req.continue();
        });

        await page.goto(course_url);
        const html = await page.content();
        const $    = cheerio.load(html);

        const schema = this.findSchemaMarkup($, 'Course');
        if (!schema) {
            this.log('ERROR: Could not read course info. Is your cookie valid?');
            await browser.close();
            return;
        }
        const title = schema.name.trim().replace(/[/\\?%*:|"<>]/g, '-');
        this.log('Course: ' + title);

        // Standard courses use this selector; guided courses don't, so fall
        // back to scanning every /units/ link and de-duplicating.
        let units = $('h4.h2.unit-item__title a');
        if (units.length === 0) {
            this.log('Trying fallback selector for guided courses...');
            const seen = new Set();
            const els  = [];
            $('a').each((i, el) => {
                const rawHref   = $(el).attr('href') || '';
                const cleanHref = rawHref.split('#')[0]; // drop #course_lesson_xxx
                if (cleanHref.includes('/units/') && !seen.has(cleanHref)) {
                    seen.add(cleanHref);
                    $(el).attr('href', cleanHref);
                    els.push(el);
                }
            });
            units = $(els);
        }

        if (units.length === 0) {
            // Dump the page for debugging. Goes to the temp dir because the
            // working dir may be read-only in a packaged app; never fatal.
            let dbgPath = '';
            try {
                dbgPath = path.join(os.tmpdir(), 'downstika_debug_course_page.html');
                await fs.promises.writeFile(dbgPath, html);
            } catch (e) { dbgPath = '(could not write debug file)'; }
            this.log('ERROR: No units found. Debug page saved to: ' + dbgPath);
            await browser.close();
            return;
        }

        this.log(`Found ${units.length} units`);

        // Pull the final-project id (if any) and drop that link from the units.
        const regex_final    = /courses\/(.*?)-*\/final_project/;
        let final_project_id = units
            .map((i, el) => { const m = regex_final.exec($(el).attr('href') || ''); return m ? m[1].split('-')[0] : null; })
            .get()
            .find(id => id !== null);

        units = units.filter((i, el) => !regex_final.test($(el).attr('href') || ''));

        // Visit each unit page and collect its videos.
        const allVideos = [];
        for (let i = 0; i < units.length; i++) {
            if (this.stopped) break;
            const el = $(units[i]);
            allVideos.push({
                title:     el.text().replaceAll('.', '').trim().replace(/[/\\?%*:|"<>]/g, '-'),
                videoData: await this.getUnitVideos(el.attr('href'), page),
            });
        }

        // The final project lives behind the API and needs the access token.
        if (final_project_id && this.access_token) {
            this.log('Fetching final project...');
            const fp = await this.fetchFromApi(
                `https://api.domestika.org/api/courses/${final_project_id}/final-project?with_server_timing=true`,
                'finalProject.v1'
            );
            if (fp?.data?.relationships?.video?.data) {
                const vid = await this.fetchFromApi(
                    `https://api.domestika.org/api/videos/${fp.data.relationships.video.data.id}?with_server_timing=true`,
                    'video.v1'
                );
                if (vid?.data?.attributes?.playbackUrl) {
                    allVideos.push({
                        title: 'Final project',
                        videoData: [{ playbackURL: vid.data.attributes.playbackUrl, title: 'Final project', section: 'Final project' }],
                    });
                    this.log('Final project added');
                }
            }
        }

        // Turn every video into a task and run them with the concurrency limit.
        const total = allVideos.reduce((sum, u) => sum + u.videoData.length, 0);
        let count   = 0;
        const tasks = [];

        for (const unit of allVideos) {
            for (let a = 0; a < unit.videoData.length; a++) {
                const vData = unit.videoData[a];
                const idx   = ++count;

                tasks.push(async () => {
                    await this.waitIfPaused();
                    if (this.stopped) return;

                    this.emit('download-start', { title: vData.title, current: idx, total });

                    // Up to 3 attempts before giving up on this video.
                    const maxAttempts = 3;
                    let result, lastError;

                    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                        try {
                            result    = await this.downloadVideo(vData, title, unit.title, a);
                            lastError = null;
                            break;
                        } catch (err) {
                            lastError = err;
                            if (this.stopped || this.cancelledTitles.has(vData.title)) break;
                            if (attempt < maxAttempts) {
                                this.log(`Retrying (${attempt}/${maxAttempts - 1}): ${vData.title}`);
                            }
                        }
                    }

                    // Translate the outcome into the right done event.
                    if (this.cancelledTitles.has(vData.title)) {
                        this.cancelledTitles.delete(vData.title);
                        this.emit('download-done', { title: vData.title, success: false, cancelled: true });
                    } else if (result === 'already-exists') {
                        this.emit('download-done', { title: vData.title, success: true, alreadyExists: true });
                    } else if (result === 'skipped' && this.stopped) {
                        this.emit('download-done', { title: vData.title, success: false, interrupted: true });
                    } else if (result === 'skipped') {
                        this.emit('download-done', { title: vData.title, success: false, skipped: true });
                    } else if (lastError) {
                        if (this.stopped) return;
                        this.failedVideoData.push({ vData, courseTitle: title, unitTitle: unit.title, index: a });
                        this.log('Failed: ' + vData.title + ' — ' + lastError.message);
                        this.emit('download-done', { title: vData.title, success: false, error: lastError.message });
                    } else {
                        this.emit('download-done', { title: vData.title, success: true });
                    }
                });
            }
        }

        await this.runWithConcurrency(tasks, this.config.maxConcurrent);

        // One automatic retry pass for anything that failed.
        if (this.failedVideoData.length > 0 && !this.stopped) {
            this.log(`Auto-retrying ${this.failedVideoData.length} failed video(s)...`);
            await this.runRetry();
        }

        await page.close();
        await browser.close();

        if (!this.stopped) {
            this.emit('course-done', { title });
            this.log('Course complete: ' + title);
        }
    }

    // Shared by the automatic post-run retry pass.
    async runRetry() {
        const toRetry        = [...this.failedVideoData];
        this.failedVideoData = [];

        const retryTasks = toRetry.map(({ vData, courseTitle, unitTitle, index }) => async () => {
            await this.waitIfPaused();
            if (this.stopped) return;

            this.emit('download-retry', { title: vData.title }); // reset the UI row

            try {
                const result = await this.downloadVideo(vData, courseTitle, unitTitle, index);
                if (result === 'already-exists') {
                    this.emit('download-done', { title: vData.title, success: true, alreadyExists: true });
                } else if (result === 'skipped' && this.stopped) {
                    this.emit('download-done', { title: vData.title, success: false, interrupted: true });
                } else if (result === 'skipped') {
                    this.emit('download-done', { title: vData.title, success: false, skipped: true });
                } else {
                    this.emit('download-done', { title: vData.title, success: true });
                }
            } catch (err) {
                if (this.stopped) return;
                this.failedVideoData.push({ vData, courseTitle, unitTitle, index });
                this.log('Retry failed: ' + vData.title);
                this.emit('download-done', { title: vData.title, success: false, error: err.message });
            }
        });

        await this.runWithConcurrency(retryTasks, this.config.maxConcurrent);
    }

    // Retry a single video (per-item retry button). Keeps its data on the
    // failed list if it fails again so the button stays available.
    async retryVideo(title) {
        const idx = this.failedVideoData.findIndex(f => f.vData.title === title);
        if (idx === -1) return;
        const { vData, courseTitle, unitTitle, index } = this.failedVideoData.splice(idx, 1)[0];
        this.stopped = false;

        try {
            const result = await this.downloadVideo(vData, courseTitle, unitTitle, index);
            if (this.cancelledTitles.has(vData.title)) {
                this.cancelledTitles.delete(vData.title);
                this.emit('download-done', { title: vData.title, success: false, cancelled: true });
            } else if (result === 'already-exists') {
                this.emit('download-done', { title: vData.title, success: true, alreadyExists: true });
            } else if (result === 'skipped' && this.stopped) {
                this.emit('download-done', { title: vData.title, success: false, interrupted: true });
            } else if (result === 'skipped') {
                this.emit('download-done', { title: vData.title, success: false, skipped: true });
            } else {
                this.emit('download-done', { title: vData.title, success: true });
            }
        } catch (err) {
            if (!this.stopped) {
                this.failedVideoData.push({ vData, courseTitle, unitTitle, index });
                this.log('Retry failed: ' + title);
                this.emit('download-done', { title: vData.title, success: false, error: err.message });
            }
        }
    }

    // Read a unit page and pull the video list out of the embedded props.
    async getUnitVideos(url, page) {
        await page.goto(url);
        const data    = await page.evaluate(() => window.__INITIAL_PROPS__);
        const $       = cheerio.load(await page.content());
        const section = $('h2.h3.course-header-new__subtitle').text().trim().replace(/[/\\?%*:|"<>]/g, '-');
        const videos  = [];
        if (data?.videos?.length > 0) {
            for (const el of data.videos) {
                videos.push({ playbackURL: el.video.playbackURL, title: el.video.title.replaceAll('.', '').trim().replace(/[/\\?%*:|"<>]/g, '-'), section });
                this.log('Found video: ' + el.video.title);
            }
        }
        return videos;
    }

    // --- Download ---

    // True if the file exists, is non-empty, and ffprobe can read a video
    // stream from it. Used to skip already-downloaded videos.
    async checkFileHealth(filePath) {
        try {
            const stat = await fs.promises.stat(longPath(filePath));
            if (stat.size === 0) return false;

            const ffprobe = getBinPath('ffprobe');
            const { stdout } = await execFileAsync(ffprobe, [
                '-v', 'error',
                '-select_streams', 'v:0',
                '-show_entries', 'stream=codec_name',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                longPath(filePath),
            ]);
            return stdout.trim().length > 0;
        } catch {
            return false;
        }
    }

    async downloadVideo(vData, courseTitle, unitTitle, index) {
        // Final destination the user actually sees. Title capped just to keep
        // file names reasonable.
        const titlePart = vData.title.trimEnd().substring(0, 80);
        const saveName  = `${index}_${titlePart}`;
        const saveDir   = path.join(this.config.savePath || 'domestika_courses', courseTitle, vData.section, unitTitle);

        // Already downloaded and healthy? Skip it.
        const existingFile = path.join(saveDir, saveName + '.mp4');
        if (await pathExists(longPath(existingFile))) {
            this.log(`Checking file health: ${vData.title}`);
            const healthy = await this.checkFileHealth(existingFile);
            if (healthy) {
                this.log(`✔ Already downloaded (healthy), skipping: ${vData.title}`);
                this.emit('download-progress', { title: vData.title, percent: 100, detail: 'Already downloaded' });
                return 'already-exists';
            } else {
                this.log(`⚠ File exists but is corrupt — re-downloading: ${vData.title}`);
                try { await fs.promises.unlink(longPath(existingFile)); } catch {}
            }
        }

        // Work in a short temp dir so N_m3u8DL-RE/ffmpeg never hit MAX_PATH.
        const tmpDir = path.join(
            os.tmpdir(),
            `dstk_${process.pid}_${(tmpSeq++).toString(36)}_${crypto.randomBytes(3).toString('hex')}`
        );
        await fs.promises.mkdir(longPath(tmpDir), { recursive: true });
        const tmpName = 'v';

        try {
            const exePath = getBinPath('N_m3u8DL-RE');

            // cwd = tmpDir so the tool's own log file path stays short too.
            // We deliberately don't pass --log-level OFF: it breaks
            // SimpleDownloadManager (the direct-MP4 code path).
            const r1 = await this.spawnProcess(exePath, [
                '-sv', 'res=1080*:for=best',
                vData.playbackURL,
                '--save-dir', tmpDir, '--tmp-dir', tmpDir, '--save-name', tmpName,
            ], vData.title, tmpDir);

            if (r1 === 'skipped') return 'skipped';

            await this.spawnProcess(exePath, [
                '--auto-subtitle-fix',
                '--sub-format', 'SRT',
                '--select-subtitle', `lang=${this.config.subtitleLang}:for=all`,
                vData.playbackURL,
                '--save-dir', tmpDir, '--tmp-dir', tmpDir, '--save-name', tmpName,
            ], vData.title + ' (subtitles)', tmpDir);

            if (this.config.transcodeToHevc) {
                await this.transcodeVideo(tmpDir, tmpName, vData.title);
            }

            // Move the finished files (v.mp4, v.en.srt, ...) to the real path.
            await fs.promises.mkdir(longPath(saveDir), { recursive: true });
            let movedVideo = false;
            for (const f of await fs.promises.readdir(longPath(tmpDir))) {
                if (!f.startsWith(tmpName + '.')) continue;
                const src = path.join(tmpDir, f);
                const dst = path.join(saveDir, saveName + f.slice(tmpName.length));
                await fs.promises.copyFile(longPath(src), longPath(dst));
                if (f.endsWith('.mp4')) movedVideo = true;
            }

            if (!movedVideo) throw new Error('Download produced no video file');

            return 'done';
        } finally {
            // Always clear the temp dir, even on failure, so a retry is clean.
            try { await fs.promises.rm(longPath(tmpDir), { recursive: true, force: true }); } catch {}
        }
    }

    // Re-encode to H.265 if it isn't already. Runs in the short temp dir, so
    // paths are never an issue here.
    async transcodeVideo(workDir, saveName, videoTitle) {
        const inputFile  = path.join(workDir, saveName + '.mp4');
        const tempOutput = path.join(workDir, saveName + '_hevc.mp4');

        if (!(await pathExists(inputFile))) {
            this.log(`Transcode skipped — file not found: ${saveName}.mp4`);
            return;
        }

        try {
            const ffprobe = getBinPath('ffprobe');
            const ffmpeg  = getBinPath('ffmpeg');
            const { stdout } = await execFileAsync(ffprobe, [
                '-v', 'error',
                '-select_streams', 'v:0',
                '-show_entries', 'stream=codec_name',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                inputFile,
            ]);
            const currentCodec = stdout.trim();

            if (currentCodec === 'hevc' || currentCodec === 'h265') {
                this.log(`${videoTitle}: already H.265, skipping transcode`);
                return;
            }

            this.log(`Transcoding ${videoTitle} from ${currentCodec} to H.265...`);
            this.emit('download-progress', { title: videoTitle, percent: 99, detail: 'Transcoding to H.265…' });

            const encoder     = this.config.useNvenc ? 'hevc_nvenc' : 'libx265';
            const encoderArgs = this.config.useNvenc
                ? ['-preset', 'p7', '-tune', 'hq', '-rc', 'vbr', '-cq', '23', '-b:v', '0']
                : ['-preset', 'medium', '-crf', '23'];

            // -loglevel error keeps ffmpeg's stderr from filling the buffer on
            // long encodes; the big maxBuffer is belt-and-braces for that.
            await execFileAsync(ffmpeg, [
                '-hide_banner', '-loglevel', 'error', '-y',
                '-i', inputFile,
                '-c:v', encoder, ...encoderArgs,
                '-c:a', 'copy', '-c:s', 'copy',
                tempOutput,
            ], { maxBuffer: 1024 * 1024 * 64 });

            await fs.promises.unlink(inputFile);
            await fs.promises.rename(tempOutput, inputFile);

            this.log(`Transcode complete: ${videoTitle}`);
        } catch (err) {
            this.log(`Transcode error for ${videoTitle}: ${err.message}`);
        }
    }

    // Run N_m3u8DL-RE and parse its output for progress. Resolves 'done',
    // or 'skipped' if it was killed (stop/skip/cancel); rejects on error.
    spawnProcess(exePath, args, videoTitle, cwd) {
        return new Promise((resolve, reject) => {
            const proc = spawn(exePath, args, {
                env: { ...process.env, CI: 'true', NO_COLOR: '1' },
                cwd: cwd || undefined,
            });

            this.activeProcs.push(proc);
            this.procMap[videoTitle] = proc;
            let outputBuffer = '';

            const parseProgress = (rawData) => {
                // Strip ANSI codes so the regexes match cleanly.
                const text = rawData.toString().replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');

                // "12/71" -> segment progress.
                const segMatch = /(\d+)\s*\/\s*(\d+)/.exec(text);
                if (segMatch) {
                    const cur = parseInt(segMatch[1]);
                    const tot = parseInt(segMatch[2]);
                    if (tot > 0 && cur <= tot) {
                        const percent = Math.round((cur / tot) * 100);
                        this.emit('download-progress', { title: videoTitle, percent, detail: `${cur}/${tot} segments` });
                    }
                    return;
                }

                // "45.2%" -> percentage progress.
                const pctMatch = /(\d+(?:\.\d+)?)%/.exec(text);
                if (pctMatch) {
                    const percent = parseFloat(pctMatch[1]);
                    if (percent <= 100) {
                        this.emit('download-progress', { title: videoTitle, percent, detail: text.trim().slice(0, 50) });
                    }
                }
            };

            proc.stdout.on('data', data => { outputBuffer += data; parseProgress(data); });
            proc.stderr.on('data', data => { outputBuffer += data; parseProgress(data); });

            proc.on('close', (code, signal) => {
                this.activeProcs = this.activeProcs.filter(p => p !== proc);
                delete this.procMap[videoTitle];
                if (signal || code === null) {
                    resolve('skipped'); // killed by stop/skip/cancel
                } else if (code === 0) {
                    this.emit('download-progress', { title: videoTitle, percent: 100, detail: 'Complete' });
                    resolve('done');
                } else {
                    reject(new Error(outputBuffer.slice(-600) || `Exit code ${code}`));
                }
            });

            proc.on('error', err => {
                this.activeProcs = this.activeProcs.filter(p => p !== proc);
                delete this.procMap[videoTitle];
                reject(err);
            });
        });
    }

    // --- Helpers ---

    // Run tasks with at most `max` in flight at once.
    async runWithConcurrency(tasks, max) {
        const running = [];
        for (const task of tasks) {
            if (this.stopped) break;
            const p = task().then(r => { running.splice(running.indexOf(p), 1); return r; });
            running.push(p);
            if (running.length >= max) await Promise.race(running);
        }
        return Promise.all(running);
    }

    // Find the JSON-LD schema block of a given @type on the page.
    findSchemaMarkup($, type) {
        const scripts = $('script[type=application/ld+json]');
        for (let i = 0; i < scripts.length; i++) {
            try {
                const parsed     = JSON.parse($(scripts[i]).html().trim());
                const candidates = Array.isArray(parsed) ? parsed : [parsed];
                for (const entry of candidates) {
                    if (entry['@context']?.includes('schema.org') && entry['@type'] === type) return entry;
                }
            } catch (e) {}
        }
        return null;
    }

    // Authenticated call to the Domestika API (used for the final project).
    async fetchFromApi(url, acceptVersion) {
        const res = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization':          `Bearer ${this.access_token}`,
                'Accept':                 'application/vnd.api+json',
                'Content-Type':           'application/vnd.api+json',
                'x-dmstk-accept-version': acceptVersion,
            },
        });
        if (!res.ok) return false;
        try { return await res.json(); } catch { return false; }
    }
}

module.exports = Downloader;
