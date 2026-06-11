# Changelog

All notable changes to MineDash are listed here. The version-specific section for whichever release you're running is shown in the "What's new" popup the first time MineDash starts after an update.

## v1.0.99 — 2026-06-11

### Changed

- **MineDash is now open source!** The full source code lives at [github.com/proffesionalprogrammer/minedash](https://github.com/proffesionalprogrammer/minedash) under the MIT license. Issues and pull requests are welcome.
- **Updates now come straight from the main repository.** Releases are published on the main `minedash` repo instead of the separate `minedash-releases` mirror. This update is the switchover — once you're on v1.0.99, all future updates arrive from the new location automatically. Nothing to do on your end.

---

## v1.0.98 — 2026-06-11

### Changed

- **Faster startup and a lighter, snappier app.** MineDash now loads only the screen you land on and pulls in the rest (Browse, Instances, Settings, the server dashboard, and modpack details) on demand, so the app opens noticeably quicker.
- **Smoother server consoles.** The live console no longer stutters when a server floods the log during startup — incoming lines are batched and drawn together, so even a busy modded boot stays responsive.
- **Lower background CPU and disk usage.** While a server page is open, MineDash was re-scanning the whole instance folder once a second to size it; storage is now measured on a gentler schedule and cached, and the dashboard no longer re-renders the entire app every couple of seconds. Idle resource use is meaningfully lower.

---

## v1.0.97 — 2026-06-11

### Added

- **Choose where MineDash stores its downloads.** A new **Settings → Storage** section lets you move all MineDash data — game files, server instances, backups, and managed Java runtimes — to another folder or drive (great if C: is filling up). Pick a folder, click *Move data here*, and restart when prompted; *Move back to default* undoes it. MineDash refuses to move while servers or downloads are running, and falls back to the default location if the chosen drive ever goes missing.
- **Refresh skin button.** Changed your skin on ely.by and MineDash still shows the old one? Each account in **Settings → Accounts** now has a refresh button that re-fetches your head instantly. Cached skins also expire much sooner on their own.

### Fixed

- **Stop download now actually stops the download.** Clicking *Stop download* right after launching could reset the button while the download quietly carried on in the background until the version showed up as "Installed". Cancels are now honoured no matter how early you click.

---

## v1.0.96 — 2026-06-02

### Fixed

- **MineDash no longer launches a duplicate window.** Opening MineDash while it's already running (including from the tray) now brings the existing window to the front instead of starting a second copy.
- **"Failed to fetch" on startup in v1.0.94.** The previous build shipped without the `pngjs` module the launcher-skins feature needs, so the backend crashed on boot and the app loaded with no server behind it. `pngjs` is now declared as a top-level dependency so it's bundled into the packaged app, and the backend starts cleanly.

---

## v1.0.94 — 2026-05-29

### Added

- **Player skins now show for everyone — no login required.** MineDash now ships CustomSkinLoader into every modded client (Fabric/Forge/NeoForge/Quilt) at launch, pointed at Ely.by. Skins are resolved by username, so offline accounts render each other's skins even on offline-mode servers — something the Ely.by login path couldn't do. Set your skin once at ely.by (your in-game name must match your Ely.by account name) and everyone running MineDash sees it.

---

## v1.0.93 — 2026-05-27

### Added

- **First-run onboarding tour.** A short, skippable guided tour now runs the first time you launch MineDash — it walks you through the Launcher/Servers top bar, signing in (or playing offline), picking a loader and version, and one-click modpack installs, so new users know where everything lives.

### Changed

- **App-wide motion polish.** Animations across the app are now smoother and snappier, driven by a shared brand-coloured motion system. Server cards stagger in on the home screen, stat-card sparklines draw themselves in, online indicators pulse in brand green, and the Network and console-search panels animate into place. Modals everywhere share one consistent, quick spring (with faster exits), and switching tabs is now a clean crossfade instead of a vertical slide.

### Fixed

- **Mods tab no longer jumps upward when you open it.** Tab content used to slide up a few pixels as it appeared; tabs now swap in place.
- **Instance dropdown flicker** on the Play tab.

---

## v1.0.92 — 2026-05-26

### Added

- **Open profile folder from the launcher.** The Instance row on the Play tab now has a folder button next to Rename/Delete that opens the on-disk profile directory in your file explorer. No more digging through `%AppData%\MineDash\launcher-clients\…` to drop a manual mod or check what configs the modpack wrote.

### Fixed

- **Deleting a modpack in the launcher actually removes it.** Hitting the trash icon on an installed modpack used to silently do nothing — the backend's content-delete endpoint had no handler for `modpack` and returned 400. Modpack installs now record the full list of paths they wrote (mods + overrides), and Delete wipes every tracked file, prunes the empty directories it left behind, and clears the manifest entry so the UI flips back to "Install".
- **NeoForge servers no longer pop a separate "Minecraft server" GUI window** beside the in-app console. Modern Forge's `run.bat` hardcodes `nogui`; NeoForge's doesn't, so the bundled server.jar was booting its Swing GUI. MineDash now passes `nogui` through to `run.bat`/`run.sh`, which is forwarded to the JVM via `%*` / `$@`. Closing the rogue window no longer kills the server because the rogue window is gone.

---

## v1.0.91 — 2026-05-26

### Fixed

- **NeoForge "failed to fetch" the moment you click Play.** v1.0.7 forced IPv4-first DNS for outbound HTTP, but only in the main backend process. NeoForge installs run inside a forked worker subprocess (introduced in v1.0.9 for instant cancel), and `dns.setDefaultResultOrder` is process-local — the worker didn't inherit it, so its fetches to `maven.neoforged.net` were still hitting AAAA records that time out on networks with broken IPv6. The setting is now applied inside the worker too.

### Changed

- **Branded number inputs in Settings.** The Window Size width/height fields used the OS-default spinner arrows, which rendered in light grey and clashed with the dark UI. Replaced them with stacked chevron buttons in the brand grey-to-green palette.

---

## v1.0.9 — 2026-05-24

### Added

- **Drag-and-drop multi-upload in both the launcher Content tab and the server Mods tab.** Drop one jar, ten jars, or a mix of jars and packs straight onto the panel — a green dashed overlay appears while you're hovering, and dropping uploads them all in one request with per-file success reporting. The file-picker buttons also accept multi-select now. Drop a single `.zip` on the server Mods panel and you still get the "Extract Modpack?" prompt.
- **Manual mod upload for the launcher.** New Upload button beside the search bar (and the drag-drop target) lets you install mods Modrinth doesn't host — CurseForge-only stuff like FTB Quests, or anything you downloaded by hand. Uploaded files are marked client-extras so the per-server Play sync won't wipe them on launch.
- **Sort and pagination in the launcher Content tab.** Relevance / Downloads / Newest / Updated dropdown and prev/next page buttons, mirroring the server-side Mods tab.
- **Per-server launcher instance.** Hitting Play on a server now creates (or reuses) a dedicated launcher profile named after the server instead of dumping mods into the shared default instance. Switching between servers no longer smashes their mod lists together.
- **Modpack install progress that survives tab switches.** Install state lives at the App level and rehydrates from a shared map when you come back to the tab — no more "the bar reset to Install but it was actually still going" UX. Works for both server and launcher modpack installs.

### Changed

- **Launch now runs in a forked subprocess for instant cancel.** Clicking Stop during a download used to require waiting for mclc's current file to finish (sometimes 30 s+ on a 200 MB asset) because mclc has no safe abort API. The whole launch sequence — Microsoft auth refresh, Fabric/Forge/NeoForge install, asset/library download, JVM spawn, dep-crash retry — now runs in a child Node process. Stop sends a polite cancel IPC (the worker `taskkill /F /T`s any sub-children on Windows), then SIGKILLs the worker after 2.5 s if it doesn't go quietly. End-to-end cancel is now sub-3 s even mid-download.

### Fixed

- **Content tab in the launcher opens instantly instead of taking 20 s on big modpacks.** The icon-enrichment cache was re-checking every "miss" entry (every CurseForge-only mod, every niche library) on every Content open — SHA1-hashing them from disk and re-asking Modrinth for a guaranteed 404. A 500-mod Prominence install made that a 20-second wait every single time. `lookedUp: true` is now final, and first-ever opens get a 1.5 s enrichment budget with the rest finishing in the background. Subsequent opens are instant.
- **Browse search no longer dies during the first content load.** When Modrinth rate-limits the proxy during the initial enrichment burst, the search now silently retries once after 1.5 s instead of leaving "Modrinth failed" up until you type something. No manual reload needed.
- **Newly-installed mods get wrong-version / wrong-loader warnings on the very next listing** — the install endpoint persists the version's `game_versions` and `loaders` immediately so no SHA1 round-trip is needed.
- **Modpack importer now filters dozens more client-only mods out of dedicated servers.** Added patterns for ColorWheel, FancyMenu, Konkrete, Forge Config Screen, Configured, Drippy Loading Screen, EMF/ETF, cull-leaves, sound physics, Xaero Map Plus, Free Cam, Replay Mod, presence-footsteps, ambient sounds, Not Enough Animations, and more. The Prominence-style "I installed a 500-mod pack and the server crashes on startup" report should be much rarer.

---

## v1.0.8 — 2026-05-23

### Added

- **Auto-managed Java per server.** MineDash now downloads the exact Java major your server needs (1.20.x → Java 17, 1.21.5- → Java 21, 1.21.6+ → Java 25) into a managed pool the first time you start that server. Progress streams into the server console. You never have to install Java by hand again, and a 1.20.1 server stops failing because the system Java is too new for it.
- **"Install automatically" in the Java setup modal.** Hit the green button and MineDash fetches the right JDK from Adoptium with a progress bar — no more leaving the app to download an installer.
- **Mod tab flags broken mods + one-click fix.** The Mods tab now shows badges for **Client** (would crash a dedicated server), **Wrong version** (mod isn't built for this MC version), and **Wrong loader** (Forge jar in a Fabric server, etc.). An amber banner at the top offers "Clean client mods" (moves them to the per-server stash) and "Repair versions" (looks up a compatible Modrinth build and swaps the jar in place).
- **Same fixer on the launcher side.** Launcher → Installed view gets the wrong-version / wrong-loader badges and a Repair button. Client-only cleanup is intentionally not exposed there — those are exactly the mods the launcher wants.
- **Mixin crash detection.** When a mod's mixin injection fails on startup (the classic ModernFix / Forge-version-skew scenario), the crash banner now names the actual culprit ("ModernFix failed a mixin injection — disable or update the mod") and offers a one-click **Disable ModernFix** button right on the banner.
- **Modpack install progress inside the server's Modpack tab.** Click Install on a modpack and the button fills with a live percentage as files land — same UX the Launcher tab already had. No more frozen spinner for 5 minutes.
- **MineDash auto-restores from tray when Minecraft closes.** Paired with "After launching: hide", MineDash now pops back up on its own once you exit the game. No more hunting for the tray icon.

### Fixed

- **MineDash no longer installs older mod versions when newer ones exist.** Auto-install and Repair used to occasionally pick v82 of a mod instead of v92 — Modrinth's filtered version list isn't always newest-first. The selector now tie-breaks by `date_published` so the latest compatible release always wins.
- **Java required-version modal showed up behind the Create Server modal.** First-time users never saw the prompt to install Java and just got mysterious crashes. The modal now sits on top where it belongs.
- **Server's cmd.exe console window stays hidden.** Starting a server no longer pops a separate Windows console next to MineDash — the in-app console viewer is the only place server output appears (which means you can't accidentally close the cmd window and kill your server anymore).
- **Stop downloading button in the launcher is honest now.** `minecraft-launcher-core` provides no way to interrupt a download mid-file, so the button used to claim it stopped while bytes kept flowing in the background. It now sits in a "Stopping — current file has to finish first…" state until the download genuinely ends, and the kill happens the instant the JVM tries to spawn.

---

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
