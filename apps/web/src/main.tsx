import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';

import { captureShareCapability, shareIdFromViewerPath } from './capability.js';
import { LoadingView, UnavailableView } from './components/viewer-shell.js';
import './styles.css';
import { ViewerPage, viewerLoader } from './viewer-page.js';

function captureCurrentCapability(): string | null {
  const shareId = shareIdFromViewerPath(window.location.pathname);
  if (shareId === null) return null;
  return captureShareCapability({
    shareId,
    location: window.location,
    history: window.history,
    sessionStorage: window.sessionStorage,
  });
}

captureCurrentCapability();

const router = createBrowserRouter([
  {
    path: '/s/:shareId',
    loader: viewerLoader,
    Component: ViewerPage,
    ErrorBoundary: UnavailableView,
    HydrateFallback: LoadingView,
  },
  { path: '*', Component: UnavailableView },
]);

window.addEventListener('hashchange', () => {
  if (captureCurrentCapability() !== null) void router.revalidate();
});

const root = document.getElementById('root');
if (root === null) throw new Error('Viewer root is unavailable');

createRoot(root).render(<RouterProvider router={router} />);
