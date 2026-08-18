import { ClipboardText } from '@cloudflare/kumo/components/clipboard-text';
import { Table } from '@cloudflare/kumo/components/table';
import { FileIcon } from '@phosphor-icons/react/File';
import { FolderIcon } from '@phosphor-icons/react/Folder';
import { TerminalWindowIcon } from '@phosphor-icons/react/TerminalWindow';
import type { ArtifactPage } from '@shelf/contracts';
import { Link, useLoaderData, useParams } from 'react-router';

import { formatBytes } from '../components/format.js';
import './artifact.css';

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
  if (workspaceId === undefined) throw new Error('Artifact workspace is unavailable.');

  return (
    <div className="dashboard-page artifact-index">
      <header className="page-heading">
        <div>
          <p className="workspace-label">{workspaceId}</p>
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

      {page.items.length === 0 ? (
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
              <col className="artifact-size-column" />
              <col className="artifact-updated-column" />
            </colgroup>
            <Table.Header variant="compact">
              <Table.Row>
                <Table.Head>Artifact</Table.Head>
                <Table.Head className="artifact-kind-cell">Kind</Table.Head>
                <Table.Head className="artifact-revision-cell">Revision</Table.Head>
                <Table.Head className="artifact-size-cell">Size</Table.Head>
                <Table.Head className="artifact-updated-cell">Updated</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {page.items.map((artifact) => {
                const KindIcon = artifact.kind === 'folder' ? FolderIcon : FileIcon;
                return (
                  <Table.Row className="artifact-ledger-row" key={artifact.artifactId}>
                    <Table.Cell>
                      <div className="artifact-ledger-name">
                        <KindIcon aria-hidden="true" size={17} />
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
                      r{artifact.latestRevision.revisionNumber}
                    </Table.Cell>
                    <Table.Cell className="artifact-size-cell">
                      {formatBytes(artifact.latestRevision.byteCount)}
                    </Table.Cell>
                    <Table.Cell className="artifact-updated-cell">
                      <time dateTime={artifact.updatedAt}>{dateLabel(artifact.updatedAt)}</time>
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
    </div>
  );
}
