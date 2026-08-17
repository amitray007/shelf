import type { ArtifactPage } from '@shelf/contracts';
import { Link, useLoaderData, useParams } from 'react-router';

import { formatBytes } from '../components/artifact-content.js';

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value));
}

export function ArtifactsPage() {
  const page = useLoaderData() as ArtifactPage;
  const workspaceId = useParams().workspaceId ?? page.items[0]?.workspaceId ?? '';

  return (
    <div className="dashboard-page artifact-index">
      <header className="page-heading">
        <div>
          <p className="eyebrow">{workspaceId}</p>
          <h1>Artifacts</h1>
          <p>Published files and folders, newest change first.</p>
        </div>
        <div className="cli-cue">
          <span>Publish from a terminal</span>
          <code>shelf publish ./path --share</code>
        </div>
      </header>

      {page.items.length === 0 ? (
        <section className="dashboard-empty">
          <p className="eyebrow">Nothing here yet</p>
          <h2>Publish your first artifact from the CLI.</h2>
          <code>shelf publish ./idea.html --share</code>
        </section>
      ) : (
        <ul className="artifact-list" aria-label="Artifacts">
          {page.items.map((artifact) => (
            <li key={artifact.artifactId}>
              <Link
                className="artifact-row"
                to={`/app/w/${encodeURIComponent(artifact.workspaceId)}/artifacts/${encodeURIComponent(artifact.artifactId)}`}
              >
                <span className={`kind-mark kind-mark-${artifact.kind}`} aria-hidden="true" />
                <span className="artifact-row-main">
                  <strong>{artifact.name}</strong>
                  <span>{artifact.artifactId}</span>
                </span>
                <span className="artifact-row-kind">{artifact.kind}</span>
                <span className="artifact-row-revision">
                  r{artifact.latestRevision.revisionNumber}
                </span>
                <span className="artifact-row-size">
                  {formatBytes(artifact.latestRevision.byteCount)}
                </span>
                <time dateTime={artifact.updatedAt}>{dateLabel(artifact.updatedAt)}</time>
              </Link>
            </li>
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
    </div>
  );
}
