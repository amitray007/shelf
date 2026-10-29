import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import { createRoot } from 'react-dom/client';
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
  useLocation,
  useRouteError,
} from 'react-router';

import {
  captureShareCapability,
  IncompleteShareLinkError,
  shareReferenceFromViewerPath,
} from './capability.js';
import { LoadingView } from './components/boot-views.js';
import './components/viewer-controls.css';
import './components/viewer-loading.css';
import './styles.css';
import { startShareBoot } from './share-boot.js';
import { ViewerRecoveryView } from './viewer-recovery-view.js';
import { consumeViewerRecovery } from './viewer-retry.js';

function captureCurrentCapability(): string | null {
  const reference = shareReferenceFromViewerPath(window.location.pathname);
  if (reference?.accessType !== 'protected') return null;
  return captureShareCapability({
    shareId: reference.shareId,
    location: window.location,
    history: window.history,
    sessionStorage: window.sessionStorage,
  });
}

captureCurrentCapability();
const shareBootUrl = new URL(window.location.href);
const shareRoute = shareReferenceFromViewerPath(shareBootUrl.pathname) !== null;
if (shareRoute) startShareBoot(shareBootUrl);
const viewerLoaderModule = shareRoute ? import('./viewer-loader.js') : undefined;
const viewerPageModule = shareRoute ? import('./viewer-page.js') : undefined;
document.documentElement.dataset.mode = 'dark';

function ViewerErrorBoundary() {
  const error = useRouteError();
  const location = useLocation();
  // Only loader failures are network-shaped. Render errors never enter router state.
  const loaderFailure = Object.values(router.state.errors ?? {}).includes(error);
  return (
    <ViewerRecoveryView
      key={location.key}
      error={error}
      recoverable={loaderFailure}
      revalidate={() => router.revalidate()}
      readFailure={() => Object.values(router.state.errors ?? {})[0]}
    />
  );
}

const router = createBrowserRouter([
  {
    path: '/s/:shareRef',
    loader: async (args) =>
      (await (viewerLoaderModule ?? import('./viewer-loader.js'))).viewerLoader(args),
    lazy: async () => {
      const viewer = await (viewerPageModule ?? import('./viewer-page.js'));
      return { Component: viewer.ViewerPage };
    },
    ErrorBoundary: ViewerErrorBoundary,
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
    path: '/preview/:artifactId',
    HydrateFallback: LoadingView,
    lazy: async () => {
      const [page, routes] = await Promise.all([
        import('./preview-page.js'),
        import('./dashboard/routes.js'),
      ]);
      return {
        Component: page.PreviewPage,
        ErrorBoundary: page.PreviewErrorBoundary,
        loader: routes.artifactPreviewLoader,
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
        path: 'w/:workspaceId/trash',
        lazy: async () => {
          const [page, routes] = await Promise.all([
            import('./dashboard/trash-page.js'),
            import('./dashboard/routes.js'),
          ]);
          return { Component: page.TrashPage, loader: routes.trashLoader };
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
      {
        path: 'settings',
        lazy: async () => {
          const [page, routes] = await Promise.all([
            import('./dashboard/html-preview-settings-page.js'),
            import('./dashboard/routes.js'),
          ]);
          return {
            Component: page.HtmlPreviewSettingsPage,
            loader: routes.htmlPreviewSettingsLoader,
          };
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

function recoverViewer() {
  // An unrelated speculative request must not restart a terminal route failure.
  const terminal = Object.values(router.state.errors ?? {}).some(
    (error) =>
      error instanceof IncompleteShareLinkError ||
      (typeof error === 'object' &&
        error !== null &&
        'failure' in error &&
        error.failure === 'terminal'),
  );
  if (terminal) {
    consumeViewerRecovery();
    return;
  }
  if (router.state.errors !== null) return;
  if (shareReferenceFromViewerPath(window.location.pathname) && consumeViewerRecovery()) {
    void router.revalidate();
  }
}
window.addEventListener('online', recoverViewer);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') recoverViewer();
});
