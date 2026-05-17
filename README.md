# Downstika

A desktop app for downloading Domestika courses you own. It's a GUI built on top of
the original command-line downloader by ReneR97 (see Credits).

You need to actually own the course you're downloading. That means you either bought
it, or you have access through a Domestika Plus / Premium membership. This just
automates downloading content you already paid for so you can watch it offline. Don't
use it for anything else.

## Disclaimer

This is a personal, non-commercial project made for learning and for the convenience
of people who already own Domestika courses and want to watch them offline.

- It does not promote, support, or encourage piracy of any kind.
- It is not meant to share, resell, redistribute, or monetize course content.
- It does not bypass payment - you must already have legitimate access to a course.
- It is not affiliated with, endorsed by, or connected to Domestika.

Domestika course content is owned by Domestika and its instructors and is protected by
copyright. This tool does not grant you any rights over that content. Downloading
content can also be against Domestika's Terms of Service, even for courses you have
paid for, so use this only for your own personal offline access and at your own
responsibility. The author is not responsible for how anyone uses this software, and
this is not legal advice.

If you are a Domestika representative and have concerns about this project, please open
an issue and it will be addressed.

## Supported platforms

- Windows 10 / 11 - the main target, most tested.
- macOS (Intel and Apple Silicon) - works, but needs more real-world testing.
- Linux (AppImage / .deb) - works, but needs more real-world testing.

The app detects your OS at runtime and uses the right binaries for it.

## Installing (if you just want to use it)

Download the installer for your system from the Releases page:

- Windows: `Downstika Setup x.x.x.exe`
- macOS: `Downstika-x.x.x.dmg`
- Linux: `Downstika-x.x.x.AppImage` or the `.deb`

Installers are attached to Releases, not committed to the repo. GitHub doesn't allow
files over 100 MB, and the installers are bigger than that.

## How to use it

You need two values from a logged-in Domestika session. The easiest way to get them
is the free Cookie-Editor browser extension.

1. Install the Cookie-Editor extension in Chrome.
2. Go to domestika.org and log in.
3. Open Cookie-Editor from the toolbar.
4. Copy the value of `_domestika_session` and paste it into the Session Cookie field.
5. Copy the value of `_credentials_` and paste it into the Credentials field. This one
   is optional as it's only used for the Final Project video, so leave it blank if you
   don't need that.
6. Open the course's content page (the URL ends in `/course`), copy the link, paste it
   into the app, and click Add. You can queue up several courses.
7. Click Start Downloads.

The saved cookie and credentials are cleared automatically if the app has been closed
for more than 2 hours, so you paste a fresh cookie next time instead of hitting an
expired session. Your other settings stay saved.

## Features

- Queue and download multiple courses in one run.
- Per-video progress, an overall progress bar, and a running log.
- Pause, Resume, Skip, and Stop while it's running.
- Cancel or retry an individual video.
- Each video is tried 3 times, with one automatic retry pass at the end and a manual
  retry button for anything still failing.
- Skips files you already have (checked with ffprobe) and re-downloads broken ones, so
  re-running a course just fills in what's missing.
- Subtitles saved as .srt in the language you choose.
- Optional H.265 conversion to save space, using the CPU (libx265) or an NVIDIA GPU
  (NVENC).
- Saves to Downloads/domestika_courses if you don't pick a folder.
- Downloads the Final Project when credentials are provided.

## Development

Requires Node.js (LTS).

```
git clone https://github.com/ArcticNavigator/Domestika-Course-Downloader.git
cd Domestika-Course-Downloader
npm install
```

### Binaries

The app shells out to three command-line tools that aren't in the repo (each ffmpeg is
about 190 MB and GitHub rejects files over 100 MB). Create these folders in the project
root and put the binaries in them:

```
win/         N_m3u8DL-RE.exe   ffmpeg.exe   ffprobe.exe
mac-x64/     N_m3u8DL-RE       ffmpeg       ffprobe
mac-arm64/   N_m3u8DL-RE       ffmpeg       ffprobe
linux/       N_m3u8DL-RE       ffmpeg       ffprobe
```

