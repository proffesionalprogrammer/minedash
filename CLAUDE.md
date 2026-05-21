# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is MineDash

A local Minecraft server management desktop app. Users run it on their own PC — MineDash manages the Java processes, mods, backups, networking, and scheduled tasks. It is **not** a hosted service; every user's Minecraft server runs on their own hardware.

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

All logic lives here. Key patterns:

- **In-memory state**: `activeProcesses` (running MC server child processes), `activeLogs` (console output buffers), `serverStates` (uptime/players), `serverJavaPids` (actual JVM PIDs discovered via process-tree walk), `autoBackupIntervals`, `taskLastFireKey` (scheduled-task per-minute dedup).
- **Persistent state**: `servers.json` — array of server config objects. Read/written via `getServers()` / `saveServers()`. Socket event `server_updated` is emitted after every save.
- **Data directory**: Controlled by `DATA_DIR = process.env.MINEDASH_DATA_DIR || __dirname`. In packaged Electron, `MINEDASH_DATA_DIR` is set to `app.getPath('userData')` (`AppData\Roaming\MineDash`). In dev it defaults to the `backend/` folder itself.
- **Server lifecycle**: `startProcess(id, serverConfig, serverPath)` — spawns the MC Java process, wires up stdout/stderr to `appendLog()`, handles the exit event (dependency crash detection → auto-restart → backup interval cleanup → crash banner emission).
- **Socket events**: All namespaced by server ID — `console_${id}`, `server_memory_${id}`, `crash_detected_${id}`, `players_update_${id}`. Global events: `system_stats`, `server_created`, `server_deleted`, `server_status_change`, `server_updated`.
- **CORS**: configured at the top of the file with an explicit `methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']` whitelist. **If you add a route using a method not in this list, the browser will reject it with `TypeError: Failed to fetch`.** Add the method to the whitelist before adding the route.
- **External APIs proxied**: Modrinth (mod search/install + SHA1 hash lookup), Hangar (Paper plugin search/install), Mojang/Paper/Fabric/Forge/NeoForge version lists (10-minute cache).
- **Java discovery**: `getJavaPath()` searches JAVA_HOME, PATH, Windows registry, common install roots, and the Minecraft launcher's bundled JRE. Returns `'java'` as a fallback (never null).
- **Java version check**: `GET /api/java-status` runs `java -version`, parses the major version, and returns `{ version: number|null, ok: boolean }`. Currently requires Java 25+. The frontend calls this before opening the Create Server modal.

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

### Electron (`electron/`)

- **`main.js`** — `frame: false` (no native title bar). Window size is calculated as 88% of `screen.getPrimaryDisplay().workAreaSize`, capped at 1400×900, minimum 800×560. Forks backend with `silent: true` and pipes its output to a log file. Exposes IPC handlers: `window-minimize`, `window-maximize`, `window-close`, `window-is-maximized`. Emits `window-maximized` to renderer on maximize/unmaximize events. Auto-updater is intentionally disabled until a GitHub release channel is configured.
- **`preload.js`** — exposes `window.electronAPI.isElectron` and `window.electronAPI.windowControls` (`minimize`, `maximize`, `close`, `isMaximized`, `onMaximizeChange`).
- **`TitleBar.jsx`** — custom 38px title bar rendered inside the React app. Uses `style={{ WebkitAppRegion: 'drag' }}` on the container and `WebkitAppRegion: 'no-drag'` on the buttons. Returns `null` when `window.electronAPI?.isElectron` is falsy (dev mode). Contains a pixel-art grass block SVG and minimize/maximize-restore/close buttons. Close button turns red on hover; others use a muted highlight.
- Build output lands in `electron/renderer/` (set in `frontend/vite.config.js` `build.outDir`). **`base: './'` in `vite.config.js` is critical** — without it, asset paths are absolute (`/assets/...`) and fail when loaded via `file://` in the packaged app.
- `electron-builder` config in root `package.json` packages `electron/` + `backend/` (including its `node_modules`) as `extraResources`. The filter explicitly excludes `bore/`, `playit/`, `instances/`, `backups/`, `servers.json`, and `temp_uploads/` from the bundle.

### Server types and their directories

Each server lives in `instances/<id>/`. Paper servers additionally get a `plugins/` subdirectory. Vanilla servers have no mods or plugins tab. Mod/plugin metadata is stored in `.minedash-mods.json` / `.minedash-plugins.json` inside the mods or plugins folder.

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

## What NOT to add

- **Don't add new fonts.** System sans is the look.
- **Don't introduce a global state library.** Prop drilling + socket events is the convention.
- **Don't use Tailwind's named color shades** (`bg-green-500`, `border-gray-700`). Use the brand hex values listed above.
- **Don't run backend tests** — there aren't any. Frontend lint (`cd frontend && npm run lint`) is opt-in; only run it for non-trivial frontend changes.
- **Don't add a tunnel / external-access feature using downloaded binaries** — bore and playit were removed because Windows Defender flags runtime binary downloads. Any networking feature must ship its binary inside the installer or use a pure-JS approach.
- **Don't re-enable `electron-updater`** until a GitHub release pipeline exists. The auto-updater is currently a no-op stub in `setupAutoUpdater()`.
