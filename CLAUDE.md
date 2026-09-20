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

**Releasing a new version:** append a `## vX.Y.Z — YYYY-MM-DD` section to `CHANGELOG.md`, commit, then `git tag vX.Y.Z && git push origin vX.Y.Z`. **The pushed tag is the only release trigger** — pushing the version-bump commit to main does nothing on its own (v1.0.99 sat unreleased for a day because the tag was never pushed). The `.github/workflows/build.yml` workflow fires on `v*` tags and is confirmed working end-to-end (first main-repo release v1.0.99, 2026-06-12): it syncs `package.json` `version` from the tag (so the tag is the source of truth — bumping `package.json` in the commit is good hygiene but not required), builds, publishes the release on the main `proffesionalprogrammer/minedash` repo with notes extracted from the matching `CHANGELOG.md` section, and flips it from draft to published (the auto-updater ignores drafts). It also mirrors the release to the legacy `proffesionalprogrammer/minedash-releases` repo so installs older than v1.0.99 — whose `app-update.yml` still points there — can pick up the switchover. The user has decided (June 2026) to keep the legacy repo for now; if it's ever deleted, remove the mirror step from `build.yml` first or every subsequent release run will fail. Manual fallback if CI doesn't fire: `GH_TOKEN="$(gh auth token)" npm run build:release` locally, then `gh release edit vX.Y.Z --repo proffesionalprogrammer/minedash --draft=false --notes-file <(...)`.

There are no tests and no backend lint. Frontend has ESLint: `cd frontend && npm run lint`.

## Working in parallel (multiple chats / worktrees)

Multiple Claude sessions run against this repo, each in its own git worktree on a `claude/<name>` branch. **All worktrees of the same clone share one `.git`**, so every chat can already see every other chat's *committed* work — it just has to look:

- `git worktree list` — every active worktree and the branch it's parked on.
- `git log --all --oneline -20` — every commit on every branch, no matter which worktree made it.
- `git branch -av` — branch tips and how far ahead/behind `main` each is.

Two rules keep chats in sync:

1. **`main` is the bulletin board — integrate through it.** At the start of a task (and periodically) run `git fetch && git merge origin/main` so you pick up everyone else's shipped work; when you finish, merge your branch back to `main`. A branch shown as `[behind N]` hasn't done this and is building on a stale base.
2. **Log intent in the shared session journal** — `C:\Users\harish\.claude\projects\X--minedash-testing-hosting-server-v4\SESSION-JOURNAL.md`. It lives *outside* every worktree (uncommitted, in-progress work never crosses worktree boundaries via git), so it's the one place to see what other chats are *currently* doing. **Read it when you start a task; append a one-line dated entry when you pick up or finish one** (branch · files touched · status).

