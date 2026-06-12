// Height of the custom Electron title bar (TitleBar.jsx). Fullscreen overlays
// portaled to #root via ModalPortal must start below it — use
// `fixed inset-x-0 bottom-0` with `style={{ top: TITLEBAR_OFFSET }}` instead
// of `inset-0` — so the window minimize/maximize/close buttons stay visible
// and clickable above the backdrop. In dev (plain browser) TitleBar renders
// null, so there's nothing to offset.
export const TITLEBAR_OFFSET =
  typeof window !== 'undefined' && window.electronAPI?.isElectron ? 38 : 0;
