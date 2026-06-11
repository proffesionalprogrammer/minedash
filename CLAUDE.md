# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is MineDash

A local Minecraft server management desktop app. Users run it on their own PC — MineDash manages the Java processes, mods, backups, networking, and scheduled tasks. It is **not** a hosted service; every user's Minecraft server runs on their own hardware.

MineDash is **also a Minecraft launcher**. `LauncherContent.jsx` / `PlaySection.jsx` own the Play view; `AccountManager.jsx` handles Microsoft device-flow sign-in and offline accounts; `backend/launcher.js` registers the `/api/launcher/*` routes and shells out to `minecraft-launcher-core` for game launch. So a typical session may involve both running a local server *and* connecting to it from the same app's launcher.

## Development Commands

**Run in dev mode (normal way):**
```
start_minedash.bat        # starts backend + frontend, opens browser at localhost:5173
```
Or via root `package.json` scripts:
```bash
npm run dev:backend        # backend on port 3001
npm run dev:frontend       # Vite dev server on port 5173
```

In dev mode the custom `TitleBar` component returns `null` (it checks `window.electronAPI?.isElectron`), so the native browser title bar is used. This is intentional.

**Build the Electron installer (.exe) for distribution:**
```bash
npm install                # from root — installs electron + electron-builder
cd frontend && npm install # frontend deps
npm run build              # builds frontend → electron/renderer/, then NSIS installer → dist-electron/
```

`npm run build` already includes `--publish=never` so it won't try to push to GitHub Releases.

**Known build gotcha — winCodeSign symlinks:** On first build, `electron-builder` downloads `winCodeSign-2.6.0.7z` and tries to extract it. On Windows Home without Developer Mode enabled the symlink extraction fails. Fix: enable **Settings → System → For Developers → Developer Mode**, then re-run `npm run build`. The extracted cache lands in `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\` and is reused on future builds.

**Releasing a new version:** bump `version` in root `package.json`, append a `## vX.Y.Z — YYYY-MM-DD` section to `CHANGELOG.md`, commit, tag (`git tag vX.Y.Z`), and push both. The `.github/workflows/build.yml` workflow triggers on `v*` tags and builds + publishes releases on the main `proffesionalprogrammer/minedash` repo (public since v1.0.99). It also mirrors the release to the legacy `proffesionalprogrammer/minedash-releases` repo so installs older than v1.0.99 — whose `app-update.yml` still points there — can pick up the switchover; the mirror step can be dropped once that population is gone. If CI doesn't fire (the user has historically also published manually), build locally with `GH_TOKEN="$(gh auth token)" npm run build:release` then flip the draft to published via `gh release edit vX.Y.Z --repo proffesionalprogrammer/minedash --draft=false --notes-file <(...)`. The auto-updater ignores drafts, so the publish step is mandatory.

There are no tests and no backend lint. Frontend has ESLint: `cd frontend && npm run lint`.

## Architecture

### Three-process model

```
Electron main process (electron/main.js)
  └── forks → Node.js backend (backend/index.js)   port 3001
  └── loads → Built React frontend (electron/renderer/) OR Vite dev server (localhost:5173)
```

In **dev mode**, Electron is not involved — the bat file runs the backend and Vite separately and opens a browser. In **production**, `electron/main.js` does everything: spawns the backend via `fork()` with `silent: true` (stdout/stderr piped to `%AppData%\MineDash\minedash-main.log`), polls `localhost:3001/api/servers` until ready, then shows the window.

### Backend (`backend/index.js`) — single very large file

All *server-management* logic lives here. The *launcher* (the client-side Minecraft side of MineDash) lives in `backend/launcher.js` and is mounted from `index.js` via `require('./launcher').register(...)` — it owns the `/api/launcher/*` routes (accounts, profiles, instances, content, settings), Microsoft device-flow + offline auth via `msmc`, and game launch via `minecraft-launcher-core`. The Azure client ID is in `AZURE_CLIENT_ID` at the top of that file.

Key patterns:

