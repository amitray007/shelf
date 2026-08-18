import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';

import { captureShareCapability, shareIdFromViewerPath } from './capability.js';
import { LoadingView, UnavailableView } from './components/viewer-shell.js';
import './styles.css';

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
document.documentElement.dataset.mode = 'dark';

const router = createBrowserRouter([
  {
    path: '/s/:shareId',
    lazy: async () => {
      const viewer = await import('./viewer-page.js');
      return { Component: viewer.ViewerPage, loader: viewer.viewerLoader };
    },
    ErrorBoundary: UnavailableView,
    HydrateFallback: LoadingView,
  },
  {
    path: '/signin',
    lazy: async () => {
      const [page, routes, layout] = await Promise.all([
        import('./dashboard/signin-page.js'),
        import('./dashboard/routes.js'),
        import('./dashboard/layout.js'),
      ]);
      return {
        action: routes.signInAction,
        Component: page.SignInPage,
        ErrorBoundary: layout.DashboardErrorBoundary,
        HydrateFallback: layout.DashboardLoading,
        loader: routes.signInLoader,
      };
    },
  },
  {
    id: 'dashboard',
    path: '/app',
    lazy: async () => {
      const [layout, routes] = await Promise.all([
        import('./dashboard/layout.js'),
        import('./dashboard/routes.js'),
      ]);
      return {
        Component: layout.DashboardLayout,
        ErrorBoundary: layout.DashboardErrorBoundary,
        HydrateFallback: layout.DashboardLoading,
        loader: routes.dashboardLoader,
      };
    },
    children: [
      {
        index: true,
        lazy: async () => ({
          loader: (await import('./dashboard/routes.js')).dashboardIndexLoader,
        }),
      },
      {
        path: 'w/:workspaceId/artifacts',
        lazy: async () => {
          const [page, routes] = await Promise.all([
            import('./dashboard/artifacts-page.js'),
            import('./dashboard/routes.js'),
          ]);
          return { Component: page.ArtifactsPage, loader: routes.artifactsLoader };
        },
      },
      {
        path: 'w/:workspaceId/artifacts/:artifactId',
        lazy: async () => {
          const [page, routes] = await Promise.all([
            import('./dashboard/artifact-page.js'),
            import('./dashboard/routes.js'),
          ]);
          return { Component: page.ArtifactPage, loader: routes.artifactLoader };
        },
      },
      {
        path: 'w/:workspaceId/access',
        lazy: async () => {
          const [page, routes] = await Promise.all([
            import('./dashboard/access-page.js'),
            import('./dashboard/routes.js'),
          ]);
          return { Component: page.AccessPage, loader: routes.accessLoader };
        },
      },
      {
        path: 'access',
        lazy: async () => {
          const [page, routes] = await Promise.all([
            import('./dashboard/access-page.js'),
            import('./dashboard/routes.js'),
          ]);
          return { Component: page.AccessPage, loader: routes.accessLoader };
        },
      },
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
