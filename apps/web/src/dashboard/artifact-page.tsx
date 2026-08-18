import { Button } from '@cloudflare/kumo/components/button';
import { ClipboardText } from '@cloudflare/kumo/components/clipboard-text';
import { DropdownMenu } from '@cloudflare/kumo/components/dropdown';
import { Input } from '@cloudflare/kumo/components/input';
import { Radio } from '@cloudflare/kumo/components/radio';
import { Select } from '@cloudflare/kumo/components/select';
import { Tabs } from '@cloudflare/kumo/components/tabs';
import { DotsThreeIcon } from '@phosphor-icons/react/DotsThree';
import { LinkIcon } from '@phosphor-icons/react/Link';
import { PencilSimpleIcon } from '@phosphor-icons/react/PencilSimple';
import { ShareNetworkIcon } from '@phosphor-icons/react/ShareNetwork';
import type {
  ArtifactRevision,
  RevisionComparison,
  ShareManagementSummary,
} from '@shelf/contracts';
import { type FormEvent, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { Link, useLoaderData, useRevalidator, useSearchParams } from 'react-router';

import { formatBytes } from '../components/format.js';
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
import './artifact.css';

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function dateTime(value: string): string {
  return dateTimeFormatter.format(new Date(value));
}

function revisionLabel(revision: ArtifactRevision): string {
  return revision.kind === 'file' ? revision.originalFileName : revision.rootName;
}

const inspectorPanels = ['history', 'details', 'compare', 'links'] as const;
type InspectorPanel = (typeof inspectorPanels)[number];

function inspectorPanel(value: string | null): InspectorPanel {
  return inspectorPanels.includes(value as InspectorPanel) ? (value as InspectorPanel) : 'history';
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
        <Input
          label="Display name"
          maxLength={255}
          onChange={(event) => setName(event.currentTarget.value)}
          ref={nameRef}
          required
          value={name}
        />
        {error === undefined ? null : <p className="form-error">{error}</p>}
        <div className="dialog-actions">
          <Button disabled={busy} onClick={() => onOpenChange(false)} type="button">
            Cancel
          </Button>
          <Button disabled={busy} loading={busy} type="submit" variant="primary">
            {busy ? 'Saving…' : 'Save name'}
          </Button>
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
          <Button disabled={busy} onClick={close} type="button">
            Cancel
          </Button>
          <Button disabled={busy} loading={busy} onClick={restore} type="button" variant="primary">
            {busy ? 'Restoring…' : 'Restore as latest'}
          </Button>
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
          <Radio.Group
            className="choice-group"
            legend="Link target"
            name="share-mode"
            onValueChange={(value) => setMode(value)}
            value={mode}
          >
            <Radio.Item
              label={
                <span>
                  <strong>Latest</strong>
                  <small>Follows the artifact as new revisions arrive.</small>
                </span>
              }
              value="latest"
            />
            <Radio.Item
              label={
                <span>
                  <strong>Pinned</strong>
                  <small>Always opens one exact immutable revision.</small>
                </span>
              }
              value="pinned"
            />
          </Radio.Group>
          {mode === 'pinned' ? (
            <Select<string>
              label="Revision"
              onValueChange={(value) => setRevisionId(value ?? '')}
              value={revisionId}
            >
              {revisions.map((revision) => (
                <Select.Option key={revision.revisionId} value={revision.revisionId}>
                  r{revision.revisionNumber} — {revisionLabel(revision)}
                </Select.Option>
              ))}
            </Select>
          ) : null}
          <Input
            label="Expires"
            onChange={(event) => setExpiresAt(event.currentTarget.value)}
            required={false}
            type="datetime-local"
            value={expiresAt}
          />
          {error === undefined ? null : <p className="form-error">{error}</p>}
          <div className="dialog-actions">
            <Button disabled={busy} onClick={() => close(false)} type="button">
              Cancel
            </Button>
            <Button disabled={busy} loading={busy} type="submit" variant="primary">
              {busy ? 'Creating…' : 'Create link'}
            </Button>
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
            <Button onClick={() => close(false)} type="button" variant="primary">
              Done
            </Button>
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
    return (
      <p className="section-empty">
        At least two revisions on the loaded history page are needed to compare.
      </p>
    );
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
        <Select<string>
          className="compact-field"
          disabled={busy}
          label="Base"
          onValueChange={(value) => {
            setBase(value ?? '');
            setComparison(undefined);
          }}
          size="sm"
          value={base}
        >
          {revisions.map((revision) => (
            <Select.Option key={revision.revisionId} value={revision.revisionId}>
              r{revision.revisionNumber}
            </Select.Option>
          ))}
        </Select>
        <Select<string>
          className="compact-field"
          disabled={busy}
          label="Target"
          onValueChange={(value) => {
            setTarget(value ?? '');
            setComparison(undefined);
          }}
          size="sm"
          value={target}
        >
          {revisions.map((revision) => (
            <Select.Option key={revision.revisionId} value={revision.revisionId}>
              r{revision.revisionNumber}
            </Select.Option>
          ))}
        </Select>
        <Button
          disabled={busy || base === target}
          loading={busy}
          onClick={run}
          size="sm"
          type="button"
        >
          {busy ? 'Comparing…' : 'Compare'}
        </Button>
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
            <Button disabled={busy} loading={busy} onClick={loadMore} size="sm" type="button">
              {busy ? 'Loading…' : 'Load more changes'}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function ShareRow({ share }: { readonly share: ShareManagementSummary }) {
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
      await revokeShare(share.workspaceId, share.shareId);
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
      <div className="share-row-identity">
        <strong>{share.target.mode === 'latest' ? 'Latest link' : 'Pinned link'}</strong>
        <code>{share.shareId}</code>
      </div>
      <span className="ledger-status" data-active={active}>
        {status}
      </span>
      <time dateTime={share.createdAt}>{dateTime(share.createdAt)}</time>
      {active ? (
        <Button
          className="quiet-button danger-text"
          onClick={() => setConfirming(true)}
          size="sm"
          type="button"
          variant="ghost"
        >
          Revoke
        </Button>
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
            <Button disabled={busy} onClick={() => setConfirming(false)} type="button">
              Cancel
            </Button>
            <Button
              disabled={busy}
              loading={busy}
              onClick={revoke}
              type="button"
              variant="destructive"
            >
              {busy ? 'Revoking…' : 'Revoke link'}
            </Button>
          </div>
        </div>
      </Modal>
    </li>
  );
}

export function ArtifactPage() {
  const payload = useLoaderData() as ArtifactDetailPayload;
  const { artifact, history } = payload;
  const [searchParams, setSearchParams] = useSearchParams();
  const [renameOpen, setRenameOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [restoreRevision, setRestoreRevision] = useState<ArtifactRevision | null>(null);
  const activePanel = inspectorPanel(searchParams.get('panel'));
  const artifactShares = useMemo(
    () => payload.shares.items.filter((share) => share.artifactId === artifact.artifactId),
    [artifact.artifactId, payload.shares.items],
  );
  const selectPanel = (panel: InspectorPanel) => {
    const next = new URLSearchParams(searchParams);
    if (panel === 'history') next.delete('panel');
    else next.set('panel', panel);
    setSearchParams(next, { defaultShouldRevalidate: false, replace: true });
  };
  const pageLink = (name: 'historyCursor' | 'shareCursor', cursor: string): string => {
    const next = new URLSearchParams(searchParams);
    next.set(name, cursor);
    return `?${next}`;
  };
  const latest = artifact.latestRevision;

  return (
    <div className="dashboard-page artifact-detail">
      <header className="artifact-heading artifact-map-bar">
        <nav aria-label="Artifact location" className="artifact-breadcrumbs">
          <Link className="wordmark" to="/app">
            shelf
          </Link>
          <span aria-hidden="true">/</span>
          <span className="artifact-workspace" title={artifact.workspaceId}>
            {artifact.workspaceId}
          </span>
          <span aria-hidden="true">/</span>
          <Link to={`/app/w/${encodeURIComponent(artifact.workspaceId)}/artifacts`}>Artifacts</Link>
          <span aria-hidden="true">/</span>
          <h1 title={artifact.name}>{artifact.name}</h1>
        </nav>
        <div className="heading-actions">
          <Button
            className="artifact-share-action"
            icon={ShareNetworkIcon}
            onClick={() => setShareOpen(true)}
            size="sm"
            type="button"
            variant="primary"
          >
            Share
          </Button>
          <DropdownMenu>
            <DropdownMenu.Trigger
              render={
                <Button
                  aria-label="Artifact actions"
                  className="artifact-actions-trigger"
                  icon={DotsThreeIcon}
                  shape="square"
                  size="sm"
                  variant="secondary"
                />
              }
            />
            <DropdownMenu.Content align="end" className="artifact-actions-menu">
              <DropdownMenu.Item icon={PencilSimpleIcon} onClick={() => setRenameOpen(true)}>
                Rename
              </DropdownMenu.Item>
              <DropdownMenu.Item icon={LinkIcon} onClick={() => selectPanel('links')}>
                Manage links
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item onClick={() => selectPanel('compare')}>
                Compare revisions
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu>
        </div>
      </header>

      <Group
        className="artifact-workbench"
        id="artifact-workbench"
        orientation="horizontal"
        style={{ height: 'min(760px, calc(100dvh - 148px))' }}
      >
        <Panel
          className="artifact-preview-panel"
          defaultSize="70%"
          id="artifact-preview"
          minSize={480}
        >
          <section className="managed-stage" aria-labelledby="preview-heading">
            <header className="managed-stage-bar">
              <span id="preview-heading">Artifact preview</span>
              <span>
                r{latest.revisionNumber} · {formatBytes(latest.byteCount)} · {revisionLabel(latest)}
              </span>
            </header>
            <ManagedArtifactContent
              artifact={artifact}
              bytes={payload.bytes}
              entries={payload.entries}
            />
          </section>
        </Panel>

        <Separator className="artifact-resize-handle" id="artifact-inspector-resize">
          <span aria-hidden="true" />
        </Separator>

        <Panel
          className="artifact-inspector-panel"
          defaultSize={340}
          groupResizeBehavior="preserve-pixel-size"
          id="artifact-inspector"
          maxSize={360}
          minSize={300}
        >
          <aside aria-label="Artifact inspector" className="artifact-inspector">
            <Tabs
              activateOnFocus={false}
              className="artifact-inspector-tabs"
              onValueChange={(value) => selectPanel(inspectorPanel(value))}
              size="sm"
              tabs={[
                { value: 'history', label: 'History' },
                { value: 'details', label: 'Details' },
                { value: 'compare', label: 'Compare' },
                { value: 'links', label: 'Links' },
              ]}
              value={activePanel}
              variant="underline"
            />

            <div className="artifact-inspector-content">
              {activePanel === 'history' ? (
                <section aria-labelledby="history-panel-heading" className="inspector-section">
                  <header className="inspector-section-heading">
                    <div>
                      <p className="inspector-kicker">Immutable lineage</p>
                      <h2 id="history-panel-heading">Revision history</h2>
                    </div>
                    <span>{history.nextCursor === null ? 'Newest first' : 'More available'}</span>
                  </header>
                  <ol className="revision-list">
                    {history.items.map((revision) => (
                      <li className="revision-row" key={revision.revisionId}>
                        <span className="revision-index">r{revision.revisionNumber}</span>
                        <div className="revision-copy">
                          <strong>{revisionLabel(revision)}</strong>
                          <span>{dateTime(revision.createdAt)}</span>
                          <code title={revision.revisionId}>{revision.revisionId}</code>
                        </div>
                        {revision.revisionId === latest.revisionId ? (
                          <span className="ledger-status" data-active="true">
                            Latest
                          </span>
                        ) : (
                          <Button
                            className="quiet-button"
                            onClick={() => setRestoreRevision(revision)}
                            size="sm"
                            type="button"
                            variant="ghost"
                          >
                            Restore
                          </Button>
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
              ) : null}

              {activePanel === 'details' ? (
                <section aria-labelledby="details-panel-heading" className="inspector-section">
                  <header className="inspector-section-heading">
                    <div>
                      <p className="inspector-kicker">Latest immutable state</p>
                      <h2 id="details-panel-heading">Details</h2>
                    </div>
                  </header>
                  <dl className="artifact-detail-ledger">
                    <div>
                      <dt>Artifact ID</dt>
                      <dd>
                        <ClipboardText
                          labels={{ copyAction: 'Copy artifact ID' }}
                          size="sm"
                          text={artifact.artifactId}
                        />
                      </dd>
                    </div>
                    <div>
                      <dt>Revision ID</dt>
                      <dd>
                        <ClipboardText
                          labels={{ copyAction: 'Copy revision ID' }}
                          size="sm"
                          text={latest.revisionId}
                        />
                      </dd>
                    </div>
                    <div>
                      <dt>Content hash</dt>
                      <dd>
                        <ClipboardText
                          labels={{ copyAction: 'Copy content hash' }}
                          size="sm"
                          text={latest.contentHash}
                        />
                      </dd>
                    </div>
                    <div>
                      <dt>Source</dt>
                      <dd>{revisionLabel(latest)}</dd>
                    </div>
                    <div>
                      <dt>Kind</dt>
                      <dd>{latest.kind}</dd>
                    </div>
                    {latest.kind === 'file' ? (
                      <div>
                        <dt>Media type</dt>
                        <dd>{latest.mediaType}</dd>
                      </div>
                    ) : null}
                    <div>
                      <dt>Size</dt>
                      <dd>{formatBytes(latest.byteCount)}</dd>
                    </div>
                    <div>
                      <dt>Files</dt>
                      <dd>{latest.fileCount}</dd>
                    </div>
                    <div>
                      <dt>Published</dt>
                      <dd>{dateTime(latest.createdAt)}</dd>
                    </div>
                    <div>
                      <dt>Provenance</dt>
                      <dd>{latest.provenance.classification}</dd>
                    </div>
                  </dl>
                </section>
              ) : null}

              {activePanel === 'compare' ? (
                <section aria-labelledby="compare-panel-heading" className="inspector-section">
                  <header className="inspector-section-heading">
                    <div>
                      <p className="inspector-kicker">Immutable descriptors</p>
                      <h2 id="compare-panel-heading">Compare revisions</h2>
                    </div>
                  </header>
                  <ComparisonPanel revisions={history.items} />
                </section>
              ) : null}

              {activePanel === 'links' ? (
                <section aria-labelledby="links-panel-heading" className="inspector-section">
                  <header className="inspector-section-heading">
                    <div>
                      <p className="inspector-kicker">Unlisted access</p>
                      <h2 id="links-panel-heading">Share links</h2>
                    </div>
                    <Button onClick={() => setShareOpen(true)} size="sm" variant="secondary">
                      New link
                    </Button>
                  </header>
                  {artifactShares.length === 0 ? (
                    <p className="section-empty">
                      {payload.shares.nextCursor === null
                        ? 'No share links for this artifact.'
                        : 'No links for this artifact on this loaded page.'}
                    </p>
                  ) : (
                    <ul className="share-list">
                      {artifactShares.map((share) => (
                        <ShareRow key={share.shareId} share={share} />
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
              ) : null}
            </div>
          </aside>
        </Panel>
      </Group>

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
