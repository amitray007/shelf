import type {
  DashboardCredentialAction,
  DashboardCredentialIssue,
  DashboardCredentialPage,
  DashboardCredentialSummary,
  DashboardSession,
} from '@shelf/contracts';
import { type FormEvent, useRef, useState } from 'react';
import { Link, useLoaderData, useRevalidator, useRouteLoaderData } from 'react-router';

import { createDashboardCredential, DashboardApiError, revokeDashboardCredential } from './api.js';
import { Modal, SecretReveal } from './dialogs.js';
import { useManagedStatus } from './status.js';

function dateTime(value: string | null): string {
  if (value === null) return 'Never';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function IssueCredentialDialog({
  session,
  open,
  onOpenChange,
}: {
  readonly session: DashboardSession;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const revalidator = useRevalidator();
  const [actorName, setActorName] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [selected, setSelected] = useState(() => new Set<string>());
  const [issued, setIssued] = useState<DashboardCredentialIssue>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const agentNameRef = useRef<HTMLInputElement>(null);
  const close = (next: boolean) => {
    if (!next && busy) return;
    if (!next) {
      setIssued(undefined);
      setError(undefined);
      setActorName('');
      setExpiresAt('');
      setSelected(new Set());
    }
    onOpenChange(next);
  };
  const toggle = (workspaceId: string, action: DashboardCredentialAction) => {
    const key = `${workspaceId}\u0000${action}`;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const grants = session.workspaces.flatMap((workspace) =>
      workspace.actions
        .filter((action) => selected.has(`${workspace.workspaceId}\u0000${action}`))
        .map((action) => ({ workspaceId: workspace.workspaceId, action })),
    );
    if (grants.length === 0) {
      setError('Select at least one workspace action.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await createDashboardCredential({
        actorName,
        grants,
        ...(expiresAt === '' ? {} : { expiresAt: new Date(expiresAt).toISOString() }),
      });
      setIssued(result);
      void revalidator.revalidate();
    } catch (caught) {
      setError(caught instanceof DashboardApiError ? caught.message : 'Credential issue failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      canClose={!busy}
      description="Create an agent identity with only the workspace actions it needs."
      initialFocus={agentNameRef}
      onOpenChange={close}
      open={open}
      title="Issue access credential"
    >
      {issued === undefined ? (
        <form className="dialog-form" onSubmit={submit}>
          <label className="field">
            <span className="field-label">Agent name</span>
            <input
              aria-label="Agent name"
              maxLength={128}
              onChange={(event) => setActorName(event.currentTarget.value)}
              placeholder="release-agent"
              ref={agentNameRef}
              required
              value={actorName}
            />
          </label>
          <fieldset className="grant-fieldset">
            <legend className="field-label">Workspace grants</legend>
            {session.workspaces.map((workspace) => (
              <div className="grant-workspace" key={workspace.workspaceId}>
                <code>{workspace.workspaceId}</code>
                <div>
                  {workspace.actions.map((action) => (
                    <label key={action}>
                      <input
                        checked={selected.has(`${workspace.workspaceId}\u0000${action}`)}
                        onChange={() => toggle(workspace.workspaceId, action)}
                        type="checkbox"
                      />
                      <span>{action}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </fieldset>
          <label className="field">
            <span className="field-label">Expires (optional)</span>
            <input
              aria-label="Expiration date and time"
              onChange={(event) => setExpiresAt(event.currentTarget.value)}
              type="datetime-local"
              value={expiresAt}
            />
          </label>
          {error === undefined ? null : <p className="form-error">{error}</p>}
          <div className="dialog-actions">
            <button className="control" disabled={busy} onClick={() => close(false)} type="button">
              Cancel
            </button>
            <button className="control control-primary" disabled={busy} type="submit">
              {busy ? 'Issuing…' : 'Issue credential'}
            </button>
          </div>
        </form>
      ) : (
        <div className="dialog-form">
          <SecretReveal
            hint="This token is shown once. Put it in a keyring or an explicitly named environment variable."
            label="Access token"
            value={issued.token}
          />
          <div className="dialog-actions">
            <button className="control control-primary" onClick={() => close(false)} type="button">
              I saved it
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function CredentialRow({ credential }: { readonly credential: DashboardCredentialSummary }) {
  const revalidator = useRevalidator();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const status = useManagedStatus(credential.revokedAt, credential.expiresAt);
  const active = status === 'Active';
  const revoke = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await revokeDashboardCredential(credential.credentialId);
      setConfirming(false);
      void revalidator.revalidate();
    } catch (caught) {
      setError(caught instanceof DashboardApiError ? caught.message : 'Revocation failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="credential-row">
      <div className="credential-identity">
        <strong>{credential.actorName}</strong>
        <code>{credential.credentialId}</code>
      </div>
      <div className="grant-list">
        {credential.grants.map((grant) => (
          <span key={`${grant.workspaceId}:${grant.action}`}>
            {grant.workspaceId} / {grant.action}
          </span>
        ))}
      </div>
      <dl className="credential-dates">
        <div>
          <dt>Last used</dt>
          <dd>{dateTime(credential.lastUsedAt)}</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>{dateTime(credential.expiresAt)}</dd>
        </div>
      </dl>
      <span className={active ? 'status-pill' : 'status-pill is-muted'}>{status}</span>
      {active ? (
        <button
          className="quiet-button danger-text"
          onClick={() => setConfirming(true)}
          type="button"
        >
          Revoke
        </button>
      ) : null}
      <Modal
        canClose={!busy}
        description="The token will stop authenticating immediately. Existing artifacts and provenance stay intact."
        onOpenChange={setConfirming}
        open={confirming}
        title={`Revoke ${credential.actorName}?`}
      >
        <div className="dialog-form">
          {error === undefined ? null : <p className="form-error">{error}</p>}
          <div className="dialog-actions">
            <button
              className="control"
              disabled={busy}
              onClick={() => setConfirming(false)}
              type="button"
            >
              Cancel
            </button>
            <button
              className="control control-danger"
              disabled={busy}
              onClick={revoke}
              type="button"
            >
              {busy ? 'Revoking…' : 'Revoke credential'}
            </button>
          </div>
        </div>
      </Modal>
      {!confirming && error !== undefined ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}

export function AccessPage() {
  const page = useLoaderData() as DashboardCredentialPage;
  const session = useRouteLoaderData('dashboard') as DashboardSession;
  const [issueOpen, setIssueOpen] = useState(false);
  return (
    <div className="dashboard-page access-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Agent authority</p>
          <h1>Access</h1>
          <p>Scoped credentials for CLI and non-interactive agent workflows.</p>
        </div>
        <button
          className="control control-primary"
          disabled={session.workspaces.length === 0}
          onClick={() => setIssueOpen(true)}
          type="button"
        >
          Issue credential
        </button>
      </header>
      <aside className="access-principle">
        <strong>Tokens are reveal-once.</strong>
        <span>
          Shelf stores only a one-way digest and never returns token material in this list.
        </span>
      </aside>
      {page.items.length === 0 ? (
        <section className="dashboard-empty">
          <p className="eyebrow">No agent access</p>
          <h2>Issue a scoped credential when an agent needs Shelf.</h2>
        </section>
      ) : (
        <ul className="credential-list" aria-label="Access credentials">
          {page.items.map((credential) => (
            <CredentialRow credential={credential} key={credential.credentialId} />
          ))}
        </ul>
      )}
      {page.nextCursor === null ? null : (
        <footer className="pagination">
          <Link className="control" to={`?cursor=${encodeURIComponent(page.nextCursor)}`}>
            Next page
          </Link>
        </footer>
      )}
      <IssueCredentialDialog onOpenChange={setIssueOpen} open={issueOpen} session={session} />
    </div>
  );
}
