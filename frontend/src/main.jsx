import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Paint the saved colour theme before React mounts so users on Light/OLED don't
// see a flash of the default dark palette. App.jsx re-applies this from the
// authoritative launcher settings once they load.
try {
  const pref = localStorage.getItem('minedash-theme') || 'dark';
  const sysLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  document.documentElement.setAttribute(
    'data-theme',
    pref === 'system' ? (sysLight ? 'light' : 'dark') : pref,
  );
} catch { /* localStorage unavailable (private mode) — fall back to CSS default */ }

// A file dropped anywhere that isn't a drop zone would otherwise be opened by
// the browser — which in the frameless Electron window replaces the whole app
// with the file and leaves no back button. Drop zones call preventDefault()
// themselves before this runs (React handles the event first as it bubbles),
// so only unhandled drops land here, and they're shown as "not allowed".
for (const type of ['dragover', 'drop']) {
  window.addEventListener(type, (e) => {
    if (e.defaultPrevented || !e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'none';
  });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