Housekeeping: stale/`prunable` worktrees from old repo locations accumulate — `git worktree prune` clears them, and merged `claude/*` branches can be deleted.

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
- **Java auto-management (no gate)**: There is **no Java pre-check modal** — server creation never walls the user off behind a Java install step. Instead the JDK is resolved and auto-downloaded lazily at start time. `POST /api/servers/:id/start` calls `resolveJavaForServer()` (managed pool first, then exact-major system Java); if no match exists it streams an Adoptium download into the managed `runtimes/` folder via `ensureManagedJavaSingleFlight()`, logging progress to the server console, then spawns on that JDK. The required major per MC version comes from `requiredJavaMajor(mcVersion)` (1.16→8, 1.17→16, 1.18–1.20.4→17, 1.20.5–1.21.5→21, 1.21.6+→25). `allowMismatch=true` forces a start on whatever system Java is present (used only after an auto-install failure). The pool lives in `backend/java-pool.js` (extracted from index.js) so the **launcher** shares it: `resolveLauncherJava()` in `backend/launcher.js` picks the Java for every game launch (per-instance `java` field — `'auto'` | `'jdk-<major>'` | absolute path; auto reads the exact required major from Mojang's version JSON, falls back to the heuristic table offline, and downloads from Adoptium when missing, streaming progress over the `launcher_${launchId}` channel). The pool module must be `init()`-ed with the runtimes dir — index.js does it at boot, and launcher.js does it again inside its own `init()` so the forked launch worker (which never loads index.js) gets it too.

### Frontend (`frontend/src/`)

- **No router** — conditional rendering. `App.jsx` renders either `ServersList` (home) or `MainPanel` (server detail).
- **No global state** — `App.jsx` owns `servers[]` and `selectedServer`. Props are drilled down. No Redux or Context.
- **Socket connection**: Initialized once at module level in `App.jsx` (`const socket = io('http://localhost:3001')`). Passed as a prop to components that need real-time data.
- **All API calls**: Hardcoded to `http://localhost:3001`. This works in dev (direct) and in packaged Electron (`webSecurity: false` allows file:// → localhost requests).
- **No Java gate**: server creation does **not** pre-check Java. The required JDK is auto-downloaded on first start (see the start route above), so there's no install-Java modal blocking the Create flow.

**`MainPanel.jsx`** is the core UI. It owns the tab system. Tab visibility is conditional on `server.type`:
- `vanilla` → mods/plugins tab hidden entirely
- `paper` → "Plugins" tab → `PluginsViewer` (Hangar)
- `fabric` / `forge` / `neoforge` → "Mods" tab → `ModsViewer` + `ModrinthBrowser`

Tab order: `console`, `players`, `activity`, `mods` (conditional), `map` (non-vanilla), `worlds`, `backups`, `files`, `schedule`, `network`, `options`. `worlds` and `files` are purely local, so they stay visible offline on every server type.

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

Each server lives in `instances/<id>/`. Paper servers additionally get a `plugins/` subdirectory. Vanilla servers have no mods or plugins tab. Mod/plugin metadata is stored in `.mod-metadata.json` (the `MOD_META_FILE` constant) / `.minedash-plugins.json` inside the mods or plugins folder.

### Launcher worker subprocess

The actual game-launch sequence (Microsoft token refresh, Fabric/Forge/NeoForge install, mclc asset downloads, JVM spawn, dep-crash retry) runs in a forked Node subprocess — `backend/launcher-worker.js` — not in the main backend process. The HTTP handler in `backend/launcher.js` (`POST /api/launcher/launch`) forks the worker, stashes it in `activeLaunches[launchId]`, and the worker streams events back via IPC which the parent rebroadcasts on the `launcher_${launchId}` socket channel. The whole launcher module (`backend/launcher.js`) is loaded a second time inside the worker with `init()` hooks overridden so its `_emit`/`_isCancelled`/`_trackChild` go through IPC instead of socket.io/`cancelledLaunches`.

Why: `minecraft-launcher-core` uses the legacy `request` library and exposes no abort API. Calling `.abort()` mid-download crashes the parent because mclc's pipe to `fs.createWriteStream` has no error listener. Killing the worker process is the only safe way to interrupt mclc — the OS reaps its HTTP connections cleanly. `DELETE /api/launcher/launch/:launchId` sends a polite `cancel` IPC message (the worker `taskkill /F /T`s any sub-children on Windows, then exits), then SIGKILLs the worker after 2.5s if it doesn't go quietly.

**Don't add new launch logic in `backend/launcher.js`'s parent-process route handlers.** Anything that runs during launch — pre-checks, post-launch hooks, mod sync — belongs inside `runLaunch()` so it executes in the worker and gets cancelled cleanly when the user clicks Stop.

### Launcher modpack install

`installModpackIntoProfile()` records the **full list of relative paths** it writes (mods + overrides) into the per-modpack manifest entry at `.minedash-modpacks.json → record[filename].files`. The DELETE handler at `/api/launcher/profiles/:loader/:version/content/modpack/:filename` reads that list, removes every tracked path (with `safeJoin` protection), walks up pruning empty directories, then clears the manifest entry. Without the file list there's no way to tell a modpack mod from a manually-installed one — preserve `files` if you change the install path, otherwise Delete becomes a no-op or has to nuke the whole profile.

### Client-only mods vs. required dependencies (`backend/mod-deps.js`)

**Invariant: nothing may remove a mod that another installed mod declares as a mandatory dependency.** Forge/NeoForge and Fabric validate mandatory deps on a *dedicated server*, so stripping one turns "a client mod is in my mods folder" into "the server won't boot at all". Modrinth's `server_side: unsupported` means "has no server-side function", **not** "must not be installed" — Athena (`athena-ctm`), Fusion (`fusion-connected-textures`) and Simply Tooltips are all flagged that way and all hard deps of the server mods that ship beside them. Removing them is what broke Slimes Adventure servers (v1.3.2 fix).

`backend/mod-deps.js` reads what each jar declares — `fabric.mod.json`, `quilt.mod.json`, `META-INF/[neoforge.]mods.toml` (a hand-rolled mini-TOML reader; real files write `[[mods]] #mandatory`, so comments are stripped outside quotes), plus jar-in-jar (`META-INF/jarjar/*.jar`, depth 1) for bundled mods that satisfy a dep with no file of their own. It exports `scanModsDir`, `protectedModFiles`, `missingModIds`, `readJarModInfo`, cached on jar mtime+size.

**Always pass the loader.** A "universal" jar ships metadata for every loader at once and only the running loader's dependencies apply — without the loader argument, Moog's Structures appears to require `quilt_resource_loader` on a Fabric server. `index.js` passes `serverConfig.type` / `cfg.type` everywhere.

Four places strip mods, and all four consult it (`protectedModFilesSafe`, which fails *safe* — an unreadable folder protects everything):

1. `startProcess`'s pre-spawn pass — also gated on the `removeClientMods` setting (it used to ignore it, which is why the toggle looked broken), and skips jars whose metadata carries `userForced: true` (the user clicked through the client-only warning in `install-modrinth`).
2. `computeModIssues` → the Mods tab. Sets `requiredByOther`, which suppresses `clientOnly` and renders a green **Required** badge.
3. `POST /mods/clean-client-only` — returns `kept[]` alongside `moved[]`.
4. Both modpack importers (`installModpackAsServer`, `runServerModpackInstall`).

`restoreRequiredStashedMods(serverPath, loader)` is the repair half: it pulls jars back out of `.minedash-client-mods/` when the installed mods require them, looping until the missing set stops shrinking. It runs **before every server start** (so packs installed by older builds self-heal) and after both modpack installs. It is deliberately **synchronous** — `startProcess` must not yield before spawning, which is also why `launcher.readSettingsSync()` exists.

### Dependency auto-installer

When a Fabric/Forge server crashes with a missing mod error, `hasDependencyCrash()` detects it and `parseMissingModIds()` extracts the mod IDs. The backend then searches Modrinth and installs them automatically before restarting. This runs in the `exit` handler of `startProcess` and is deliberately checked *before* the plain-English crash banner logic so the two systems don't conflict.

**A mod ID is not a Modrinth slug**, and `findAndInstallMissingDeps` must not assume it is. `/project/athena` is a Paper *plugin*; `/project/fusion` is an unrelated mod; `simplytooltips` 404s and Modrinth's search can't match the run-together form. So: a slug hit is only trusted when `projectMatchesTarget()` confirms project type + loader + game version; `modIdQueryVariants()` generates search forms (including a dictionary word-split — `simplytooltips` → `simply tooltips`); `findModrinthCandidates()` ranks them; and each candidate's downloaded jar is verified with `readJarModInfo()` to actually declare the missing ID — deleted and skipped if not. Don't "simplify" this back to a bare slug fetch.

### Server worlds (`backend/server-worlds.js`)

A dedicated server keeps its saves as **top-level folders inside `instances/<id>/`** (not in a `saves/` folder like a client), and `level-name` in `server.properties` decides which one loads. So "switch world" is a pointer move, not a copy — every world stays on disk until it's explicitly deleted, and `POST /worlds/:name/activate` just rewrites that one property line.

The module exists as its own file rather than more routes in `index.js` because of the **dimension-layout problem**, which is the thing that makes custom maps painful on a server:

```
vanilla / fabric / forge / neoforge   world/region, world/DIM-1/region, world/DIM1/region
Bukkit family (paper)                 world/region, world_nether/DIM-1/region, world_the_end/DIM1/region
```

Almost every downloadable map ships the **vanilla** layout. Drop one into a Paper server untouched and the overworld loads while the Nether and End silently regenerate — the classic "my custom map lost its nether" bug. `applyLayout()` converts in **both directions** on import and on activate, so a map works on whatever server you put it on. `level.dat` is copied into each split folder because Bukkit expects one per world folder.

Consequences to preserve if you touch this:

- **`listWorlds()` filters out dimension siblings.** `<name>_nether` / `<name>_the_end` hold a `level.dat` too, so they'd otherwise list as separate worlds. They're dropped only when a real world named `<name>` exists — a standalone folder that merely ends in `_nether` still lists.
- **Every mutation moves the whole set.** `worldParts()` returns the world plus its siblings; rename/duplicate/delete/export all iterate it, and rename follows `level-name` if it renamed the active world.
- **Mutations refuse while the server runs** (`requireStopped`) — the JVM holds these files open, and on Windows the move just fails.
- **Deleting the active world is refused.** Switch first; otherwise the server boots and silently generates a fresh world under the same name.
- Zip extraction walks entries by hand with a zip-slip guard rather than using `extractAllTo`.

### Server file manager (`backend/server-files.js`)

Browse/edit/upload/download anything under `instances/<id>/`. Every other panel is a curated view of specific files; this is the escape hatch for the long tail (`ops.json`, a mod's `config/` TOML, a plugin's own yml).

- **Paths travel as `?path=` query strings, deliberately.** A file path contains slashes, which Express would split across params — and `index.js`'s global `app.param` guard rejects any `:filename` holding a separator. `resolvePath()` is the single place traversal is checked; `withPath()` turns a rejection into a 400.
- **The editor is extension-gated** (`TEXT_EXTENSIONS`) and capped at `MAX_EDIT_BYTES` (2 MB). Bigger or unknown files are download-only — the editor POSTs the whole buffer back on save.
- **Saves are write-temp-then-rename**, so an interrupted write can't leave a half-truncated `server.properties` (= a server that won't boot).
- The route-level `express.json({ limit: '8mb' })` matters: the global `express.json()` is at the 100 KB default, which a chunky Create/GregTech config blows straight past.
- MineDash's own bookkeeping files are hidden from listings (`HIDDEN_ENTRIES`). `.minedash-client-mods/` is deliberately **not** hidden — it's useful to see what got stashed.

### Mod updates for servers

`POST /api/servers/:id/mods/check-updates` + `POST /api/servers/:id/mods/update` — the server-side equivalent of the launcher's `content/check-updates` / `update-mods` pair, which servers had been missing (they only had `repair-versions`, which fixes jars that are outright *wrong* for the loader/MC version but leaves a correct-but-stale mod alone).

Matching is done by Modrinth's `/version_files/update` endpoint: every jar's SHA1 plus the loader and game version, answered with the newest compatible version per project. Jars Modrinth doesn't recognise (CurseForge-only, hand-built) are simply absent — there's no basis to offer an update for them. Disabled jars are included and keep their `.disabled` suffix through the swap. The update route **refuses while the server is running** and writes the new jar *before* removing the old one, so an interrupted update leaves two copies (loud) rather than none (a server silently missing a mod others require).

### Scheduled tasks engine

Per-server tasks live on the server config as `scheduledTasks: []` (each: `{ id, name, type: 'backup'|'restart'|'command', command?, schedule: { days[], hour, minute }, enabled }`). A single global ticker (`startScheduleEngine`) aligns to the top of every minute and checks every server's tasks. `taskLastFireKey` (`YYYY-M-D-H-M` per task ID) dedups within the same minute. When cloning a server, scheduled task IDs are regenerated so fire-tracking doesn't conflate the source and clone.

### Modpack import (`POST /api/servers/from-modpack`)

Accepts a `.mrpack` (multipart upload). Parses `modrinth.index.json`, auto-detects loader (Fabric/Forge/NeoForge via `dependencies` keys; Quilt is explicitly unsupported), downloads every server-relevant file (`env.server === 'unsupported'` goes to the client stash rather than being dropped, so the dependency reconciliation above can pull it back), and extracts `overrides/` + `server-overrides/` on top. The downloader (`downloadFromAny`) streams to disk, sends a real User-Agent, follows redirects, and tries every URL in `f.downloads[]` before giving up. Path traversal is blocked via `safeJoin`. Failed downloads are returned per-file in the summary so the UI can show what didn't download.

### Server clone (`POST /api/servers/:id/clone`)

Copies `instances/<source>/` to `instances/<newId>/`, skipping `logs/`, `crash-reports/`, and `session.lock`. Refuses to clone a running server (JVM file locks would corrupt the copy). The clone resets `customUrl` and `pinnedBackups`, and re-generates IDs for `scheduledTasks`.

### Mod icon resolution

`GET /api/servers/:id/mods` lazily backfills missing icons by streaming each jar through SHA1 and querying Modrinth's `/v2/version_file/{sha1}?algorithm=sha1` endpoint. Results (including misses, marked `lookedUp: true`) are cached in `.mod-metadata.json` so subsequent loads are instant. This means mods installed via `.mrpack`, drag-drop, dependency auto-installer, or manual file copy all get icons — anything Modrinth knows about gets identified.

### Offline mode

`backend/connectivity.js` decides whether this machine can actually reach the hosts MineDash proxies (DNS probe of Modrinth/Hangar/Mojang — cheapest signal that exercises the network; one host answering is enough). It probes every 60s while online, every 10s while offline, dedups concurrent probes through a single in-flight promise, and emits the global socket event `network_status { online, checkedAt }` on every change. `GET /api/connectivity[?recheck=1]` is the initial read. Proxy routes call `noteUpstreamSuccess()` / `noteUpstreamFailure(err)` so an outage is caught on the first failed request instead of up to a probe interval later; `noteUpstreamFailure` only reacts to network-level error codes — a 404 from a reachable host is not "offline".

The renderer reads it through `frontend/src/hooks/useOnline.js`, which merges the backend verdict with the browser's `online`/`offline` events. **`navigator.onLine` alone is not enough** — an interface with no route to the internet still reports "online", which is exactly the case that filled every browse panel with "Failed to fetch".

**Convention for new UI: anything that is purely a front-end for an external API must hide itself when offline**, rather than rendering an error. `ONLINE_ONLY_TABS` in `App.jsx` covers top-level views (currently `browse`); `MainPanel` drops a Paper server's Hangar-only Plugins tab; `ModsViewer` drops its Browse/Modpacks/Data Packs sub-tabs but keeps the Installed list (local files work offline). Gate by **deriving** the effective view (`const view = !online && ONLINE_ONLY_TABS.has(selectedView) ? 'play' : selectedView`) rather than correcting state in an effect — the repo's ESLint flags `set-state-in-effect`.

### Changelog / release notes

`CHANGELOG.md` is copied into the bundle by the frontend's `dev`/`build` scripts, so both views fetch it from the app's own origin. Parsing lives in `frontend/src/lib/changelog.js` (`fetchChangelog`, `extractSection`, `parseChangelog`) and rendering in `ChangelogMarkdown.jsx` — a deliberately tiny markdown subset (`###`, `- `, `**bold**`) matching what the changelog actually uses; don't pull in react-markdown for it. Two consumers: `WhatsNewModal` (one version, auto-shown once after an update, needs `electronAPI.getAppVersion`) and `ChangelogHistoryModal` (every version, opened from **Settings → Updates → All release notes** via the `minedash-show-all-changelogs` window event; works in dev too since it only needs the file).

### Pinned backups

`servers.json` carries an optional `pinnedBackups: string[]` per server. Pinned files are skipped by the auto-cleanup retention pruner (in `createAutoBackup`) and surface at the top of the Backups list. Renames sync the pinned name in place.

## Branding kit

**Use these colors and tokens for every new UI element.** The product feels coherent only if everything obeys the kit.

### Color palette

> **The app is theme-aware (Light / Dark / OLED).** Neutrals are CSS-variable
> **tokens** defined in `frontend/src/index.css` (`:root` = dark, equal to the
> original hexes, so dark is unchanged; `[data-theme="light"]`/`["oled"]`
> override). The theme is set on `<html data-theme>` from `App.jsx` +
> `main.jsx`, persisted via `theme` in the launcher settings, and picked in
> **Settings → Appearance**. **For neutrals, use the token, not the raw hex** —
> raw hexes don't flip and will stay dark in Light/OLED mode. Brand accents
> (green, amber, violet, loader colours) stay literal — they're theme-invariant.

| Role | Token (use this) | Dark hex | Used for |
|------|------|-----|----------|
| Brand primary | `#00AF5C` (literal) | `#00AF5C` | Buttons, active tabs, accents, charts, success states |
| Brand hover | `#00964F` (literal) | `#00964F` | Hover state of primary buttons |
| Background base | `var(--c-base)` | `#111111` | Page background, deepest surface |
| Surface 1 | `var(--c-surface-1)` | `#1A1A1A` | Header strips, modals, dropdown menus |
| Surface 2 | `var(--c-surface-2)` | `#1E1E1E` | Cards, list rows |
| Border / muted bg | `var(--c-border)` | `#2D2D2D` | All borders, dividers, disabled-button backgrounds |
| Border hover | `var(--c-text-muted)` (or `var(--c-border-soft)`) | `#555555` / `#3D3D3D` | Hover-state borders |
| Muted text / icons | `var(--c-text-muted)` | `#555555` | Subdued labels, default icon color |
| Secondary text | `var(--c-text-secondary)` | `#A0A0A0` | Body text, descriptions |
| Primary text | `var(--c-text-primary)` | `#FFFFFF` | Headlines, values |
| Destructive | `var(--c-danger)` (hover `var(--c-danger-hover)`) | `#FF5555` / `#FF4444` | Delete, errors |
| Warning / restore | `amber-500` (`#F59E0B`) / `amber-400` | — | Backup restore, "are you sure" warnings, pinned chip |
| Modpacks accent | `violet-500` / `violet-400` | — | The modpacks tab only |

Use Tailwind arbitrary value syntax with the token: `bg-[var(--c-surface-2)]`, `border-[var(--c-border)]`, `text-[var(--c-text-secondary)]`. Opacity modifiers work (`bg-[var(--c-surface-1)]/80` — Tailwind v4 emits `color-mix`). **White text on a coloured surface uses the `text-white` keyword** (not `text-[var(--c-text-primary)]`, which flips dark in Light mode). **Don't use Tailwind's named greys/greens** — they don't match the brand and don't theme.

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

- **Don't add a mod-removal path that skips `mod-deps.js`.** Any new code that moves, deletes or hides a jar in a server's `mods/` must check `protectedModFilesSafe()` first — see the invariant above. This has broken users' servers once already.
- **Don't add new fonts.** System sans is the look.
- **Don't introduce a global state library.** Prop drilling + socket events is the convention.
- **Don't use Tailwind's named color shades** (`bg-green-500`, `border-gray-700`). Use the brand hex values listed above.
- **Don't run backend tests** — there aren't any. Frontend lint (`cd frontend && npm run lint`) is opt-in; only run it for non-trivial frontend changes.
- **Don't add a tunnel / external-access feature using downloaded binaries** — bore and playit were removed because Windows Defender flags runtime binary downloads. Any networking feature must ship its binary inside the installer or use a pure-JS approach.
- **Don't change the release-publish target without updating both ends.** The `publish` block in root `package.json` points electron-builder at the main `proffesionalprogrammer/minedash` repo. The auto-updater reads from the same place via the generated `app-update.yml`. If you point publishing somewhere else, already-installed apps will silently keep looking at the old location until the next full reinstall — that's why the CI workflow still mirrors releases to the legacy `minedash-releases` repo for pre-v1.0.99 installs.
