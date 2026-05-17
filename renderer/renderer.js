/*
 * Renderer / UI logic.
 *
 * Handles the settings form, the course queue, and all the live progress
 * updates streamed from the main process. Talks to the backend only through
 * the `window.api` bridge defined in preload.js.
 */

// State
const courseQueue = [];
let totalVideos  = 0;
let doneVideos   = 0;
let isPaused     = false;
let failedVideos = [];          // { number, title } per failed download
const videoNumbers = {};        // title -> download number, set on download-start

// The session cookie / credentials go stale over time. If the app has been
// closed longer than this, we wipe the saved pair so the user pastes fresh
// values (everything else persists as normal).
const CRED_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

// Restore saved settings and wire up listeners once the page loads.
window.onload = () => {
    // Was the app closed long enough that the cookie is probably stale?
    const lastSeen     = parseInt(localStorage.getItem('lastSeen') || '0', 10);
    const credsExpired = !lastSeen || (Date.now() - lastSeen) > CRED_TTL_MS;
    if (credsExpired) {
        localStorage.removeItem('cookie');
        localStorage.removeItem('credentials');
    }

    document.getElementById('cookie').value          = localStorage.getItem('cookie')          || '';
    document.getElementById('credentials').value     = localStorage.getItem('credentials')     || '';
    document.getElementById('subtitleLang').value    = localStorage.getItem('subtitleLang')    || 'en';
    document.getElementById('maxConcurrent').value   = localStorage.getItem('maxConcurrent')   || '3';
    document.getElementById('savePath').value        = localStorage.getItem('savePath')        || '';
    document.getElementById('transcodeHevc').checked = localStorage.getItem('transcodeHevc') === 'true';
    document.getElementById('useNvenc').checked      = localStorage.getItem('useNvenc')      === 'true';

    document.getElementById('osText').textContent = window.api.osName || 'Unknown';

    // The NVENC option only makes sense when transcoding is on.
    document.getElementById('nvencRow').style.display =
        document.getElementById('transcodeHevc').checked ? 'flex' : 'none';

    document.getElementById('transcodeHevc').addEventListener('change', () => {
        document.getElementById('nvencRow').style.display =
            document.getElementById('transcodeHevc').checked ? 'flex' : 'none';
        saveSettings();
    });

    // Heartbeat so the next launch knows how long the app was closed. The
    // 30s cadence keeps it accurate even if the process is killed rather
    // than closed cleanly; beforeunload covers the clean-close case.
    const markSeen = () => localStorage.setItem('lastSeen', Date.now().toString());
    markSeen();
    setInterval(markSeen, 30000);
    window.addEventListener('beforeunload', markSeen);

    renderQueue();
    registerIpcListeners();
};

// Persist settings whenever a field changes.
['cookie', 'credentials', 'subtitleLang', 'maxConcurrent', 'savePath'].forEach(id => {
    document.getElementById(id).addEventListener('change', saveSettings);
});
document.getElementById('useNvenc').addEventListener('change', saveSettings);

function saveSettings() {
    localStorage.setItem('cookie',        document.getElementById('cookie').value);
    localStorage.setItem('credentials',   document.getElementById('credentials').value);
    localStorage.setItem('subtitleLang',  document.getElementById('subtitleLang').value);
    localStorage.setItem('maxConcurrent', document.getElementById('maxConcurrent').value);
    localStorage.setItem('savePath',      document.getElementById('savePath').value);
    localStorage.setItem('transcodeHevc', document.getElementById('transcodeHevc').checked);
    localStorage.setItem('useNvenc',      document.getElementById('useNvenc').checked);
}

async function browseFolder() {
    const folder = await window.api.chooseFolder();
    if (folder) {
        document.getElementById('savePath').value = folder;
        saveSettings();
    }
}

function closeDisclaimer() {
    document.getElementById('disclaimerOverlay').classList.add('hidden');
}

function toggleInstructions() {
    const panel  = document.getElementById('instructions');
    const btn    = document.querySelector('.help-btn');
    const isOpen = panel.style.display !== 'none';
    panel.style.display = isOpen ? 'none' : 'block';
    btn.textContent     = isOpen ? '?'   : '✕';
    btn.classList.toggle('active', !isOpen);
}