- **In-memory state**: `activeProcesses` (running MC server child processes), `activeLogs` (console output buffers), `serverStates` (uptime/players), `serverJavaPids` (actual JVM PIDs discovered via process-tree walk), `autoBackupIntervals`, `taskLastFireKey` (scheduled-task per-minute dedup).
- **Persistent state**: `servers.json` — array of server config objects. Read/written via `getServers()` / `saveServers()`. Socket event `server_updated` is emitted after every save.
- **Data directory**: Controlled by `DATA_DIR = process.env.MINEDASH_DATA_DIR || __dirname`. In packaged Electron, `MINEDASH_DATA_DIR` is set to `app.getPath('userData')` (`AppData\Roaming\MineDash`). In dev it defaults to the `backend/` folder itself.
- **Server lifecycle**: `startProcess(id, serverConfig, serverPath)` — spawns the MC Java process, wires up stdout/stderr to `appendLog()`, handles the exit event (dependency crash detection → auto-restart → backup interval cleanup → crash banner emission). When a `run.bat`/`run.sh` exists (Forge/NeoForge), we pass `nogui` as an extra arg so it's forwarded through `%*` / `"$@"` to the JVM — modern Forge's run.bat hardcodes `nogui` before `%*`, NeoForge's doesn't, and without this NeoForge boots the bundled server.jar's Swing GUI window beside the in-app console. The duplicate is harmless to MC's arg parser.
- **IPv4-first DNS**: both `backend/index.js` and `backend/launcher-worker.js` call `dns.setDefaultResultOrder('ipv4first')` at the very top. Several upstream hosts (notably `maven.neoforged.net`) publish AAAA records that hang on residential networks. The setting is **process-local** — forked workers don't inherit it, which is why it's set in both files. Add it to any new fork target that makes outbound HTTP calls.
- **Socket events**: All namespaced by server ID — `console_${id}`, `server_memory_${id}`, `crash_detected_${id}`, `players_update_${id}`. Global events: `system_stats`, `server_created`, `server_deleted`, `server_status_change`, `server_updated`.
- **CORS**: configured at the top of the file with an explicit `methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']` whitelist. **If you add a route using a method not in this list, the browser will reject it with `TypeError: Failed to fetch`.** Add the method to the whitelist before adding the route.
- **External APIs proxied**: Modrinth (mod search/install + SHA1 hash lookup), Hangar (Paper plugin search/install), Mojang/Paper/Fabric/Forge/NeoForge version lists (10-minute cache).
- **Java discovery**: `getJavaPath()` searches JAVA_HOME, PATH, Windows registry, common install roots, and the Minecraft launcher's bundled JRE. Returns `'java'` as a fallback (never null).
- **Java version check**: `GET /api/java-status?mcVersion=…` runs `java -version`, parses the major version, and returns `{ version: number|null, ok: boolean, required: number }`. Gates per-MC-version via `requiredJavaMajor(mcVersion)` (1.16→8, 1.17→16, 1.18–1.20.4→17, 1.20.5–1.21.5→21, 1.21.6+→25). The frontend calls this before opening the Create Server modal. MineDash also auto-manages a Java pool: when a server needs a Java major the system doesn't have, MineDash downloads the right JDK from Adoptium into a managed `runtimes/` folder and uses that for the server's spawns.

### Frontend (`frontend/src/`)

