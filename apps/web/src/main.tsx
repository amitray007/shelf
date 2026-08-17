import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';

import { captureShareCapability, shareIdFromViewerPath } from './capability.js';
import { LoadingView, UnavailableView } from './components/viewer-shell.js';
import { AccessPage } from './dashboard/access-page.js';
import { ArtifactPage } from './dashboard/artifact-page.js';
import { ArtifactsPage } from './dashboard/artifacts-page.js';
import { DashboardErrorBoundary, DashboardLayout, DashboardLoading } from './dashboard/layout.js';
import {
  accessLoader,
  artifactLoader,
  artifactsLoader,
  dashboardIndexLoader,
  dashboardLoader,
  signInAction,
  signInLoader,
} from './dashboard/routes.js';
import { SignInPage } from './dashboard/signin-page.js';
import './styles.css';
import './dashboard/shell.css';
import './dashboard/artifact.css';
import './dashboard/access.css';
import './dashboard/responsive.css';
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
  {
    path: '/signin',
    loader: signInLoader,
    action: signInAction,
    Component: SignInPage,
    ErrorBoundary: DashboardErrorBoundary,
    HydrateFallback: DashboardLoading,
  },
  {
    id: 'dashboard',
    path: '/app',
    loader: dashboardLoader,
    Component: DashboardLayout,
    ErrorBoundary: DashboardErrorBoundary,
    HydrateFallback: DashboardLoading,
    children: [
      { index: true, loader: dashboardIndexLoader },
      {
        path: 'w/:workspaceId/artifacts',
        loader: artifactsLoader,
        Component: ArtifactsPage,
      },
      {
        path: 'w/:workspaceId/artifacts/:artifactId',
        loader: artifactLoader,
        Component: ArtifactPage,
      },
      { path: 'access', loader: accessLoader, Component: AccessPage },
    ],
  },
  { path: '*', element: <Navigate replace to="/app" /> },
]);

window.addEventListener('hashchange', () => {
  if (captureCurrentCapability() !== null) void router.revalidate();
});

const root = document.getElementById('root');
if (root === null) throw new Error('Viewer root is unavailable');

createRoot(root).render(<RouterProvider router={router} />);