// Course queue
function addCourse() {
    const input = document.getElementById('urlInput');
    const url   = input.value.trim();

    if (!url.includes('domestika.org/')) {
        alert('Please enter a valid Domestika course URL.');
        return;
    }
    if (courseQueue.includes(url)) {
        alert('This URL is already in the queue.');
        return;
    }
    courseQueue.push(url);
    input.value = '';
    renderQueue();
}

function removeCourse(index) {
    courseQueue.splice(index, 1);
    renderQueue();
}

function renderQueue() {
    const list = document.getElementById('queue');
    list.innerHTML = '';

    if (courseQueue.length === 0) {
        list.innerHTML = '<li style="color:#444;font-size:12px;background:none;border:none;">No courses added yet.</li>';
        return;
    }

    courseQueue.forEach((url, i) => {
        const li     = document.createElement('li');
        li.innerHTML = `<span>${url}</span><button class="remove-btn" onclick="removeCourse(${i})">✕</button>`;
        list.appendChild(li);
    });
}

document.getElementById('urlInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') addCourse();
});

// Backend events. Registered once on load (not per download) so listeners
// don't pile up across runs.
function registerIpcListeners() {

    window.api.onLog(msg => addLog(msg));

    window.api.onDownloadStart(({ title, current, total }) => {
        totalVideos         = total;
        videoNumbers[title] = current;
        updateOverall();
        addProgressItem(title);
        addLog(`⬇️ Downloading (${current}/${total}): ${title}`);
    });

    window.api.onDownloadProgress(({ title, percent, detail }) => {
        updateProgressBar(title, percent, detail);
    });

    window.api.onDownloadDone(({ title, success, cancelled, skipped, interrupted, error, alreadyExists }) => {
        if (cancelled) {
            markProgressItem(title, 'cancelled');
            addLog(`🚫 Cancelled: ${title}`);
        } else if (interrupted) {
            markProgressItem(title, 'interrupted');
        } else if (skipped) {
            markProgressItem(title, 'skipped');
            addLog(`⏭ Skipped: ${title}`);
        } else if (alreadyExists) {
            doneVideos++;
            updateOverall();
            markProgressItem(title, 'already-exists');
        } else if (success) {
            doneVideos++;
            updateOverall();
            markProgressItem(title, 'done');
        } else {
            markProgressItem(title, 'error');
            failedVideos.push({ number: videoNumbers[title] || '?', title });
            if (error) addLog('❌ ' + title + ': ' + error);
        }
    });

    window.api.onCourseDone(({ title }) => {
        addLog('✅ Finished: ' + title);
    });

    window.api.onAllDone(({ stopped, hasFailures } = {}) => {
        if (stopped) {
            addLog('🛑 Download interrupted by user.');
            document.getElementById('overallLabel').textContent = `🛑 Interrupted — ${doneVideos} / ${totalVideos} videos`;
        } else if (hasFailures) {
            const failedStr = failedVideos.map(f => `#${f.number} ${f.title}`).join(',  ');
            addLog(`⚠️ All downloads complete except: ${failedStr}`);
            addLog('👆 Use the 🔄 button on each failed item to retry.');
            document.getElementById('overallLabel').textContent = `⚠️ Done with errors — ${doneVideos} / ${totalVideos} videos`;
        } else {
            addLog('🎉 All downloads complete!');
            document.getElementById('overallLabel').textContent = `✅ Done — ${doneVideos} / ${totalVideos} videos`;
        }
        document.getElementById('startBtn').disabled = false;
        setControlsDisabled(true);
    });

    window.api.onDownloadRetry(({ title }) => {
        resetProgressItem(title);
        // Drop it from the failed list so it isn't double-counted if it fails again.
        failedVideos = failedVideos.filter(f => f.title !== title);
        addLog(`🔄 Retrying: ${title}`);
    });

    // Map CPU load to the status dot's blink speed: idle ~1.8s per blink,
    // full load ~0.25s, linear in between.
    window.api.onCpuUsage(pct => {
        const dot = document.getElementById('liveDot');
        if (!dot) return;
        const clamped  = Math.max(0, Math.min(100, pct));
        const duration = (1.8 - (clamped / 100) * 1.55).toFixed(2);
        dot.style.animationDuration = duration + 's';
    });
}

