import type {
  ArtifactRevision,
  RevisionComparison,
  ShareManagementSummary,
} from '@shelf/contracts';
import { type FormEvent, useMemo, useRef, useState } from 'react';
import { Link, useLoaderData, useRevalidator, useSearchParams } from 'react-router';

import { formatBytes } from '../components/artifact-content.js';
import {
  compareRevisions,
  createArtifactShare,
  DashboardApiError,
  renameArtifact,
  restoreArtifact,
  revokeShare,
} from './api.js';
import { Modal, SecretReveal } from './dialogs.js';
import { ManagedArtifactContent } from './managed-artifact-content.js';
import type { ArtifactDetailPayload } from './routes.js';
import { useManagedStatus } from './status.js';

function dateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function revisionLabel(revision: ArtifactRevision): string {
  return revision.kind === 'file' ? revision.originalFileName : revision.rootName;
}

function RenameDialog({
  artifactId,
  currentName,
  open,
  onOpenChange,
}: {
  readonly artifactId: string;
  readonly currentName: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const revalidator = useRevalidator();
  const [name, setName] = useState(currentName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const nameRef = useRef<HTMLInputElement>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await renameArtifact(artifactId, name);
      onOpenChange(false);
      void revalidator.revalidate();
    } catch (caught) {
      setError(caught instanceof DashboardApiError ? caught.message : 'Rename failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      canClose={!busy}
      description="Changes the display name only. Immutable revisions stay untouched."
      initialFocus={nameRef}
      onOpenChange={onOpenChange}
      open={open}
      title="Rename artifact"
    >
      <form className="dialog-form" onSubmit={submit}>
        <label className="field">
          <span className="field-label">Display name</span>
          <input
            maxLength={255}
            onChange={(event) => setName(event.currentTarget.value)}
            ref={nameRef}
            required
            value={name}
          />
        </label>
        {error === undefined ? null : <p className="form-error">{error}</p>}
        <div className="dialog-actions">
          <button
            className="control"
            disabled={busy}
            onClick={() => onOpenChange(false)}
            type="button"
          >
            Cancel
          </button>
          <button className="control control-primary" disabled={busy} type="submit">
            {busy ? 'Saving…' : 'Save name'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RestoreDialog({
  workspaceId,
  artifactId,
  revision,
  onClose,
}: {
  readonly workspaceId: string;
  readonly artifactId: string;
  readonly revision: ArtifactRevision | null;
  readonly onClose: () => void;
}) {
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const idempotencyRef = useRef<{ revisionId: string; key: string } | undefined>(undefined);
  const close = () => {
    if (busy) return;
    idempotencyRef.current = undefined;
    onClose();
  };
  const restore = async () => {
    if (revision === null) return;
    setBusy(true);
    setError(undefined);
    try {
      if (idempotencyRef.current?.revisionId !== revision.revisionId) {
        idempotencyRef.current = { revisionId: revision.revisionId, key: crypto.randomUUID() };
      }
      await restoreArtifact(
        workspaceId,
        artifactId,
        revision.revisionId,
        idempotencyRef.current.key,
      );
      idempotencyRef.current = undefined;
      onClose();
      void revalidator.revalidate();
    } catch (caught) {
      setError(caught instanceof DashboardApiError ? caught.message : 'Restore failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      canClose={!busy}
      description="Shelf creates a new latest revision. Existing history remains immutable."
      onOpenChange={(open) => {
        if (!open) close();
      }}
      open={revision !== null}
      title={revision === null ? 'Restore revision' : `Restore r${revision.revisionNumber}`}
    >
      <div className="dialog-form">
        <div className="confirmation-block">
          <span>Source</span>
          <strong>{revision === null ? '' : revisionLabel(revision)}</strong>
          <code>{revision?.revisionId}</code>
        </div>
        {error === undefined ? null : <p className="form-error">{error}</p>}
        <div className="dialog-actions">
          <button className="control" disabled={busy} onClick={close} type="button">
            Cancel
          </button>
          <button
            className="control control-primary"
            disabled={busy}
            onClick={restore}
            type="button"
          >
            {busy ? 'Restoring…' : 'Restore as latest'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ShareDialog({
  workspaceId,
  artifactId,
  revisions,
  open,
  onOpenChange,
}: {
  readonly workspaceId: string;
  readonly artifactId: string;
  readonly revisions: readonly ArtifactRevision[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const revalidator = useRevalidator();
  const [mode, setMode] = useState<'latest' | 'pinned'>('latest');
  const [revisionId, setRevisionId] = useState(revisions[0]?.revisionId ?? '');
  const [expiresAt, setExpiresAt] = useState('');
  const [shareUrl, setShareUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const idempotencyRef = useRef<{ intent: string; key: string } | undefined>(undefined);
  const close = (next: boolean) => {
    if (!next && busy) return;
    if (!next) {
      setShareUrl(undefined);
      setError(undefined);
      idempotencyRef.current = undefined;
    }
    onOpenChange(next);
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const target = mode === 'latest' ? { mode } : { mode, revisionId };
      const expiry = expiresAt === '' ? null : new Date(expiresAt).toISOString();
      const intent = JSON.stringify({ target, expiresAt: expiry });
      if (idempotencyRef.current?.intent !== intent) {
        idempotencyRef.current = { intent, key: crypto.randomUUID() };
      }
      const result = await createArtifactShare(
        workspaceId,
        artifactId,
        target,
        expiry,
        idempotencyRef.current.key,
      );
      idempotencyRef.current = undefined;
      setShareUrl(new URL(result.url, window.location.origin).href);
      void revalidator.revalidate();
    } catch (caught) {
      setError(caught instanceof DashboardApiError ? caught.message : 'Share creation failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      canClose={!busy}
      description="Anyone with the generated capability link can open this unlisted artifact."
      onOpenChange={close}
      open={open}
      title="Create share link"
    >
      {shareUrl === undefined ? (
        <form className="dialog-form" onSubmit={create}>
          <fieldset className="choice-group">
            <legend className="field-label">Link target</legend>
            <label>
              <input
                checked={mode === 'latest'}
                name="share-mode"
                onChange={() => setMode('latest')}
                type="radio"
              />
              <span>
                <strong>Latest</strong>
                <small>Follows the artifact as new revisions arrive.</small>
              </span>
            </label>
            <label>
              <input
                checked={mode === 'pinned'}
                name="share-mode"
                onChange={() => setMode('pinned')}
                type="radio"
              />
              <span>
                <strong>Pinned</strong>
                <small>Always opens one exact immutable revision.</small>
              </span>
            </label>
          </fieldset>
          {mode === 'pinned' ? (
            <label className="field">
              <span className="field-label">Revision</span>
              <select
                value={revisionId}
                onChange={(event) => setRevisionId(event.currentTarget.value)}
              >
                {revisions.map((revision) => (
                  <option key={revision.revisionId} value={revision.revisionId}>
                    r{revision.revisionNumber} — {revisionLabel(revision)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="field">
            <span className="field-label">Expires (optional)</span>
            <input
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
              {busy ? 'Creating…' : 'Create link'}
            </button>
          </div>
        </form>
      ) : (
        <div className="dialog-form">
          <SecretReveal
            hint="Copy this now. Shelf never includes the capability in share listings."
            label="Share URL"
            value={shareUrl}
          />
          <div className="dialog-actions">
            <button className="control control-primary" onClick={() => close(false)} type="button">
              Done
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function ComparisonPanel({ revisions }: { readonly revisions: readonly ArtifactRevision[] }) {
  const [base, setBase] = useState(revisions[1]?.revisionId ?? revisions[0]?.revisionId ?? '');
  const [target, setTarget] = useState(revisions[0]?.revisionId ?? '');
  const [comparison, setComparison] = useState<{
    base: string;
    target: string;
    value: RevisionComparison;
  }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  if (revisions.length < 2) {
    return <p className="section-empty">Publish another revision to compare immutable states.</p>;
  }
  const run = async () => {
    const requested = { base, target };
    setBusy(true);
    setError(undefined);
    try {
      setComparison({ ...requested, value: await compareRevisions(base, target) });
    } catch (caught) {
      setError(caught instanceof DashboardApiError ? caught.message : 'Comparison failed.');
    } finally {
      setBusy(false);
    }
  };
  const loadMore = async () => {
    if (comparison?.value.kind !== 'folder' || comparison.value.nextCursor === null) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await compareRevisions(
        comparison.base,
        comparison.target,
        comparison.value.nextCursor,
      );
      if (next.kind !== 'folder') throw new Error('Comparison kind changed.');
      setComparison({
        ...comparison,
        value: { ...next, items: [...comparison.value.items, ...next.items] },
      });
    } catch (caught) {
      setError(caught instanceof DashboardApiError ? caught.message : 'Comparison failed.');
    } finally {
      setBusy(false);
    }
  };
  const visibleComparison =
    comparison?.base === base && comparison.target === target ? comparison.value : undefined;
  return (
    <div className="comparison-panel">
      <div className="comparison-controls">
        <label className="field compact-field">
          <span className="field-label">Base</span>
          <select
            disabled={busy}
            value={base}
            onChange={(event) => {
              setBase(event.currentTarget.value);
              setComparison(undefined);
            }}
          >
            {revisions.map((revision) => (
              <option key={revision.revisionId} value={revision.revisionId}>
                r{revision.revisionNumber}
              </option>
            ))}
          </select>
        </label>
        <label className="field compact-field">
          <span className="field-label">Target</span>
          <select
            disabled={busy}
            value={target}
            onChange={(event) => {
              setTarget(event.currentTarget.value);
              setComparison(undefined);
            }}
          >
            {revisions.map((revision) => (
              <option key={revision.revisionId} value={revision.revisionId}>
                r{revision.revisionNumber}
              </option>
            ))}
          </select>
        </label>
        <button className="control" disabled={busy || base === target} onClick={run} type="button">
          {busy ? 'Comparing…' : 'Compare'}
        </button>
      </div>
      {error === undefined ? null : <p className="form-error">{error}</p>}
      {visibleComparison === undefined ? null : visibleComparison.kind === 'file' ? (
        <div className="comparison-result">
          <strong>
            {visibleComparison.status === 'changed' ? 'File changed' : 'No descriptor change'}
          </strong>
          <ul>
            <li data-changed={visibleComparison.changes.content}>Content</li>
            <li data-changed={visibleComparison.changes.mediaType}>Media type</li>
            <li data-changed={visibleComparison.changes.originalFileName}>Original filename</li>
          </ul>
        </div>
      ) : (
        <div className="comparison-result">
          <div className="comparison-summary">
            <span>+{visibleComparison.summary.added} added</span>
            <span>−{visibleComparison.summary.removed} removed</span>
            <span>{visibleComparison.summary.changed} changed</span>
            <span>{visibleComparison.summary.moved} moved</span>
          </div>
          <ul className="change-list">
            {visibleComparison.items.map((item) => (
              <li
                key={
                  item.status === 'moved'
                    ? `${item.fromPath}:${item.toPath}`
                    : `${item.status}:${item.path}`
                }
              >
                <span data-change={item.status}>{item.status}</span>
                <code>
                  {item.status === 'moved' ? `${item.fromPath} → ${item.toPath}` : item.path}
                </code>
              </li>
            ))}
          </ul>
          {visibleComparison.nextCursor === null ? null : (
            <button className="control" disabled={busy} onClick={loadMore} type="button">
              {busy ? 'Loading…' : 'Load more changes'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ShareRow({
  share,
  workspaceId,
}: {
  readonly share: ShareManagementSummary;
  readonly workspaceId: string;
}) {
  const revalidator = useRevalidator();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const status = useManagedStatus(share.revokedAt, share.expiresAt);
  const active = status === 'Active';
  const revoke = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await revokeShare(workspaceId, share.shareId);
      setConfirming(false);
      void revalidator.revalidate();
    } catch (caught) {
      setError(caught instanceof DashboardApiError ? caught.message : 'Share revocation failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="share-row">
      <div>
        <strong>{share.target.mode === 'latest' ? 'Latest link' : 'Pinned link'}</strong>
        <code>{share.shareId}</code>
      </div>
      <span className={active ? 'status-pill' : 'status-pill is-muted'}>{status}</span>
      <time dateTime={share.createdAt}>{dateTime(share.createdAt)}</time>
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
        description="The capability link will stop resolving immediately. The artifact and revisions remain."
        onOpenChange={setConfirming}
        open={confirming}
        title="Revoke share link?"
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
              {busy ? 'Revoking…' : 'Revoke link'}
            </button>
          </div>
        </div>
      </Modal>
    </li>
  );
}

export function ArtifactPage() {
  const payload = useLoaderData() as ArtifactDetailPayload;
  const { artifact, history } = payload;
  const [searchParams] = useSearchParams();
  const [renameOpen, setRenameOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [restoreRevision, setRestoreRevision] = useState<ArtifactRevision | null>(null);
  const artifactShares = useMemo(
    () => payload.shares.items.filter((share) => share.artifactId === artifact.artifactId),
    [artifact.artifactId, payload.shares.items],
  );
  const pageLink = (name: 'historyCursor' | 'shareCursor', cursor: string): string => {
    const next = new URLSearchParams(searchParams);
    next.set(name, cursor);
    return `?${next}`;
  };

  return (
    <div className="dashboard-page artifact-detail">
      <header className="artifact-heading">
        <div className="artifact-heading-copy">
          <Link
            className="back-link"
            to={`/app/w/${encodeURIComponent(artifact.workspaceId)}/artifacts`}
          >
            Artifacts
          </Link>
          <p className="eyebrow">{artifact.kind} artifact</p>
          <h1>{artifact.name}</h1>
          <div className="artifact-facts">
            <span>r{artifact.latestRevision.revisionNumber}</span>
            <span>{formatBytes(artifact.latestRevision.byteCount)}</span>
            <span>{artifact.latestRevision.contentHash.slice(0, 19)}…</span>
          </div>
        </div>
        <div className="heading-actions">
          <button className="control" onClick={() => setRenameOpen(true)} type="button">
            Rename
          </button>
          <button
            className="control control-primary"
            onClick={() => setShareOpen(true)}
            type="button"
          >
            Share
          </button>
        </div>
      </header>

      <section className="managed-stage" aria-labelledby="preview-heading">
        <header className="managed-stage-bar">
          <div>
            <span className="trust-dot" aria-hidden="true" />
            <span id="preview-heading">User-generated content</span>
          </div>
          <span>{revisionLabel(artifact.latestRevision)} · latest</span>
        </header>
        <ManagedArtifactContent
          artifact={artifact}
          bytes={payload.bytes}
          entries={payload.entries}
        />
      </section>

      <div className="artifact-management-grid">
        <section className="utility-section revision-section">
          <header className="section-heading">
            <div>
              <p className="eyebrow">Immutable history</p>
              <h2>Revisions</h2>
            </div>
            <span>{history.items.length}</span>
          </header>
          <ol className="revision-list">
            {history.items.map((revision) => (
              <li key={revision.revisionId}>
                <span className="revision-index">r{revision.revisionNumber}</span>
                <div className="revision-copy">
                  <strong>{revisionLabel(revision)}</strong>
                  <span>{dateTime(revision.createdAt)}</span>
                  <code>{revision.revisionId}</code>
                </div>
                {revision.revisionId === artifact.latestRevision.revisionId ? (
                  <span className="status-pill">Latest</span>
                ) : (
                  <button
                    className="quiet-button"
                    onClick={() => setRestoreRevision(revision)}
                    type="button"
                  >
                    Restore
                  </button>
                )}
              </li>
            ))}
          </ol>
          {history.nextCursor === null ? null : (
            <Link
              className="control section-page-control"
              to={pageLink('historyCursor', history.nextCursor)}
            >
              Next history page
            </Link>
          )}
        </section>

        <section className="utility-section compare-section">
          <header className="section-heading">
            <div>
              <p className="eyebrow">Descriptor diff</p>
              <h2>Compare</h2>
            </div>
          </header>
          <ComparisonPanel revisions={history.items} />
        </section>

        <section className="utility-section share-section">
          <header className="section-heading">
            <div>
              <p className="eyebrow">Unlisted access</p>
              <h2>Share links</h2>
            </div>
            <button className="quiet-button" onClick={() => setShareOpen(true)} type="button">
              New link
            </button>
          </header>
          {artifactShares.length === 0 ? (
            <p className="section-empty">
              {payload.shares.nextCursor === null
                ? 'No share links for this artifact.'
                : 'No links for this artifact on this page.'}
            </p>
          ) : (
            <ul className="share-list">
              {artifactShares.map((share) => (
                <ShareRow key={share.shareId} share={share} workspaceId={artifact.workspaceId} />
              ))}
            </ul>
          )}
          {payload.shares.nextCursor === null ? null : (
            <Link
              className="control section-page-control"
              to={pageLink('shareCursor', payload.shares.nextCursor)}
            >
              Next share page
            </Link>
          )}
        </section>
      </div>

      <RenameDialog
        artifactId={artifact.artifactId}
        currentName={artifact.name}
        onOpenChange={setRenameOpen}
        open={renameOpen}
      />
      <RestoreDialog
        artifactId={artifact.artifactId}
        onClose={() => setRestoreRevision(null)}
        revision={restoreRevision}
        workspaceId={artifact.workspaceId}
      />
      <ShareDialog
        artifactId={artifact.artifactId}
        onOpenChange={setShareOpen}
        open={shareOpen}
        revisions={history.items}
        workspaceId={artifact.workspaceId}
      />
    </div>
  );
}