- **No router** — conditional rendering. `App.jsx` renders either `ServersList` (home) or `MainPanel` (server detail).
- **No global state** — `App.jsx` owns `servers[]` and `selectedServer`. Props are drilled down. No Redux or Context.
- **Socket connection**: Initialized once at module level in `App.jsx` (`const socket = io('http://localhost:3001')`). Passed as a prop to components that need real-time data.
- **All API calls**: Hardcoded to `http://localhost:3001`. This works in dev (direct) and in packaged Electron (`webSecurity: false` allows file:// → localhost requests).
- **Java gate**: `checkJavaThenCreate()` in `App.jsx` calls `/api/java-status` before opening `CreateServerModal`. If Java is missing/outdated it shows `JavaSetupModal` instead, which has a download link, step-by-step guide, recheck button, and a "I know what I'm doing" bypass.

**`MainPanel.jsx`** is the core UI. It owns the tab system. Tab visibility is conditional on `server.type`:
- `vanilla` → mods/plugins tab hidden entirely
- `paper` → "Plugins" tab → `PluginsViewer` (Hangar)
- `fabric` / `forge` / `neoforge` → "Mods" tab → `ModsViewer` + `ModrinthBrowser`

Tab order: `console`, `players`, `activity`, `mods` (conditional), `backups`, `schedule`, `network`, `options`.

The crash banner in `ConsoleViewer` communicates tab-switches to `MainPanel` via `window.dispatchEvent(new CustomEvent('minedash-switch-tab', { detail: { tab } }))`.

**`PlayersViewer.jsx`** lists currently-online players (polled from `/api/servers/:id/stats`) and exposes per-row hover actions — op, deop, teleport-to-spawn, kick, ban — that send the matching console command via `POST /api/servers/:id/command`. There is no editor for offline players (whitelist / banlist) here yet.

**`OptionsViewer.jsx`** owns the Options tab. `PropertiesSettings` loads the full `server.properties` file: header search bar, booleans rendered as toggles, known enums (`difficulty`, `gamemode`, `level-type`) as `CustomDropdown` (portal-rendered so it doesn't clip inside scroll containers), everything else as text inputs. A dirty-state bottom bar exposes Save and Save-and-restart.

**`ModsViewer.jsx`** has a sub-view toggle for `datapacks` that mounts `ModrinthBrowser` with `projectType="datapack"`. Datapacks land in the server's `world/datapacks/` folder rather than `mods/`.

### Electron (`electron/`)

- **`main.js`** — `frame: false` (no native title bar). Window size is calculated as 88% of `screen.getPrimaryDisplay().workAreaSize`, capped at 1400×900, minimum 800×560. Forks backend with `silent: true` and pipes its output to a log file. Exposes IPC handlers: `window-minimize`, `window-maximize`, `window-close`, `window-is-maximized`, `window-hide-to-tray`, `updater-quit-and-install`. Emits `window-maximized` to renderer on maximize/unmaximize events. Owns the system tray (created lazily on first `hide-to-tray`) and the auto-updater. The updater reads releases from the main public `proffesionalprogrammer/minedash` repo (configured via the `publish` block in root `package.json`; before v1.0.99 it was the `minedash-releases` mirror); on launch it checks for updates, downloads in the background, and emits `updater-update-downloaded` to the renderer so `UpdateToast` can prompt the user to relaunch. `autoInstallOnAppQuit` is `false` so an in-progress task (Minecraft launching, server starting) isn't killed by a silent install — the user has to click the toast.
- **`preload.js`** — exposes `window.electronAPI.isElectron`, `window.electronAPI.windowControls` (`minimize`, `maximize`, `close`, `hideToTray`, `isMaximized`, `onMaximizeChange`), and `window.electronAPI.updater` (`onUpdateAvailable`, `onDownloadProgress`, `onUpdateDownloaded`, `quitAndInstall`).
- **`TitleBar.jsx`** — custom 38px title bar rendered inside the React app. Uses `style={{ WebkitAppRegion: 'drag' }}` on the container and `WebkitAppRegion: 'no-drag'` on the buttons. Returns `null` when `window.electronAPI?.isElectron` is falsy (dev mode). Contains a pixel-art grass block SVG and minimize/maximize-restore/close buttons. Close button turns red on hover; others use a muted highlight.
- Build output lands in `electron/renderer/` (set in `frontend/vite.config.js` `build.outDir`). **`base: './'` in `vite.config.js` is critical** — without it, asset paths are absolute (`/assets/...`) and fail when loaded via `file://` in the packaged app.
- `electron-builder` config in root `package.json` packages `electron/` + `backend/` source into `app.asar` via the `files` mapping (the `backend → backend` filter excludes `bore/`, `playit/`, `instances/`, `backups/`, `servers.json`, `temp_uploads/`, `runtimes/`, `launcher-clients/`, etc.). Only `electron/renderer` is shipped as `extraResources`.
- **CRITICAL — backend runtime deps must live in the ROOT `package.json` `dependencies`, not (only) `backend/package.json`.** electron-builder collects production dependencies from the *root* `package.json` and bundles them into `app.asar`'s top-level `node_modules`; `backend/node_modules` is **not** packaged at all. The backend's `require()`s resolve by walking up from `app.asar/backend/` to `app.asar/node_modules`. So every module the backend requires (`express`, `socket.io`, `pngjs`, …) is duplicated in the root `package.json`. If you add a `require(...)` in `backend/` for a package that's only in `backend/package.json`, the dev server works but the **packaged app crashes on startup with `MODULE_NOT_FOUND`** and the window loads with no backend ("Failed to fetch" everywhere). This shipped as the v1.0.94 `pngjs` bug. After adding a backend dependency: `npm install <pkg>` at the **root** too, then rebuild.

### Server types and their directories

Each server lives in `instances/<id>/`. Paper servers additionally get a `plugins/` subdirectory. Vanilla servers have no mods or plugins tab. Mod/plugin metadata is stored in `.minedash-mods.json` / `.minedash-plugins.json` inside the mods or plugins folder.

### Launcher worker subprocess

The actual game-launch sequence (Microsoft token refresh, Fabric/Forge/NeoForge install, mclc asset downloads, JVM spawn, dep-crash retry) runs in a forked Node subprocess — `backend/launcher-worker.js` — not in the main backend process. The HTTP handler in `backend/launcher.js` (`POST /api/launcher/launch`) forks the worker, stashes it in `activeLaunches[launchId]`, and the worker streams events back via IPC which the parent rebroadcasts on the `launcher_${launchId}` socket channel. The whole launcher module (`backend/launcher.js`) is loaded a second time inside the worker with `init()` hooks overridden so its `_emit`/`_isCancelled`/`_trackChild` go through IPC instead of socket.io/`cancelledLaunches`.

Why: `minecraft-launcher-core` uses the legacy `request` library and exposes no abort API. Calling `.abort()` mid-download crashes the parent because mclc's pipe to `fs.createWriteStream` has no error listener. Killing the worker process is the only safe way to interrupt mclc — the OS reaps its HTTP connections cleanly. `DELETE /api/launcher/launch/:launchId` sends a polite `cancel` IPC message (the worker `taskkill /F /T`s any sub-children on Windows, then exits), then SIGKILLs the worker after 2.5s if it doesn't go quietly.

**Don't add new launch logic in `backend/launcher.js`'s parent-process route handlers.** Anything that runs during launch — pre-checks, post-launch hooks, mod sync — belongs inside `runLaunch()` so it executes in the worker and gets cancelled cleanly when the user clicks Stop.

### Launcher modpack install

`installModpackIntoProfile()` records the **full list of relative paths** it writes (mods + overrides) into the per-modpack manifest entry at `.minedash-modpacks.json → record[filename].files`. The DELETE handler at `/api/launcher/profiles/:loader/:version/content/modpack/:filename` reads that list, removes every tracked path (with `safeJoin` protection), walks up pruning empty directories, then clears the manifest entry. Without the file list there's no way to tell a modpack mod from a manually-installed one — preserve `files` if you change the install path, otherwise Delete becomes a no-op or has to nuke the whole profile.

### Dependency auto-installer

When a Fabric/Forge server crashes with a missing mod error, `hasDependencyCrash()` detects it and `parseMissingModIds()` extracts the mod IDs. The backend then searches Modrinth and installs them automatically before restarting. This runs in the `exit` handler of `startProcess` and is deliberately checked *before* the plain-English crash banner logic so the two systems don't conflict.

### Scheduled tasks engine

Per-server tasks live on the server config as `scheduledTasks: []` (each: `{ id, name, type: 'backup'|'restart'|'command', command?, schedule: { days[], hour, minute }, enabled }`). A single global ticker (`startScheduleEngine`) aligns to the top of every minute and checks every server's tasks. `taskLastFireKey` (`YYYY-M-D-H-M` per task ID) dedups within the same minute. When cloning a server, scheduled task IDs are regenerated so fire-tracking doesn't conflate the source and clone.

### Modpack import (`POST /api/servers/from-modpack`)

Accepts a `.mrpack` (multipart upload). Parses `modrinth.index.json`, auto-detects loader (Fabric/Forge/NeoForge via `dependencies` keys; Quilt is explicitly unsupported), downloads every server-relevant file (skips `env.server === 'unsupported'`), and extracts `overrides/` + `server-overrides/` on top. The downloader (`downloadFromAny`) streams to disk, sends a real User-Agent, follows redirects, and tries every URL in `f.downloads[]` before giving up. Path traversal is blocked via `safeJoin`. Failed downloads are returned per-file in the summary so the UI can show what didn't download.

### Server clone (`POST /api/servers/:id/clone`)

Copies `instances/<source>/` to `instances/<newId>/`, skipping `logs/`, `crash-reports/`, and `session.lock`. Refuses to clone a running server (JVM file locks would corrupt the copy). The clone resets `customUrl` and `pinnedBackups`, and re-generates IDs for `scheduledTasks`.

### Mod icon resolution

`GET /api/servers/:id/mods` lazily backfills missing icons by streaming each jar through SHA1 and querying Modrinth's `/v2/version_file/{sha1}?algorithm=sha1` endpoint. Results (including misses, marked `lookedUp: true`) are cached in `.minedash-mods.json` so subsequent loads are instant. This means mods installed via `.mrpack`, drag-drop, dependency auto-installer, or manual file copy all get icons — anything Modrinth knows about gets identified.

### Pinned backups

`servers.json` carries an optional `pinnedBackups: string[]` per server. Pinned files are skipped by the auto-cleanup retention pruner (in `createAutoBackup`) and surface at the top of the Backups list. Renames sync the pinned name in place.

## Branding kit

**Use these colors and tokens for every new UI element.** The product feels coherent only if everything obeys the kit.

### Color palette

| Role | Hex | Used for |
|------|-----|----------|
| Brand primary | `#00AF5C` | Buttons, active tabs, accents, charts, success states |
| Brand hover | `#00964F` | Hover state of primary buttons |
| Background base | `#111111` | Page background, deepest surface |
| Surface 1 | `#1A1A1A` | Header strips, modals, dropdown menus |
| Surface 2 | `#1E1E1E` | Cards, list rows |
| Border / muted bg | `#2D2D2D` | All borders, dividers, disabled-button backgrounds |
| Border hover | `#555555` (or `#3D3D3D` for soft) | Hover-state borders |
| Muted text / icons | `#555555` | Subdued labels, default icon color |
| Secondary text | `#A0A0A0` | Body text, descriptions |
| Primary text | `#FFFFFF` | Headlines, values |
| Destructive | `#FF5555` (hover `#FF4444`) | Delete, errors |
| Warning / restore | `amber-500` (`#F59E0B`) / `amber-400` | Backup restore, "are you sure" warnings, pinned chip |
| Modpacks accent | `violet-500` / `violet-400` | The modpacks tab only |

Use Tailwind arbitrary value syntax: `bg-[#1E1E1E]`, `border-[#2D2D2D]`, `text-[#A0A0A0]`. **Don't use Tailwind's named greens** — they don't match the brand.

Translucent overlays follow the pattern `bg-[#00AF5C]/10`, `border-[#00AF5C]/20`, etc. Soft hover/focus rings: `focus:ring-4 focus:ring-[#00AF5C]/10`.

### Typography

- Font family: system sans (no custom font is loaded).
- Weights: **`font-bold` everywhere** for headings, labels, button copy. Body text is `font-medium`. Tiny labels use `text-[10px] uppercase tracking-wider font-bold`.
- Numeric displays always use `tabular-nums`.
- Big values use `text-3xl font-bold` (stat cards) or `text-4xl font-black` (server header).

### Radii and spacing

- Buttons & inputs: `rounded-xl` (12 px) for small, `rounded-2xl` (16 px) for primary.
- Cards: `rounded-2xl`.
- Modals: `rounded-3xl`.
- Modal padding: `p-6` (small confirms) or `p-8` (full forms). Card padding: `p-4`–`p-5`.

### Motion

`framer-motion` is used everywhere. Defaults:
- Hover lift on cards: `whileHover={{ y: -2 }}` with `{ type: 'spring', stiffness: 400, damping: 30 }`.
- Button press: `whileTap={{ scale: 0.97 }}` paired with `whileHover={{ scale: 1.03 }}`.
- Modal in/out: `initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}` with `spring`, `duration: 0.4`, `bounce: 0.15`.
- Backdrop: `bg-[#000000]/80 backdrop-blur-sm`.
- Tab indicator uses `layoutId="activeTabIndicator"` so it animates between tabs.
- List rows fade in with staggered `delay: i * 0.03` (capped at 0.3).

### Icons

`lucide-react`. Always size in JSX (`size={16}`), never via CSS. Default icon color is `text-[#555555]` for ambient/decorative use, branded `text-[#00AF5C]` for active/positive context.

## UI patterns to follow

These are non-obvious gotchas worth knowing before writing new components:

- **Dropdowns inside `overflow-hidden` containers** (e.g. framer-motion's `height: 'auto'` animation) get clipped. The pattern (see `BackupsViewer.jsx`, `CreateServerModal.jsx`) is to track an `overflow` state on the animated container and flip it from `'hidden'` to `'visible'` in `onAnimationComplete`, back to `'hidden'` in `onAnimationStart`.
- **The RAM slider** is a single `<input type="range" class="ram-slider">` with a CSS variable for the fill: `style={{ '--fill': '${ramPercent}%' }}`. The fill is a `linear-gradient` on the input's own `background` (defined in `index.css`), so the green portion always aligns perfectly with the thumb. Don't put a separately-positioned fill div behind the slider — it will drift out of sync with the thumb at the edges.
- **Min/Max RAM**: only one slider is exposed to users; on save both `minRam` and `maxRam` are set to the same value. This is intentional (Xms == Xmx avoids JVM heap-resizing pauses).
- **Sparklines** (`Sparkline` in `MainPanel.jsx`) use viewBox + `preserveAspectRatio="none"` + `vectorEffect="non-scaling-stroke"` to be responsive without distorting the line width. Series are smoothed with a 9-sample centered moving average + Catmull-Rom-to-Bezier interpolation (tension 0.6) — never plot raw samples directly, they look jittery. When the whole series is zero, the line anchors to the bottom edge.
- **Stat cards** (`StatCard` in `MainPanel.jsx`) follow Modrinth's hosting layout: big value top-left, optional muted `secondary` (e.g. "/ 100%"), single-line `label` (with optional `detail` appended after `·`), icon top-right (plain gray, no colored chip), full-width sparkline at the bottom edge. Pass `history={undefined}` to omit the sparkline (used for the Players card).
- **Toast / error display**: errors propagate up via the `onError` prop passed from `App.jsx` (`showError`). Don't render error UI locally inside leaf components — use the prop.
- **Confirm modals** all follow the same shape: `absolute inset-0 bg-[#000000]/80 backdrop-blur-sm` overlay → `bg-[#1A1A1A] border border-[#2D2D2D] rounded-3xl` card → header (icon in a `bg-<color>/10 rounded-xl` chip, then title) → body copy → `border-t pt-4` action row with `Cancel` then primary action.
- **Title bar drag region**: any new element added to `TitleBar.jsx` that should be clickable must have `style={{ WebkitAppRegion: 'no-drag' }}` — the parent sets the whole bar as draggable.
- **Number inputs**: don't use the OS-default spinner arrows — they render in light grey and clash with the dark UI. The `.branded-number` CSS class in `index.css` hides them; pair it with stacked `ChevronUp`/`ChevronDown` buttons positioned `absolute right-1 top-1 bottom-1` in a vertical flex (see the `NumberInput` component in `SettingsMenu.jsx` for the canonical pattern).

## What NOT to add

- **Don't add new fonts.** System sans is the look.
- **Don't introduce a global state library.** Prop drilling + socket events is the convention.
- **Don't use Tailwind's named color shades** (`bg-green-500`, `border-gray-700`). Use the brand hex values listed above.
- **Don't run backend tests** — there aren't any. Frontend lint (`cd frontend && npm run lint`) is opt-in; only run it for non-trivial frontend changes.
- **Don't add a tunnel / external-access feature using downloaded binaries** — bore and playit were removed because Windows Defender flags runtime binary downloads. Any networking feature must ship its binary inside the installer or use a pure-JS approach.
- **Don't change the release-publish target without updating both ends.** The `publish` block in root `package.json` points electron-builder at the main `proffesionalprogrammer/minedash` repo. The auto-updater reads from the same place via the generated `app-update.yml`. If you point publishing somewhere else, already-installed apps will silently keep looking at the old location until the next full reinstall — that's why the CI workflow still mirrors releases to the legacy `minedash-releases` repo for pre-v1.0.99 installs.
