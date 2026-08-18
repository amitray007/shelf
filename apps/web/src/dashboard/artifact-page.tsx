import { Button } from '@cloudflare/kumo/components/button';
import { ClipboardText } from '@cloudflare/kumo/components/clipboard-text';
import { Input } from '@cloudflare/kumo/components/input';
import { Tabs } from '@cloudflare/kumo/components/tabs';
import { PencilSimpleIcon } from '@phosphor-icons/react/PencilSimple';
import { ShareNetworkIcon } from '@phosphor-icons/react/ShareNetwork';
import { SidebarSimpleIcon } from '@phosphor-icons/react/SidebarSimple';
import { SortAscendingIcon } from '@phosphor-icons/react/SortAscending';
import { SortDescendingIcon } from '@phosphor-icons/react/SortDescending';
import { TrashIcon } from '@phosphor-icons/react/Trash';
import type { ArtifactRevision, ShareManagementSummary } from '@shelf/contracts';
import { type FormEvent, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { Link, useLoaderData, useNavigate, useRevalidator, useSearchParams } from 'react-router';

import { formatBytes } from '../components/format.js';
import { ordinal, revisionSourceName } from '../components/revision-label.js';
import { DashboardApiError, renameArtifact, restoreArtifact, revokeShare } from './api.js';
import { DeleteArtifactDialog } from './delete-artifact-dialog.js';
import { Modal } from './dialogs.js';
import { ManagedArtifactContent } from './managed-artifact-content.js';
import type { ArtifactDetailPayload } from './routes.js';
import { ShareDialog } from './share-dialog.js';
import { useManagedStatus } from './status.js';
import './artifact.css';

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function dateTime(value: string): string {
  return dateTimeFormatter.format(new Date(value));
}

const inspectorPanels = ['details', 'history', 'links'] as const;
type InspectorPanel = (typeof inspectorPanels)[number];

function inspectorPanel(value: string | null): InspectorPanel {
  return inspectorPanels.includes(value as InspectorPanel) ? (value as InspectorPanel) : 'details';
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
      title={
        revision === null
          ? 'Restore revision'
          : `Restore ${ordinal(revision.revisionNumber)} revision`
      }
    >
      <div className="dialog-form">
        <div className="confirmation-block">
          <span>Source</span>
          <strong>{revision === null ? '' : revisionSourceName(revision)}</strong>
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
      <header className="share-row-heading">
        <div>
          <strong>{share.target.mode === 'latest' ? 'Latest share' : 'Pinned share'}</strong>
          <span className="share-row-state" data-active={active}>
            <span aria-hidden="true" className="status-dot" />
            {status}
          </span>
        </div>
        <code title={share.shareId}>{share.shareId}</code>
      </header>
      <dl className="share-metadata">
        <div>
          <dt>Target</dt>
          <dd>
            {share.target.mode === 'latest' ? (
              'Latest revision'
            ) : (
              <code title={share.target.revisionId}>{share.target.revisionId}</code>
            )}
          </dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>
            <time dateTime={share.createdAt}>{dateTime(share.createdAt)}</time>
          </dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>
            {share.expiresAt === null ? (
              'Never'
            ) : (
              <time dateTime={share.expiresAt}>{dateTime(share.expiresAt)}</time>
            )}
          </dd>
        </div>
      </dl>
      {active ? (
        <footer className="share-row-actions">
          <Button
            className="danger-text"
            onClick={() => setConfirming(true)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Revoke link
          </Button>
        </footer>
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
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [renameOpen, setRenameOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(searchParams.has('panel'));
  const [restoreRevision, setRestoreRevision] = useState<ArtifactRevision | null>(null);
  const activePanel = inspectorPanel(searchParams.get('panel'));
  const historyOrder = searchParams.get('historyOrder') === 'oldest' ? 'oldest' : 'newest';
  const artifactShares = useMemo(
    () => payload.shares.items.filter((share) => share.artifactId === artifact.artifactId),
    [artifact.artifactId, payload.shares.items],
  );
  const selectPanel = (panel: InspectorPanel) => {
    const next = new URLSearchParams(searchParams);
    if (panel === 'details') next.delete('panel');
    else next.set('panel', panel);
    setInspectorOpen(true);
    setSearchParams(next, { defaultShouldRevalidate: false, replace: true });
  };
  const pageLink = (name: 'historyCursor' | 'shareCursor', cursor: string): string => {
    const next = new URLSearchParams(searchParams);
    next.set(name, cursor);
    return `?${next}`;
  };
  const toggleHistoryOrder = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('historyCursor');
    if (historyOrder === 'newest') next.set('historyOrder', 'oldest');
    else next.delete('historyOrder');
    setSearchParams(next, { replace: true });
  };
  const latest = artifact.latestRevision;

  return (
    <div className="dashboard-page artifact-detail">
      <header className="page-heading artifact-heading">
        <div className="artifact-title-row">
          <h1 title={artifact.name}>{artifact.name}</h1>
          <Button
            aria-label="Rename artifact"
            className="artifact-rename-action"
            icon={PencilSimpleIcon}
            onClick={() => setRenameOpen(true)}
            shape="square"
            size="sm"
            title="Rename artifact"
            type="button"
            variant="ghost"
          />
        </div>
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
          <Button
            className="artifact-delete-action"
            icon={TrashIcon}
            onClick={() => setDeleteOpen(true)}
            size="sm"
            type="button"
            variant="secondary"
          >
            Delete
          </Button>
        </div>
      </header>

      <Group
        className="artifact-workbench"
        id="artifact-workbench"
        orientation="horizontal"
        style={{ height: 'min(760px, calc(100dvh - 196px))' }}
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
              <div className="managed-stage-actions">
                <span>{ordinal(latest.revisionNumber)}</span>
                <Button
                  aria-label={inspectorOpen ? 'Hide inspector' : 'Show inspector'}
                  className="inspector-toggle"
                  icon={SidebarSimpleIcon}
                  onClick={() => setInspectorOpen((open) => !open)}
                  shape="square"
                  size="sm"
                  title={inspectorOpen ? 'Hide inspector' : 'Show inspector'}
                  type="button"
                  variant="ghost"
                />
              </div>
            </header>
            <ManagedArtifactContent
              artifact={artifact}
              bytes={payload.bytes}
              entries={payload.entries}
            />
          </section>
        </Panel>

        {inspectorOpen ? (
          <>
            <Separator className="artifact-resize-handle" id="artifact-inspector-resize">
              <span aria-hidden="true" />
            </Separator>

            <Panel
              className="artifact-inspector-panel"
              defaultSize={400}
              groupResizeBehavior="preserve-pixel-size"
              id="artifact-inspector"
              maxSize={460}
              minSize={340}
            >
              <aside aria-label="Artifact inspector" className="artifact-inspector">
                <header className="artifact-inspector-nav">
                  <Tabs
                    activateOnFocus={false}
                    className="artifact-inspector-tabs"
                    onValueChange={(value) => selectPanel(inspectorPanel(value))}
                    size="sm"
                    tabs={[
                      { value: 'details', label: 'Details' },
                      { value: 'history', label: 'History' },
                      { value: 'links', label: 'Links' },
                    ]}
                    value={activePanel}
                    variant="underline"
                  />
                  <Button
                    aria-label="Hide inspector"
                    className="inspector-hide-action"
                    icon={SidebarSimpleIcon}
                    onClick={() => setInspectorOpen(false)}
                    shape="square"
                    size="sm"
                    title="Hide inspector"
                    type="button"
                    variant="ghost"
                  />
                </header>

                <div className="artifact-inspector-content">
                  {activePanel === 'history' ? (
                    <section aria-labelledby="history-panel-heading" className="inspector-section">
                      <header className="inspector-section-heading">
                        <h2 id="history-panel-heading">Revision history</h2>
                        <Button
                          aria-label={
                            historyOrder === 'newest'
                              ? 'Revision order: newest first. Show oldest first'
                              : 'Revision order: oldest first. Show newest first'
                          }
                          className="history-sort-control"
                          icon={historyOrder === 'newest' ? SortDescendingIcon : SortAscendingIcon}
                          onClick={toggleHistoryOrder}
                          shape="square"
                          size="sm"
                          title={historyOrder === 'newest' ? 'Newest first' : 'Oldest first'}
                          type="button"
                          variant="ghost"
                        />
                      </header>
                      <ol className="revision-list">
                        {history.items.map((revision) => (
                          <li
                            className="revision-row"
                            data-current={revision.revisionId === latest.revisionId}
                            key={revision.revisionId}
                          >
                            <header className="revision-row-heading">
                              <strong className="revision-index">
                                {ordinal(revision.revisionNumber)}
                              </strong>
                              {revision.revisionId === latest.revisionId ? (
                                <span className="ledger-status" data-active="true">
                                  <span aria-hidden="true" className="status-dot" />
                                  Latest
                                </span>
                              ) : (
                                <Button
                                  onClick={() => setRestoreRevision(revision)}
                                  size="sm"
                                  type="button"
                                  variant="ghost"
                                >
                                  Restore
                                </Button>
                              )}
                            </header>
                            <p className="revision-source">{revisionSourceName(revision)}</p>
                            <dl className="revision-metadata">
                              <div>
                                <dt>Published</dt>
                                <dd>
                                  <time dateTime={revision.createdAt}>
                                    {dateTime(revision.createdAt)}
                                  </time>
                                </dd>
                              </div>
                              <div>
                                <dt>Revision ID</dt>
                                <dd>
                                  <code title={revision.revisionId}>{revision.revisionId}</code>
                                </dd>
                              </div>
                            </dl>
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
                        <h2 id="details-panel-heading">Details</h2>
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
                          <dd>{revisionSourceName(latest)}</dd>
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

                  {activePanel === 'links' ? (
                    <section aria-labelledby="links-panel-heading" className="inspector-section">
                      <header className="inspector-section-heading">
                        <h2 id="links-panel-heading">Share links</h2>
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
          </>
        ) : null}
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
      <DeleteArtifactDialog
        artifact={deleteOpen ? artifact : undefined}
        onDeleted={() => {
          setDeleteOpen(false);
          void navigate(`/app/w/${encodeURIComponent(artifact.workspaceId)}/artifacts`, {
            replace: true,
          });
        }}
        onOpenChange={setDeleteOpen}
      />
    </div>
  );
}
