// Mahoraga's wheel turning over the screen — shown when the launcher's crash
// auto-fix has repaired the mods and is relaunching the game (the backend's
// `adapting` launch event). The animation itself is the standalone
// public/adaptation.html. In Electron it gets its own transparent, click-through
// window above everything (the game just died and MineDash may be hidden in the
// tray); in the browser dev build it's mounted here as a full-page iframe.
export function showAdaptation(fixes) {
  const list = (Array.isArray(fixes) ? fixes : []).map(String).slice(0, 4);
  if (window.electronAPI?.showAdaptation) {
    window.electronAPI.showAdaptation(list);
    return;
  }

  document.getElementById('minedash-adaptation')?.remove();
  const frame = document.createElement('iframe');
  frame.id = 'minedash-adaptation';
  frame.src = `./adaptation.html?embedded=1&fixes=${encodeURIComponent(JSON.stringify(list))}`;
  frame.allow = 'autoplay';
  Object.assign(frame.style, {
    position: 'fixed', inset: '0', width: '100vw', height: '100vh',
    border: '0', background: 'transparent', zIndex: '2147483647', pointerEvents: 'none',
  });
  const remove = () => {
    window.removeEventListener('message', onMessage);
    frame.remove();
  };
  const onMessage = (e) => {
    if (e.source === frame.contentWindow && e.data?.type === 'minedash-adaptation-done') remove();
  };
  window.addEventListener('message', onMessage);
  setTimeout(remove, 10000);
  document.body.appendChild(frame);
}
