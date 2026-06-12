import { createPortal } from 'react-dom';

// Overlays portaled here should start below the Electron title bar — see
// TITLEBAR_OFFSET in ../lib/titlebar.js (a constant export from this file
// would break the react-refresh/only-export-components lint rule).

// Renders children directly under #root so the modal escapes the framer-motion
// page-transition wrappers inside <main> (which apply `transform` and become
// containing blocks for `position: fixed`, making modals clip to the tab card
// or sit below the app header). We deliberately target #root — not document.body
// — so the modal still inherits the --app-scale transform on #root and renders
// at the same visual scale as the rest of the UI.
export default function ModalPortal({ children }) {
  if (typeof document === 'undefined') return null;
  const target = document.getElementById('root') || document.body;
  return createPortal(children, target);
}
