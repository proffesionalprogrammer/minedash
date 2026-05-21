# Changelog

All notable changes to MineDash are listed here. The version-specific section for whichever release you're running is shown in the "What's new" popup the first time MineDash starts after an update.

## v1.0.2 — 2026-05-21

### Added

- **"What's new" popup.** MineDash now shows a one-time recap of every change the first time it launches on a new version. Dismiss it once and it won't come back for that version.
- **Version label in Settings.** Open the gear menu — your current MineDash version is listed at the bottom so you can tell at a glance what you're running.
- **Auto-update polls every minute while the window is focused.** Previously the app only checked for updates at launch; now it picks up new releases within ~1 minute of them going live. Polling pauses while MineDash is minimized or tray-hidden so we're not pinging the network for nothing.

### Fixed

- **Modpack server import no longer drags in client-only mods.** Previously, importing a `.mrpack` could install rendering-only mods like Oculus, Iris, Sodium, Rubidium, and friends into the server's `mods/` folder — which crashes a dedicated server the moment it starts. The importer now applies a stricter env-flag check plus a deny-list of well-known client-only mod filename patterns, so these get skipped whether they came from `files[]` or from `overrides/mods/`.

---

## v1.0.1 — 2026-05-21

### Added

- Startup log line `[Electron] MineDash X.Y.Z starting` so the auto-update flow is debuggable from the log file alone.

---

## v1.0.0 — 2026-05-21

Initial public release.

### Highlights

- **Local Minecraft server management.** Run vanilla, Paper, Fabric, Forge, and NeoForge servers on your own PC with one-click start/stop, RAM control, and live console.
- **Built-in Minecraft launcher.** Sign in with Microsoft or use an offline name, pick a loader and version, and launch — assets, libraries, and the loader installer are all handled automatically.
- **Modrinth + Hangar browsers** for mods (Fabric/Forge/NeoForge) and plugins (Paper) directly inside MineDash.
- **`.mrpack` modpack import.** Upload a Modrinth modpack and MineDash builds the server, downloads all mods, and extracts overrides.
- **Scheduled tasks.** Per-server backup / restart / command schedules with weekday + time selectors.
- **Backups with pinning.** Auto-prune keeps the last N backups; pinned backups survive cleanup.
- **Crash banners with auto-recovery.** If a server crashes due to a missing dependency, MineDash searches Modrinth and reinstalls the mod automatically.
- **Auto-updater.** New releases are downloaded in the background; a toast asks you to relaunch when ready. Source code is private; release artifacts are mirrored to the public [`minedash-releases`](https://github.com/proffesionalprogrammer/minedash-releases) repo.
