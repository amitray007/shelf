import { Button } from '@cloudflare/kumo/components/button';
import { DropdownMenu } from '@cloudflare/kumo/components/dropdown';
import { CaretDownIcon } from '@phosphor-icons/react/CaretDown';
import { PlusIcon } from '@phosphor-icons/react/Plus';
import { SignOutIcon } from '@phosphor-icons/react/SignOut';
import { StackIcon } from '@phosphor-icons/react/Stack';
import type { DashboardSession } from '@shelf/contracts';
import { useState } from 'react';
import {
  isRouteErrorResponse,
  Link,
  Outlet,
  useLoaderData,
  useLocation,
  useNavigate,
  useParams,
  useRevalidator,
  useRouteError,
} from 'react-router';

import { signOut } from './api.js';
import { CreateWorkspaceDialog } from './workspace-dialog.js';
import './shell.css';
import './responsive.css';

export function DashboardLayout() {
  const session = useLoaderData() as DashboardSession;
  const params = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [createOpen, setCreateOpen] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const readableWorkspaces = session.workspaces.filter((workspace) =>
    workspace.actions.includes('revision.read'),
  );
  const activeWorkspace =
    readableWorkspaces.find((workspace) => workspace.workspaceId === params.workspaceId) ??
    readableWorkspaces[0];
  const artifactsPath =
    activeWorkspace === undefined
      ? '/app'
      : `/app/w/${encodeURIComponent(activeWorkspace.workspaceId)}/artifacts`;
  const accessPath =
    activeWorkspace === undefined
      ? '/app/access'
      : `/app/w/${encodeURIComponent(activeWorkspace.workspaceId)}/access`;
  const accessActive = location.pathname.endsWith('/access');

  const changeWorkspace = (workspaceId: string) => {
    const section = accessActive ? 'access' : 'artifacts';
    void navigate(`/app/w/${encodeURIComponent(workspaceId)}/${section}`);
  };
  const createdWorkspace = (workspaceId: string) => {
    setCreateOpen(false);
    void revalidator.revalidate();
    changeWorkspace(workspaceId);
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
        <div className="dashboard-location">
          <nav className="dashboard-context" aria-label="Workspace">
            <Link className="wordmark dashboard-wordmark" to={artifactsPath}>
              shelf
            </Link>
            <span className="location-separator" aria-hidden="true">
              /
            </span>
            <DropdownMenu>
              <DropdownMenu.Trigger
                render={
                  <Button
                    aria-label={`Workspace menu, ${activeWorkspace?.workspaceId ?? 'no workspace grant'}`}
                    className="workspace-menu-trigger"
                    icon={StackIcon}
                    size="sm"
                    variant="ghost"
                  >
                    <span className="workspace-menu-label">
                      {activeWorkspace?.workspaceId ?? 'No workspace grant'}
                    </span>
                    <CaretDownIcon aria-hidden="true" className="workspace-menu-caret" size={12} />
                  </Button>
                }
              />
              <DropdownMenu.Content align="start" className="workspace-menu-content">
                <DropdownMenu.Group>
                  <DropdownMenu.Label>
                    <span>Workspaces</span>
                    <span>{readableWorkspaces.length}</span>
                  </DropdownMenu.Label>
                  {readableWorkspaces.length === 0 ? (
                    <DropdownMenu.Item disabled>No readable workspaces</DropdownMenu.Item>
                  ) : (
                    readableWorkspaces.map((workspace) => (
                      <DropdownMenu.Item
                        key={workspace.workspaceId}
                        onClick={() => changeWorkspace(workspace.workspaceId)}
                        selected={workspace.workspaceId === activeWorkspace?.workspaceId}
                      >
                        {workspace.workspaceId}
                      </DropdownMenu.Item>
                    ))
                  )}
                </DropdownMenu.Group>
                <DropdownMenu.Separator />
                <DropdownMenu.Item icon={PlusIcon} onClick={() => setCreateOpen(true)}>
                  New workspace
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu>
          </nav>

          <div className="dashboard-actions">
            <nav aria-label="Dashboard sections" className="dashboard-section-tabs">
              <Link aria-current={accessActive ? undefined : 'page'} to={artifactsPath}>
                Artifacts
              </Link>
              <Link aria-current={accessActive ? 'page' : undefined} to={accessPath}>
                Access
              </Link>
            </nav>
            <Button
              className="dashboard-sign-out"
              icon={SignOutIcon}
              onClick={() => void leave()}
              size="sm"
              type="button"
              variant="ghost"
            >
              Sign out
            </Button>
          </div>
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
      <CreateWorkspaceDialog
        onCreated={createdWorkspace}
        onOpenChange={setCreateOpen}
        open={createOpen}
      />
    </div>
  );
}

export function DashboardLoading() {
  return (
    <div aria-busy="true" className="dashboard-loading">
      <div className="dashboard-loading-bar">
        <span className="wordmark">shelf</span>
        <span aria-hidden="true" className="dashboard-skeleton-pill" />
        <span aria-hidden="true" className="dashboard-skeleton-pill dashboard-skeleton-pill-end" />
      </div>
      <div className="dashboard-loading-body">
        <p className="visually-hidden" role="status">
          Opening workspace…
        </p>
        <span aria-hidden="true" className="dashboard-skeleton-heading" />
        <div aria-hidden="true" className="dashboard-skeleton-rows">
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
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
