import { Button } from '@cloudflare/kumo/components/button';
import { ClipboardText } from '@cloudflare/kumo/components/clipboard-text';
import { DropdownMenu } from '@cloudflare/kumo/components/dropdown';
import { Table } from '@cloudflare/kumo/components/table';
import { DotsThreeIcon } from '@phosphor-icons/react/DotsThree';
import { ShareNetworkIcon } from '@phosphor-icons/react/ShareNetwork';
import { TerminalWindowIcon } from '@phosphor-icons/react/TerminalWindow';
import { TrashIcon } from '@phosphor-icons/react/Trash';
import type { Artifact, ArtifactDeletionResult, ArtifactPage } from '@shelf/contracts';
import { useState } from 'react';
import { Link, useLoaderData, useParams, useRevalidator } from 'react-router';
import { ordinal } from '../components/revision-label.js';
import { DashboardApiError, loadArtifact, recoverArtifact } from './api.js';
import { ArtifactIcon } from './artifact-icon.js';
import { DeleteArtifactDialog } from './delete-artifact-dialog.js';
import { ShareDialog } from './share-dialog.js';
import './artifact.css';
import './artifact-index.css';

const dateLabelFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

function dateLabel(value: string): string {
  return dateLabelFormatter.format(new Date(value));
}

export function ArtifactsPage() {
  const page = useLoaderData() as ArtifactPage;
  const workspaceId = useParams().workspaceId;
  const revalidator = useRevalidator();
  const [shareArtifact, setShareArtifact] = useState<Artifact>();
  const [deletingArtifact, setDeletingArtifact] = useState<Artifact>();
  const [hiddenArtifactIds, setHiddenArtifactIds] = useState<ReadonlySet<string>>(new Set());
  const [recentDeletion, setRecentDeletion] = useState<{
    artifact: Artifact;
    result: ArtifactDeletionResult;
    recoveryKey: string;
  }>();
  const [recoveredArtifacts, setRecoveredArtifacts] = useState<ReadonlyMap<string, Artifact>>(
    new Map(),
  );
  const [recovering, setRecovering] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string>();
  if (workspaceId === undefined) throw new Error('Artifact workspace is unavailable.');
  const loadedArtifactIds = new Set(page.items.map((artifact) => artifact.artifactId));
  const visibleArtifacts = [
    ...[...recoveredArtifacts.values()].filter(
      (artifact) => !loadedArtifactIds.has(artifact.artifactId),
    ),
    ...page.items,
  ].filter((artifact) => !hiddenArtifactIds.has(artifact.artifactId));
  const showRecoveredArtifact = (artifact: Artifact) => {
    setRecoveredArtifacts((current) => new Map(current).set(artifact.artifactId, artifact));
    setHiddenArtifactIds((current) => {
      const next = new Set(current);
      next.delete(artifact.artifactId);
      return next;
    });
    setRecentDeletion(undefined);
    void revalidator.revalidate();
  };
  const undoDeletion = async () => {
    if (recentDeletion === undefined) return;
    setRecovering(true);
    setRecoveryError(undefined);
    try {
      const recovered = await recoverArtifact(
        recentDeletion.artifact.artifactId,
        recentDeletion.recoveryKey,
      );
      showRecoveredArtifact(recovered);
    } catch (caught) {
      if (caught instanceof DashboardApiError && caught.code === 'ARTIFACT_NOT_FOUND') {
        try {
          showRecoveredArtifact(await loadArtifact(recentDeletion.artifact.artifactId));
          return;
        } catch {
          // Preserve the original recovery failure when the artifact is still unavailable.
        }
      }
      setRecoveryError(caught instanceof DashboardApiError ? caught.message : 'Recovery failed.');
    } finally {
      setRecovering(false);
    }
  };

  return (
    <div className="dashboard-page artifact-index">
      <header className="page-heading">
        <div>
          <h1>Artifacts</h1>
          <p>Published files and folders, newest update first.</p>
        </div>
        <div className="cli-publish-hint">
          <div className="cli-publish-label">
            <TerminalWindowIcon aria-hidden="true" size={15} />
            <span>Publish from a terminal</span>
          </div>
          <ClipboardText
            className="cli-clipboard"
            labels={{ copyAction: 'Copy publish command' }}
            size="sm"
            text="shelf publish ./path --share"
            tooltip={{ copiedText: 'Command copied', text: 'Copy command' }}
          />
        </div>
      </header>

      {recentDeletion === undefined ? null : (
        <div className="artifact-deletion-notice" role="status">
          <div>
            <strong>{recentDeletion.artifact.name} deleted</strong>
            <span>
              Recoverable until {dateLabel(recentDeletion.result.recoverableUntil)}. Share links
              were revoked.
            </span>
            {recoveryError === undefined ? null : <span role="alert">{recoveryError}</span>}
          </div>
          <Button
            disabled={recovering}
            loading={recovering}
            onClick={undoDeletion}
            size="sm"
            type="button"
            variant="secondary"
          >
            {recovering ? 'Recovering…' : 'Undo deletion'}
          </Button>
        </div>
      )}

      {visibleArtifacts.length === 0 ? (
        <section className="artifact-index-empty">
          <p className="empty-kicker">Nothing here yet</p>
          <h2>Publish your first artifact from the CLI.</h2>
          <ClipboardText
            className="cli-clipboard"
            labels={{ copyAction: 'Copy first publish command' }}
            size="sm"
            text="shelf publish ./idea.html --share"
          />
        </section>
      ) : (
        <div className="artifact-table-wrap">
          <Table aria-label="Artifacts" className="artifact-table" layout="fixed">
            <colgroup>
              <col className="artifact-name-column" />
              <col className="artifact-kind-column" />
              <col className="artifact-revision-column" />
              <col className="artifact-created-column" />
              <col className="artifact-updated-column" />
              <col className="artifact-actions-column" />
            </colgroup>
            <Table.Header variant="compact">
              <Table.Row>
                <Table.Head>Artifact</Table.Head>
                <Table.Head className="artifact-kind-cell">Kind</Table.Head>
                <Table.Head className="artifact-revision-cell">Revision</Table.Head>
                <Table.Head className="artifact-created-cell">Created on</Table.Head>
                <Table.Head className="artifact-updated-cell">Last updated on</Table.Head>
                <Table.Head className="artifact-actions-cell">
                  <span className="visually-hidden">Actions</span>
                </Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {visibleArtifacts.map((artifact) => {
                return (
                  <Table.Row className="artifact-ledger-row" key={artifact.artifactId}>
                    <Table.Cell>
                      <div className="artifact-ledger-name">
                        <ArtifactIcon
                          kind={artifact.kind}
                          name={
                            artifact.latestRevision.kind === 'file'
                              ? artifact.latestRevision.originalFileName
                              : artifact.name
                          }
                        />
                        <span>
                          <Link
                            to={`/app/w/${encodeURIComponent(artifact.workspaceId)}/artifacts/${encodeURIComponent(artifact.artifactId)}`}
                          >
                            {artifact.name}
                          </Link>
                          <code title={artifact.artifactId}>{artifact.artifactId}</code>
                        </span>
                      </div>
                    </Table.Cell>
                    <Table.Cell className="artifact-kind-cell">{artifact.kind}</Table.Cell>
                    <Table.Cell className="artifact-revision-cell">
                      {ordinal(artifact.latestRevision.revisionNumber)}
                    </Table.Cell>
                    <Table.Cell className="artifact-created-cell">
                      <time dateTime={artifact.createdAt}>{dateLabel(artifact.createdAt)}</time>
                    </Table.Cell>
                    <Table.Cell className="artifact-updated-cell">
                      <time dateTime={artifact.updatedAt}>{dateLabel(artifact.updatedAt)}</time>
                    </Table.Cell>
                    <Table.Cell className="artifact-actions-cell">
                      <div className="artifact-row-actions">
                        <Button
                          aria-label={`Share artifact ${artifact.name}`}
                          icon={ShareNetworkIcon}
                          onClick={() => setShareArtifact(artifact)}
                          shape="square"
                          size="sm"
                          variant="ghost"
                        />
                        <DropdownMenu>
                          <DropdownMenu.Trigger
                            render={
                              <Button
                                aria-label={`More actions for ${artifact.name}`}
                                icon={DotsThreeIcon}
                                shape="square"
                                size="sm"
                                variant="ghost"
                              />
                            }
                          />
                          <DropdownMenu.Content align="end">
                            <DropdownMenu.Item
                              icon={TrashIcon}
                              onClick={() => setDeletingArtifact(artifact)}
                              variant="danger"
                            >
                              Delete artifact
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu>
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
        <footer className="pagination">
          <Link className="control" to={`?cursor=${encodeURIComponent(page.nextCursor)}`}>
            Next page
          </Link>
        </footer>
      )}
      {shareArtifact === undefined ? null : (
        <ShareDialog
          artifactId={shareArtifact.artifactId}
          onOpenChange={(open) => {
            if (!open) setShareArtifact(undefined);
          }}
          open
          revisions={[shareArtifact.latestRevision]}
          workspaceId={workspaceId}
        />
      )}
      <DeleteArtifactDialog
        artifact={deletingArtifact}
        onDeleted={(artifact, result) => {
          setDeletingArtifact(undefined);
          setHiddenArtifactIds((current) => new Set(current).add(artifact.artifactId));
          setRecentDeletion({ artifact, result, recoveryKey: crypto.randomUUID() });
          void revalidator.revalidate();
        }}
        onOpenChange={(open) => {
          if (!open) setDeletingArtifact(undefined);
        }}
      />
    </div>
  );
}
