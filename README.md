# MineDash

**MineDash** is a free, open-source desktop app for running and managing Minecraft servers on your own PC — and a full Minecraft launcher in the same window.

Everything runs locally: MineDash manages the Java processes, mods, plugins, backups, networking, and scheduled tasks for servers that live on **your** hardware. It is not a hosted service.

## Download

Grab the latest Windows installer from the [Releases page](https://github.com/proffesionalprogrammer/minedash/releases/latest). The app auto-updates from the same place.

## Features

**Server manager**
- One-click server creation for Vanilla, Paper, Fabric, Forge, and NeoForge
- Live console, player list with op/kick/ban actions, CPU/RAM stats with sparklines
- Mod & plugin browsing and installation (Modrinth + Hangar), with automatic missing-dependency repair after crashes
- Modpack import from `.mrpack` files
- Backups (manual, scheduled, auto-pruned, pinnable), server cloning, scheduled tasks (backup / restart / command)
- `server.properties` editor with searchable toggles and dropdowns
- Automatic Java management — downloads the right JDK from Adoptium per Minecraft version

**Launcher**
- Microsoft sign-in (device flow) and offline accounts
- Vanilla, Fabric, Forge, and NeoForge profiles with per-profile mod and modpack management
- Launch the game and join your local server from the same app

## Running from source

Requirements: Node.js 20+, npm.

```bash
npm install              # root deps (electron, electron-builder, backend runtime deps)
cd backend && npm install
cd ../frontend && npm install
```

Dev mode (no Electron — backend + Vite dev server in your browser):

```bash
start_minedash.bat       # opens http://localhost:5173
```

Or manually: `npm run dev:backend` (port 3001) and `npm run dev:frontend` (port 5173).

Build the Windows installer:

```bash
npm run build            # output in dist-electron/
```

See [CLAUDE.md](CLAUDE.md) for a detailed architecture walkthrough.

## Contributing

Issues and pull requests are welcome. For non-trivial frontend changes, run `cd frontend && npm run lint` before submitting.

## License

[MIT](LICENSE)