You only need your own platform's folder to run locally. You need all of them only if
you're building installers for every OS.

- N_m3u8DL-RE: https://github.com/nilaoda/N_m3u8DL-RE/releases (v0.5.1 or newer)
- ffmpeg / ffprobe: gyan.dev or BtbN for Windows, evermeet.cx for macOS,
  johnvansickle.com for Linux.

A ready-made binaries.zip may also be attached to the latest Release if you'd rather
not collect them yourself — just extract it into the project root.

### Running and building

```
npm start              run in development
npm run build:win      Windows .exe installer
npm run build:mac      macOS .dmg
npm run build:linux    Linux AppImage + .deb
```

Output goes to `dist/`. Each build only bundles its own platform's binaries to keep
installers small. Put the finished installers on a GitHub Release, not in the repo.

### Pushing changes

```
git checkout -b your-feature
git add .
git commit -m "Describe what you changed"
git push origin your-feature
```

Then open a Pull Request. The code is deliberately kept simple and commented; please
keep it that way.

### Project layout

```
main.js          Electron main process (window, IPC, background work)
preload.js       bridge between the UI and the main process
downloader.js    scraping, downloading, transcoding, retry logic
renderer/        the UI (index.html, renderer.js, style.css) and the logo
build/icon.png   source icon the installers are generated from
package.json     app info and electron-builder config
.gitignore       keeps node_modules, binaries, build output and user data out of git
.gitattributes   consistent line endings across Windows/macOS/Linux
```

`node_modules/`, the binary folders, `dist/`, and downloaded courses are gitignored.

## Notes on this fork

This is a GUI rebuild of ReneR97's command-line downloader. Compared to the original,
the following were fixed or added:

- A desktop interface with a course queue and live progress.
- Stronger retry handling so fewer videos slip through.
- Skipping files you already have, after a health check.
- Fixed Windows crashes caused by long file paths. Windows limits how long a path can
  be, and long course or lesson names used to break the download.
- Fixed crashes caused by characters like `:` in lesson titles.
- Fixed a crash on certain videos that download through N_m3u8DL-RE's direct path.
- File operations no longer freeze the window on slow disks or during antivirus scans.
- Correct binaries per OS and architecture, automatic execute permission on
  macOS/Linux, and smaller per-platform installers.

It's tested most on Windows. The macOS and Linux fixes are in place but haven't had as
much real-world use, so testing and bug reports on those are genuinely useful. When
reporting a problem, use the Copy button in the app to grab the log and include it.

### Known issues

- macOS: the app isn't signed or notarized yet, so Gatekeeper will warn that it can't
  be checked. Right-click the app and choose Open the first time. Proper signing needs
  a paid Apple Developer account.
- Windows: the first launch can be slow while Windows Defender scans the binaries.
  It's fast after that.
- Linux: fine on mainstream distributions. Very minimal setups may need a few extra
  system libraries for the bundled Chromium (a Chromium requirement, not the app).

## Contributing

Bug reports and pull requests are welcome.

- For a bug, open an issue with your OS, what you did, and the copied app log.
- For a change, fork the repo, work on a branch, and open a Pull Request. Keep changes
  focused and the code readable.

## Credits

- ReneR97 - the original command-line Domestika downloader this project is built on:
  https://github.com/ReneR97/domestika-downloader. Thanks for the work this builds on.
- Domestika (https://www.domestika.org/en/) for the large catalog of creative courses
  people learn from. This tool is only for saving courses you legitimately own.
- Built with N_m3u8DL-RE, FFmpeg, Electron, and Puppeteer.

## License

Custom non-commercial, source-available license. See the LICENSE file.

In short: you can use, modify, and share it for free for personal and
non-commercial purposes, with credit kept intact. You may not sell it,
use it commercially, or sublicense it. It is provided as is, with no
warranty and no liability.

This license covers the software only - it grants no rights over Domestika
course content. Only use this for content you legally own.