function startDownloads() {
    if (courseQueue.length === 0) { alert('Add at least one course URL first.'); return; }
    const cookie = document.getElementById('cookie').value.trim();
    if (!cookie) { alert('Please enter your session cookie.'); return; }

    saveSettings();

    const config = {
        cookie:          cookie,
        credentials:     document.getElementById('credentials').value.trim(),
        subtitleLang:    document.getElementById('subtitleLang').value.trim() || 'en',
        maxConcurrent:   parseInt(document.getElementById('maxConcurrent').value) || 3,
        savePath:        document.getElementById('savePath').value.trim(), // blank -> main.js uses Downloads
        transcodeToHevc: document.getElementById('transcodeHevc').checked,
        useNvenc:        document.getElementById('useNvenc').checked,
    };

    totalVideos  = 0;
    doneVideos   = 0;
    isPaused     = false;
    failedVideos = [];
    document.getElementById('progressSection').style.display = 'block';
    document.getElementById('startBtn').disabled = true;
    document.getElementById('progressList').innerHTML = '';
    document.getElementById('log').innerHTML = '';
    document.getElementById('overallBar').style.width = '0%';
    document.getElementById('overallLabel').textContent = 'Starting...';
    document.getElementById('pauseBtn').textContent = '⏸ Pause';
    document.getElementById('pauseBtn').classList.remove('paused');
    document.getElementById('progressSection').scrollIntoView({ behavior: 'smooth' });
    setControlsDisabled(false);

    window.api.startDownloads([...courseQueue], config);
}

// Controls
function togglePause() {
    if (isPaused) {
        isPaused = false;
        window.api.resumeDownloads();
        document.getElementById('pauseBtn').textContent = '⏸ Pause';
        document.getElementById('pauseBtn').classList.remove('paused');
        addLog('▶️ Resumed');
    } else {
        isPaused = true;
        window.api.pauseDownloads();
        document.getElementById('pauseBtn').textContent = '▶ Resume';
        document.getElementById('pauseBtn').classList.add('paused');
        addLog('⏸ Paused');
    }
}

function skipDownload() {
    window.api.skipDownload();
}

function stopDownloads() {
    if (!confirm('Stop all downloads?')) return;
    window.api.stopDownloads();
    addLog('⏹ Stopped by user.');
    document.getElementById('startBtn').disabled = false;
    setControlsDisabled(true);
}

function setControlsDisabled(disabled) {
    document.getElementById('pauseBtn').disabled = disabled;
    document.getElementById('skipBtn').disabled  = disabled;
    document.getElementById('stopBtn').disabled  = disabled;
}

// Overall progress bar
function updateOverall() {
    const pct = totalVideos > 0 ? Math.round((doneVideos / totalVideos) * 100) : 0;
    const bar = document.getElementById('overallBar');
    bar.style.width = pct + '%';
    bar.className   = 'bar-fill' + (pct === 100 ? ' done' : '');
    document.getElementById('overallLabel').textContent = `${doneVideos} / ${totalVideos} videos  (${pct}%)`;
}

