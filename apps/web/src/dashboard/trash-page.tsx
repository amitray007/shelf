import { Button } from '@cloudflare/kumo/components/button';
import { ClipboardText } from '@cloudflare/kumo/components/clipboard-text';
import { Input } from '@cloudflare/kumo/components/input';
import { Table } from '@cloudflare/kumo/components/table';
import type { TrashedArtifact, TrashPage as TrashPagePayload } from '@shelf/contracts';
import { useState } from 'react';
import {
  Link,
  useLoaderData,
  useLocation,
  useNavigate,
  useParams,
  useRevalidator,
  useSearchParams,
} from 'react-router';

import { DashboardApiError, recoverArtifact } from './api.js';
import { ArtifactIcon } from './artifact-icon.js';
import { EmptyTrashDialog, PermanentlyDeleteArtifactDialog } from './trash-deletion-dialogs.js';
import './artifact-index.css';

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

function daysUntil(value: string): number {
  return Math.max(0, Math.ceil((Date.parse(value) - Date.now()) / (24 * 60 * 60 * 1_000)));
}

export function TrashPage() {
  const page = useLoaderData() as TrashPagePayload;
  const location = useLocation();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const workspaceId = useParams().workspaceId ?? '';
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState(searchParams.get('search') ?? '');
  const [recovering, setRecovering] = useState<string>();
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string>();
  const [recoveryLink, setRecoveryLink] = useState<string>();
  const [deleteTarget, setDeleteTarget] = useState<TrashedArtifact>();
  const [emptyDialogOpen, setEmptyDialogOpen] = useState(false);
  const [cleanupStatus, setCleanupStatus] = useState<string>();
  const items = page.items.filter((item) => !removed.has(item.artifact.artifactId));

  const submitSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = new URLSearchParams();
    if (search.trim().length > 0) query.set('search', search.trim());
    void navigate(query.size === 0 ? location.pathname : `?${query}`);
  };

  const recover = async (artifactId: string) => {
    setRecovering(artifactId);
    setError(undefined);
    setRecoveryLink(undefined);
    setCleanupStatus(undefined);
    try {
      const result = await recoverArtifact(
        artifactId,
        `dashboard-trash-recover-${crypto.randomUUID()}`,
      );
      setRemoved((current) => new Set(current).add(artifactId));
      setRecoveryLink(result.recoveryShare.url);
      void revalidator.revalidate();
    } catch (caught) {
      setError(caught instanceof DashboardApiError ? caught.message : 'Artifact recovery failed.');
    } finally {
      setRecovering(undefined);
    }
  };

  return (
    <div className="dashboard-page artifact-index">
      <header className="page-heading">
        <div>
          <h1>Trash</h1>
          <p>Recover artifacts before their permanent cleanup date.</p>
        </div>
        <Button onClick={() => setEmptyDialogOpen(true)} type="button" variant="destructive">
          Empty Trash
        </Button>
      </header>

      {error === undefined ? null : (
        <p className="inline-notice" role="alert">
          {error}
        </p>
      )}
      {recoveryLink === undefined ? null : (
        <div className="artifact-deletion-toast" role="status">
          <div>
            <strong>Artifact recovered</strong>
            <span>This Protected recovery link keeps it available for seven days.</span>
          </div>
          <ClipboardText
            labels={{ copyAction: 'Copy recovery link' }}
            size="sm"
            text={recoveryLink}
          />
        </div>
      )}
      {cleanupStatus === undefined ? null : (
        <div className="artifact-deletion-toast" role="status">
          <div>
            <strong>Permanent deletion started</strong>
            <span>{cleanupStatus}</span>
          </div>
        </div>
      )}

      <form className="artifact-search" onSubmit={submitSearch}>
        <div className="artifact-search-form">
          <Input
            aria-label="Search Trash"
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder="Artifact ID, title, description, or filename"
            value={search}
          />
          <Button size="sm" type="submit" variant="secondary">
            Search
          </Button>
        </div>
      </form>

      {items.length === 0 ? (
        <section className="artifact-index-empty">
          <p className="empty-kicker">Trash is empty</p>
          <h2>No recoverable artifacts match this view.</h2>
        </section>
      ) : (
        <div className="artifact-table-wrap">
          <Table aria-label="Trash" className="artifact-table" layout="fixed">
            <Table.Header variant="compact">
              <Table.Row>
                <Table.Head>Artifact</Table.Head>
                <Table.Head>Deleted</Table.Head>
                <Table.Head>Permanent cleanup</Table.Head>
                <Table.Head>
                  <span className="visually-hidden">Actions</span>
                </Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {items.map((item) => {
                const artifact = item.artifact;
                const sourceName =
                  artifact.latestRevision.kind === 'file'
                    ? artifact.latestRevision.originalFileName
                    : artifact.latestRevision.rootName;
                const days = daysUntil(item.purgeAt);
                return (
                  <Table.Row key={artifact.artifactId}>
                    <Table.Cell>
                      <div className="artifact-ledger-name">
                        <ArtifactIcon kind={artifact.kind} name={sourceName} />
                        <span>
                          <strong>{artifact.name}</strong>
                          <span className="artifact-ledger-secondary">
                            <code>{artifact.artifactId}</code>
                            <span aria-hidden="true">·</span>
                            <span>
                              {item.reason === 'retention' ? 'Automatic cleanup' : 'Deleted'}
                            </span>
                          </span>
                        </span>
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      <time dateTime={item.deletedAt}>
                        {dateFormatter.format(new Date(item.deletedAt))}
                      </time>
                    </Table.Cell>
                    <Table.Cell>
                      <strong>
                        {days === 0 ? 'Pending now' : `${days} ${days === 1 ? 'day' : 'days'}`}
                      </strong>
                      <span className="artifact-ledger-secondary">
                        <time dateTime={item.purgeAt}>
                          {dateFormatter.format(new Date(item.purgeAt))}
                        </time>
                      </span>
                    </Table.Cell>
                    <Table.Cell className="artifact-actions-cell">
                      <div className="trash-row-actions">
                        <Button
                          disabled={recovering !== undefined}
                          loading={recovering === artifact.artifactId}
                          onClick={() => void recover(artifact.artifactId)}
                          size="sm"
                          type="button"
                          variant="secondary"
                        >
                          Recover
                        </Button>
                        <Button
                          disabled={recovering !== undefined}
                          onClick={() => setDeleteTarget(item)}
                          size="sm"
                          type="button"
                          variant="destructive"
                        >
                          Delete permanently
                        </Button>
                      </div>
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        </div>
      )}

      {page.nextCursor === null ? null : (
        <nav aria-label="Trash pages" className="artifact-pagination">
          <Link
            to={`?${new URLSearchParams({
              ...(searchParams.get('search') === null
                ? {}
                : { search: searchParams.get('search') as string }),
              cursor: page.nextCursor,
            })}`}
          >
            Next page
          </Link>
        </nav>
      )}
      <PermanentlyDeleteArtifactDialog
        item={deleteTarget}
        onDeleted={(artifactId) => {
          setDeleteTarget(undefined);
          setRemoved((current) => new Set(current).add(artifactId));
          setCleanupStatus(
            'The artifact cannot be recovered. Storage cleanup continues in the background.',
          );
          void revalidator.revalidate();
        }}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(undefined);
        }}
      />
      <EmptyTrashDialog
        onEmptied={(purgedArtifactCount) => {
          setEmptyDialogOpen(false);
          setRemoved((current) => {
            const next = new Set(current);
            for (const item of page.items) next.add(item.artifact.artifactId);
            return next;
          });
          setCleanupStatus(
            purgedArtifactCount === 1
              ? '1 artifact was permanently deleted. Storage cleanup continues in the background.'
              : `${purgedArtifactCount} artifacts were permanently deleted. Storage cleanup continues in the background.`,
          );
          void revalidator.revalidate();
        }}
        onOpenChange={setEmptyDialogOpen}
        open={emptyDialogOpen}
        workspaceId={workspaceId}
      />
    </div>
  );
}
