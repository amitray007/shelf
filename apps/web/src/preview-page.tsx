import { ArrowLeftIcon } from '@phosphor-icons/react/ArrowLeft';
import { WarningCircleIcon } from '@phosphor-icons/react/WarningCircle';
import { useEffect } from 'react';
import { Link, useLoaderData } from 'react-router';

import { ordinal } from './components/revision-label.js';
import { ManagedArtifactContent } from './dashboard/managed-artifact-content.js';
import type { ArtifactPreviewPayload } from './dashboard/routes.js';
import './dashboard/artifact.css';

export function PreviewPage() {
  const payload = useLoaderData() as ArtifactPreviewPayload;
  const { artifact, revision } = payload;

  useEffect(() => {
    document.title = `${artifact.name} · Preview · shelf`;
    return () => {
      document.title = 'shelf';
    };
  }, [artifact.name]);

  return (
    <div className="viewer artifact-private-preview">
      <header className="rail viewer-rail">
        <div className="rail-title-group">
          <span className="wordmark">shelf</span>
          <span className="rail-separator" aria-hidden="true">
            /
          </span>
          <span className="rail-muted">Private preview</span>
          <span className="rail-separator rail-secondary-separator" aria-hidden="true">
            /
          </span>
          <strong className="artifact-title" title={artifact.name}>
            {artifact.name}
          </strong>
        </div>
        <div className="rail-context">
          <span className="target-state">{ordinal(revision.revisionNumber)} Revision</span>
          <Link
            className="preview-open-artifact"
            to={`/app/w/${encodeURIComponent(artifact.workspaceId)}/artifacts/${encodeURIComponent(artifact.artifactId)}`}
          >
            <ArrowLeftIcon aria-hidden="true" size={14} />
            Back to artifact
          </Link>
        </div>
      </header>
      <ManagedArtifactContent bytes={payload.bytes} entries={payload.entries} revision={revision} />
    </div>
  );
}

export function PreviewErrorBoundary() {
  return (
    <div className="viewer viewer-unavailable">
      <div className="rail">
        <span className="wordmark">shelf</span>
        <span className="rail-separator" aria-hidden="true">
          /
        </span>
        <span className="rail-muted">Private preview</span>
      </div>
      <main className="state-center">
        <WarningCircleIcon aria-hidden="true" className="unavailable-mark" size={28} />
        <h1>Preview unavailable</h1>
        <p>The artifact may no longer exist, or you may not have access to its workspace.</p>
        <Link className="control control-primary" to="/app">
          Back to Shelf
        </Link>
      </main>
    </div>
  );
}
