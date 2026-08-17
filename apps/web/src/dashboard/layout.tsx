import type { DashboardSession } from '@shelf/contracts';
import { useState } from 'react';
import {
  isRouteErrorResponse,
  Link,
  NavLink,
  Outlet,
  useLoaderData,
  useLocation,
  useNavigate,
  useParams,
  useRouteError,
} from 'react-router';

import { signOut } from './api.js';

function navClass({ isActive }: { isActive: boolean }): string {
  return isActive ? 'dashboard-nav-link is-active' : 'dashboard-nav-link';
}

export function DashboardLayout() {
  const session = useLoaderData() as DashboardSession;
  const params = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [signOutFailed, setSignOutFailed] = useState(false);
  const readableWorkspaces = session.workspaces.filter((workspace) =>
    workspace.actions.includes('revision.read'),
  );
  const activeWorkspace =
    readableWorkspaces.find((workspace) => workspace.workspaceId === params.workspaceId) ??
    readableWorkspaces[0];
  const artifactsPath =
    activeWorkspace === undefined
      ? '/app/access'
      : `/app/w/${encodeURIComponent(activeWorkspace.workspaceId)}/artifacts`;

  const changeWorkspace = (workspaceId: string) => {
    void navigate(`/app/w/${encodeURIComponent(workspaceId)}/artifacts`);
  };
  const leave = async () => {
    setSignOutFailed(false);
    try {
      await signOut();
      void navigate('/signin', { replace: true });
    } catch {
      setSignOutFailed(true);
    }
  };

  return (
    <div className="dashboard-shell">
      <header className="dashboard-bar">
        <div className="dashboard-identity">
          <Link className="wordmark dashboard-wordmark" to={artifactsPath}>
            shelf
          </Link>
          <span className="dashboard-rule" aria-hidden="true" />
          <span className="dashboard-context">workspace utility</span>
        </div>
        <nav className="dashboard-nav" aria-label="Dashboard">
          {activeWorkspace === undefined ? null : (
            <NavLink className={navClass} to={artifactsPath}>
              Artifacts
            </NavLink>
          )}
          <NavLink className={navClass} to="/app/access">
            Access
          </NavLink>
        </nav>
        <div className="dashboard-authority">
          {readableWorkspaces.length > 0 ? (
            <label className="workspace-control">
              <span className="visually-hidden">Workspace</span>
              <select
                value={activeWorkspace?.workspaceId ?? ''}
                onChange={(event) => changeWorkspace(event.currentTarget.value)}
              >
                {readableWorkspaces.map((workspace) => (
                  <option key={workspace.workspaceId} value={workspace.workspaceId}>
                    {workspace.workspaceId}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="dashboard-context">No workspace grant</span>
          )}
          <button aria-label="Sign out" className="quiet-button" type="button" onClick={leave}>
            <span className="signout-label">Sign out</span>
            <span aria-hidden="true" className="signout-label-short">
              Exit
            </span>
          </button>
        </div>
      </header>
      {signOutFailed ? (
        <p className="inline-notice" role="alert">
          Sign out failed. Your session is still active.
        </p>
      ) : null}
      <main className="dashboard-main" key={location.pathname}>
        <Outlet />
      </main>
    </div>
  );
}

export function DashboardLoading() {
  return (
    <div aria-busy="true" className="dashboard-loading">
      <span className="wordmark">shelf</span>
      <div className="dashboard-loading-state">
        <span aria-hidden="true" className="loading-mark" />
        <p>Opening workspace…</p>
      </div>
    </div>
  );
}

export function DashboardErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? error.status === 404
      ? 'This item could not be found.'
      : 'Shelf could not load this view.'
    : 'Shelf could not load this view.';
  return (
    <div className="dashboard-error">
      <span className="status-mark" aria-hidden="true" />
      <p className="eyebrow">Dashboard unavailable</p>
      <h1>{message}</h1>
      <p>Your content has not been changed. Try the artifact list again.</p>
      <Link className="control control-primary" to="/app">
        Back to artifacts
      </Link>
    </div>
  );
}
