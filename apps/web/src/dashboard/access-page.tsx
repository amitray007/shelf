import { Banner } from '@cloudflare/kumo/components/banner';
import { Button } from '@cloudflare/kumo/components/button';
import { Checkbox } from '@cloudflare/kumo/components/checkbox';
import { DropdownMenu } from '@cloudflare/kumo/components/dropdown';
import { Empty } from '@cloudflare/kumo/components/empty';
import { Input } from '@cloudflare/kumo/components/input';
import { Table } from '@cloudflare/kumo/components/table';
import { DotsThreeIcon } from '@phosphor-icons/react/DotsThree';
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
import './access.css';

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function dateTime(value: string | null): string {
  if (value === null) return 'Never';
  return dateTimeFormatter.format(new Date(value));
}

type GrantKey = `${string}\u0000${DashboardCredentialAction}`;

function grantKey(workspaceId: string, action: DashboardCredentialAction): GrantKey {
  return `${workspaceId}\u0000${action}`;
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
  const [selected, setSelected] = useState(() => new Set<GrantKey>());
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
  const selectGrant = (
    workspaceId: string,
    action: DashboardCredentialAction,
    checked: boolean,
  ) => {
    const key = grantKey(workspaceId, action);
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const grants = session.workspaces.flatMap((workspace) =>
      workspace.actions
        .filter((action) => selected.has(grantKey(workspace.workspaceId, action)))
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
          <Input
            label="Agent name"
            maxLength={128}
            onChange={(event) => setActorName(event.currentTarget.value)}
            placeholder="release-agent"
            ref={agentNameRef}
            required
            value={actorName}
          />
          <fieldset className="grant-fieldset">
            <legend className="field-label">Workspace grants</legend>
            {session.workspaces.map((workspace) => (
              <div className="grant-workspace" key={workspace.workspaceId}>
                <code title={workspace.workspaceId}>{workspace.workspaceId}</code>
                <div>
                  {workspace.actions.map((action) => (
                    <Checkbox
                      checked={selected.has(grantKey(workspace.workspaceId, action))}
                      controlFirst
                      key={action}
                      label={action}
                      onCheckedChange={(checked) =>
                        selectGrant(workspace.workspaceId, action, checked)
                      }
                    />
                  ))}
                </div>
              </div>
            ))}
          </fieldset>
          <Input
            label="Expires (optional)"
            onChange={(event) => setExpiresAt(event.currentTarget.value)}
            type="datetime-local"
            value={expiresAt}
          />
          {error === undefined ? null : (
            <Banner
              description={error}
              role="alert"
              size="sm"
              title="Credential wasn't issued"
              variant="error"
            />
          )}
          <div className="dialog-actions">
            <Button disabled={busy} onClick={() => close(false)} type="button">
              Cancel
            </Button>
            <Button disabled={busy} loading={busy} type="submit" variant="primary">
              {busy ? 'Issuing…' : 'Issue credential'}
            </Button>
          </div>
        </form>
      ) : (
        <div className="dialog-form">
          <Banner
            description="Put it in a keyring or an explicitly named environment variable. Shelf cannot show it again."
            size="sm"
            title="Copy this token now"
            variant="alert"
          />
          <SecretReveal
            hint="This value exists only in this reveal-once response."
            label="Access token"
            value={issued.token}
          />
          <div className="dialog-actions">
            <Button onClick={() => close(false)} type="button" variant="primary">
              I saved it
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function CredentialActions({
  credential,
  active,
  onDetails,
  onRevoke,
}: {
  readonly credential: DashboardCredentialSummary;
  readonly active: boolean;
  readonly onDetails: () => void;
  readonly onRevoke: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button
            aria-label={`Actions for ${credential.actorName}`}
            className="credential-actions-trigger"
            icon={DotsThreeIcon}
            shape="square"
            size="sm"
            variant="ghost"
          />
        }
      />
      <DropdownMenu.Content align="end">
        <DropdownMenu.Item onClick={onDetails}>View details</DropdownMenu.Item>
        {active ? (
          <DropdownMenu.Item onClick={onRevoke} variant="danger">
            Revoke credential
          </DropdownMenu.Item>
        ) : null}
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

function CredentialDetailsDialog({
  credential,
  onOpenChange,
}: {
  readonly credential: DashboardCredentialSummary | undefined;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const status = useManagedStatus(credential?.revokedAt ?? null, credential?.expiresAt ?? null);
  return (
    <Modal
      description="Credential identity, grants, and lifecycle state. Token material is never returned here."
      onOpenChange={onOpenChange}
      open={credential !== undefined}
      title={credential?.actorName ?? 'Credential details'}
    >
      {credential === undefined ? null : (
        <div className="dialog-form credential-details">
          <dl>
            <div>
              <dt>Credential ID</dt>
              <dd>
                <code>{credential.credentialId}</code>
              </dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{status}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{dateTime(credential.createdAt)}</dd>
            </div>
            <div>
              <dt>Last used</dt>
              <dd>{dateTime(credential.lastUsedAt)}</dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>{dateTime(credential.expiresAt)}</dd>
            </div>
            <div>
              <dt>Revoked</dt>
              <dd>{dateTime(credential.revokedAt)}</dd>
            </div>
          </dl>
          <section aria-labelledby="credential-grants-title" className="credential-details-grants">
            <h3 id="credential-grants-title">Workspace grants</h3>
            <div className="grant-list">
              {credential.grants.map((grant) => (
                <span
                  key={`${grant.workspaceId}:${grant.action}`}
                  title={`${grant.workspaceId} / ${grant.action}`}
                >
                  {grant.workspaceId} / {grant.action}
                </span>
              ))}
            </div>
          </section>
          <div className="dialog-actions">
            <Button onClick={() => onOpenChange(false)} type="button" variant="primary">
              Done
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function CredentialTableRow({
  credential,
  onDetails,
  onRevoke,
}: {
  readonly credential: DashboardCredentialSummary;
  readonly onDetails: () => void;
  readonly onRevoke: () => void;
}) {
  const status = useManagedStatus(credential.revokedAt, credential.expiresAt);
  return (
    <Table.Row>
      <Table.Cell>
        <div className="credential-identity">
          <strong>{credential.actorName}</strong>
          <code title={credential.credentialId}>{credential.credentialId}</code>
        </div>
      </Table.Cell>
      <Table.Cell>
        <div className="grant-list">
          {credential.grants.map((grant) => (
            <span
              key={`${grant.workspaceId}:${grant.action}`}
              title={`${grant.workspaceId} / ${grant.action}`}
            >
              {grant.workspaceId} / {grant.action}
            </span>
          ))}
        </div>
      </Table.Cell>
      <Table.Cell>{dateTime(credential.lastUsedAt)}</Table.Cell>
      <Table.Cell>{dateTime(credential.expiresAt)}</Table.Cell>
      <Table.Cell>
        <span className={status === 'Active' ? 'credential-status' : 'credential-status is-muted'}>
          {status}
        </span>
      </Table.Cell>
      <Table.Cell>
        <CredentialActions
          active={status === 'Active'}
          credential={credential}
          onDetails={onDetails}
          onRevoke={onRevoke}
        />
      </Table.Cell>
    </Table.Row>
  );
}

function CredentialMobileRow({
  credential,
  onDetails,
  onRevoke,
}: {
  readonly credential: DashboardCredentialSummary;
  readonly onDetails: () => void;
  readonly onRevoke: () => void;
}) {
  const status = useManagedStatus(credential.revokedAt, credential.expiresAt);
  return (
    <li className="credential-mobile-row">
      <div className="credential-identity">
        <strong>{credential.actorName}</strong>
        <code title={credential.credentialId}>{credential.credentialId}</code>
      </div>
      <span className={status === 'Active' ? 'credential-status' : 'credential-status is-muted'}>
        {status}
      </span>
      <CredentialActions
        active={status === 'Active'}
        credential={credential}
        onDetails={onDetails}
        onRevoke={onRevoke}
      />
    </li>
  );
}

function RevokeCredentialDialog({
  credential,
  onOpenChange,
}: {
  readonly credential: DashboardCredentialSummary | undefined;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const close = (open: boolean) => {
    if (!open && busy) return;
    if (!open) setError(undefined);
    onOpenChange(open);
  };
  const revoke = async () => {
    if (credential === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      await revokeDashboardCredential(credential.credentialId);
      onOpenChange(false);
      void revalidator.revalidate();
    } catch (caught) {
      setError(caught instanceof DashboardApiError ? caught.message : 'Revocation failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      canClose={!busy}
      description="The token stops authenticating immediately. Existing artifacts and provenance stay intact."
      onOpenChange={close}
      open={credential !== undefined}
      title={credential === undefined ? 'Revoke credential' : `Revoke ${credential.actorName}?`}
    >
      <div className="dialog-form">
        {error === undefined ? null : (
          <Banner
            description={error}
            role="alert"
            size="sm"
            title="Credential wasn't revoked"
            variant="error"
          />
        )}
        <div className="dialog-actions">
          <Button disabled={busy} onClick={() => close(false)} type="button">
            Cancel
          </Button>
          <Button
            disabled={busy}
            loading={busy}
            onClick={() => void revoke()}
            type="button"
            variant="destructive"
          >
            {busy ? 'Revoking…' : 'Revoke credential'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function AccessPage() {
  const page = useLoaderData() as DashboardCredentialPage;
  const session = useRouteLoaderData('dashboard') as DashboardSession;
  const [issueOpen, setIssueOpen] = useState(false);
  const [detailsCredential, setDetailsCredential] = useState<DashboardCredentialSummary>();
  const [revokeCredential, setRevokeCredential] = useState<DashboardCredentialSummary>();
  return (
    <div className="dashboard-page access-page">
      <header className="page-heading">
        <div>
          <h1>Access</h1>
          <p>Scoped credentials for CLI and non-interactive agent workflows.</p>
        </div>
        <Button
          disabled={session.workspaces.length === 0}
          onClick={() => setIssueOpen(true)}
          type="button"
          variant="primary"
        >
          Issue credential
        </Button>
      </header>
      <Banner
        className="access-principle"
        description="Issue only the workspace actions an agent needs. Shelf stores a one-way digest and never returns token material in this ledger."
        size="sm"
        title="Tokens are reveal-once"
        variant="secondary"
      />
      {page.items.length === 0 ? (
        <Empty
          className="credential-empty"
          description="Create one only when a CLI or agent needs scoped workspace access."
          size="sm"
          title="No access credentials"
        />
      ) : (
        <>
          <div className="credential-table-shell">
            <Table aria-label="Access credentials" className="credential-table" layout="fixed">
              <colgroup>
                <col className="credential-column-identity" />
                <col className="credential-column-grants" />
                <col className="credential-column-date" />
                <col className="credential-column-date" />
                <col className="credential-column-status" />
                <col className="credential-column-action" />
              </colgroup>
              <Table.Header variant="compact">
                <Table.Row>
                  <Table.Head>Identity</Table.Head>
                  <Table.Head>Grants</Table.Head>
                  <Table.Head>Last used</Table.Head>
                  <Table.Head>Expires</Table.Head>
                  <Table.Head>Status</Table.Head>
                  <Table.Head>
                    <span className="visually-hidden">Actions</span>
                  </Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {page.items.map((credential) => (
                  <CredentialTableRow
                    credential={credential}
                    key={credential.credentialId}
                    onDetails={() => setDetailsCredential(credential)}
                    onRevoke={() => setRevokeCredential(credential)}
                  />
                ))}
              </Table.Body>
            </Table>
          </div>
          <ul aria-label="Access credentials" className="credential-mobile-list">
            {page.items.map((credential) => (
              <CredentialMobileRow
                credential={credential}
                key={credential.credentialId}
                onDetails={() => setDetailsCredential(credential)}
                onRevoke={() => setRevokeCredential(credential)}
              />
            ))}
          </ul>
        </>
      )}
      {page.nextCursor === null ? null : (
        <footer className="pagination">
          <Link className="control" to={`?cursor=${encodeURIComponent(page.nextCursor)}`}>
            Next page
          </Link>
        </footer>
      )}
      <IssueCredentialDialog onOpenChange={setIssueOpen} open={issueOpen} session={session} />
      <CredentialDetailsDialog
        credential={detailsCredential}
        onOpenChange={(open) => {
          if (!open) setDetailsCredential(undefined);
        }}
      />
      <RevokeCredentialDialog
        credential={revokeCredential}
        onOpenChange={(open) => {
          if (!open) setRevokeCredential(undefined);
        }}
      />
    </div>
  );
}