// Per-video progress rows
function addProgressItem(title) {
    if (document.getElementById('pi-' + toId(title))) return; // already shown

    const div = document.createElement('div');
    div.className = 'progress-item';
    div.id        = 'pi-' + toId(title);
    div.innerHTML = `
        <div class="item-header">
            <span class="icon">⏳</span>
            <span class="title" title="${title}">${title}</span>
            <span class="detail" id="detail-${toId(title)}">Starting…</span>
            <button class="item-retry-btn" id="retry-btn-${toId(title)}" title="Retry this download" style="display:none">🔄</button>
            <button class="item-cancel-btn" id="cancel-btn-${toId(title)}" title="Cancel this download">✕</button>
        </div>
        <div class="bar-track">
            <div class="bar-fill active" id="bar-${toId(title)}" style="width:5%"></div>
        </div>
    `;
    document.getElementById('progressList').appendChild(div);

    // addEventListener (not inline onclick) so titles with quotes are safe.
    div.querySelector('.item-retry-btn').addEventListener('click', () => retryVideoItem(title));
    div.querySelector('.item-cancel-btn').addEventListener('click', () => cancelVideoItem(title));

    div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function updateProgressBar(title, percent, detail) {
    const bar   = document.getElementById('bar-'    + toId(title));
    const detEl = document.getElementById('detail-' + toId(title));
    if (bar)   bar.style.width   = percent + '%';
    if (detEl) detEl.textContent = detail || (percent + '%');
}

// Put a failed row back into the "downloading" state before a retry.
function resetProgressItem(title) {
    const item   = document.getElementById('pi-'         + toId(title));
    const bar    = document.getElementById('bar-'        + toId(title));
    const detEl  = document.getElementById('detail-'     + toId(title));
    const canBtn = document.getElementById('cancel-btn-' + toId(title));
    if (!item) return;

    item.querySelector('.icon').textContent = '⏳';
    bar.style.width   = '5%';
    bar.className     = 'bar-fill active';
    detEl.textContent = 'Retrying…';

    const retBtn = document.getElementById('retry-btn-' + toId(title));
    if (retBtn) retBtn.style.display = 'none';
    if (canBtn) canBtn.style.display = '';
}

function markProgressItem(title, status) {
    const item   = document.getElementById('pi-'         + toId(title));
    const bar    = document.getElementById('bar-'        + toId(title));
    const detEl  = document.getElementById('detail-'     + toId(title));
    const canBtn = document.getElementById('cancel-btn-' + toId(title));
    if (!item) return;

    if (canBtn) canBtn.style.display = 'none';

    const icon = item.querySelector('.icon');
    if (status === 'done') {
        icon.textContent  = '✅';
        bar.style.width   = '100%';
        bar.className     = 'bar-fill done';
        detEl.textContent = 'Done';
    } else if (status === 'already-exists') {
        icon.textContent  = '✅';
        bar.style.width   = '100%';
        bar.className     = 'bar-fill done';
        detEl.textContent = 'Already downloaded';
    } else if (status === 'interrupted') {
        icon.textContent  = '🛑';
        bar.className     = 'bar-fill interrupted';
        detEl.textContent = 'Interrupted';
    } else if (status === 'skipped') {
        icon.textContent  = '⏭';
        bar.style.width   = '100%';
        bar.className     = 'bar-fill skipped';
        detEl.textContent = 'Skipped';
    } else if (status === 'cancelled') {
        icon.textContent  = '🚫';
        bar.className     = 'bar-fill cancelled';
        detEl.textContent = 'Cancelled';
    } else {
        icon.textContent  = '❌';
        bar.className     = 'bar-fill error';
        detEl.textContent = 'Failed to download';
        const retBtn = document.getElementById('retry-btn-' + toId(title));
        if (retBtn) retBtn.style.display = ''; // let the user retry just this one
    }
}

function retryVideoItem(title) {
    failedVideos = failedVideos.filter(f => f.title !== title);
    resetProgressItem(title);
    addLog(`🔄 Retrying: ${title}`);
    window.api.retryVideo(title);
}

function cancelVideoItem(title) {
    window.api.cancelVideo(title);
    addLog(`🚫 Cancelling: ${title}`);
}

// Log
function addLog(msg) {
    const log = document.getElementById('log');
    // insertAdjacentHTML appends without re-parsing the existing log, which
    // keeps things smooth even on long (80+ line) courses.
    log.insertAdjacentHTML('beforeend', msg + '<br>');
    log.scrollTop = log.scrollHeight;
}

function copyLog() {
    const log  = document.getElementById('log');
    const text = log.innerText.trim();
    if (!text) return;

    navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('copyBtn');
        btn.textContent = '✅ Copied';
        setTimeout(() => { btn.textContent = '📋 Copy'; }, 2000);
    });
}

// Build a DOM-id-safe key from a video title.
function toId(str) {
    return str.replace(/[^a-zA-Z0-9]/g, '_');
}
