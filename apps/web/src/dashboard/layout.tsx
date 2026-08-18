import { Button } from '@cloudflare/kumo/components/button';
import { DropdownMenu } from '@cloudflare/kumo/components/dropdown';
import { KeyIcon } from '@phosphor-icons/react/Key';
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
      ? '/app/access'
      : `/app/w/${encodeURIComponent(activeWorkspace.workspaceId)}/artifacts`;
  const locationLabel = location.pathname === '/app/access' ? 'Access' : 'Artifacts';

  const changeWorkspace = (workspaceId: string) => {
    void navigate(`/app/w/${encodeURIComponent(workspaceId)}/artifacts`);
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
      {params.artifactId === undefined ? (
        <header className="dashboard-bar">
          <nav className="dashboard-location" aria-label="Current location">
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
                  </Button>
                }
              />
              <DropdownMenu.Content align="start" className="workspace-menu-content">
                {readableWorkspaces.length === 0 ? (
                  <DropdownMenu.Item disabled>No readable workspaces</DropdownMenu.Item>
                ) : (
                  <DropdownMenu.Group>
                    <DropdownMenu.Label>Workspaces</DropdownMenu.Label>
                    {readableWorkspaces.map((workspace) => (
                      <DropdownMenu.Item
                        key={workspace.workspaceId}
                        onClick={() => changeWorkspace(workspace.workspaceId)}
                        selected={workspace.workspaceId === activeWorkspace?.workspaceId}
                      >
                        {workspace.workspaceId}
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.Group>
                )}
                <DropdownMenu.Separator />
                <DropdownMenu.Item icon={PlusIcon} onClick={() => setCreateOpen(true)}>
                  New workspace
                </DropdownMenu.Item>
                <DropdownMenu.Item icon={KeyIcon} onClick={() => void navigate('/app/access')}>
                  Access
                </DropdownMenu.Item>
                <DropdownMenu.Item icon={SignOutIcon} onClick={() => void leave()}>
                  Sign out
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu>
            <span className="location-separator" aria-hidden="true">
              /
            </span>
            {locationLabel === 'Artifacts' && activeWorkspace !== undefined ? (
              <Link className="dashboard-current" to={artifactsPath}>
                Artifacts
              </Link>
            ) : (
              <span className="dashboard-current">{locationLabel}</span>
            )}
          </nav>
        </header>
      ) : null}
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
