# Changelog

All notable changes to MineDash are listed here. The version-specific section for whichever release you're running is shown in the "What's new" popup the first time MineDash starts after an update.

## v1.0.4 — 2026-05-22

### Added

- **Per-Minecraft-version Java check.** MineDash now matches the Java version it needs to the MC version you're running — 1.16 wants Java 8, 1.17 wants 16, 1.18–1.20.4 wants 17, 1.20.5–1.21.5 wants 21, 1.21.6+ wants 25. The check runs after you pick a version (not before opening the Create modal), and when you start a server with the wrong Java the same setup modal pops up with the right download link and copy for that specific MC version instead of always nagging about Java 25.
- **Whitelist, Ops, and Banlist editor.** The Players tab now has a Lists sub-view with tabs for Whitelist, Operators, Banned, and Banned IPs. Add and remove inline. While the server is offline MineDash writes the JSON files directly; while it's running it sends the matching console command so the server stays the source of truth. Offline-mode names resolve via Mojang first and fall back to offline UUIDs, so cracked usernames work too.
- **Console search, level filter, and jump-to-match.** The console header gained a search box (Enter / Shift+Enter to step through matches, Esc to clear), a regex toggle, INFO / WARN / ERROR chips for level filtering, and a match counter with prev/next controls. Auto-scroll pauses while a search is active so you can actually read the line you found.
- **Differential updates.** Future MineDash updates download only the changed blocks of the installer (~5–10 MB) instead of the full ~80 MB exe every time. No change on your end — this kicks in starting with the v1.0.4 → next-version hop.

---

## v1.0.3 — 2026-05-22

### Added

- **"What's new in this version" button in Settings.** Re-opens the changelog popup on demand. If you upgraded to v1.0.2 and never saw the popup (it shipped *in* v1.0.2, so the first run silent-skipped as a "fresh install"), open Settings and click it to read the notes you missed.
- **Modpack import now stashes client-only mods instead of dropping them.** Mods filtered out of the server during `.mrpack` import are saved to a per-server `.minedash-client-mods/` folder. When you hit Play on that server, the launcher pushes those jars into your client profile alongside the server's mods so your client ends up with the full modpack. `client-overrides/mods/` from the mrpack is also picked up.
- **Auto self-heal at server start.** Every server start scans `mods/` for jars matching the client-only deny-list and moves them out before the JVM launches. Servers imported before v1.0.3, or jars dragged in by hand, heal themselves on the next start. The console viewer logs which jars were moved.

### Fixed

- **Client-only deny-list now catches mods with bracketed prefixes.** Pack authors often ship jars named `[Embeddium] sodiumextras-…jar` or `[钠／Embeddium：附属] sodiumextras-…jar`. The filename matcher now strips leading `[…]` tags (and chains of them) before testing patterns, so the deny-list catches these correctly.
- **Deny-list expanded.** Added Zoomify, Controlling, InvMove, JECharacters, Xaero's WorldMap, InventoryProfilesNext, EnhancedVisuals, ItemPhysicLite (incl. the `Lite` / `Full` suffixed forms), Smooth Swapping, CustomSkinLoader, JourneyMap, and several first-person camera mods.
- **`sodiumextras` and `itemphysiclite` filename patterns** no longer require a strict separator after the prefix — `sodiumextras-…` and `ItemPhysicLite_…` are now matched.

---

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
