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

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
