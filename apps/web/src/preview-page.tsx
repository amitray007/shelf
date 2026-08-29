import { ArrowLeftIcon } from '@phosphor-icons/react/ArrowLeft';
import { WarningCircleIcon } from '@phosphor-icons/react/WarningCircle';
import { useEffect } from 'react';
import { Link, useLoaderData, useNavigation, useRevalidator, useSearchParams } from 'react-router';

import {
  ViewerRefreshButton,
  ViewerRevisionLoadingState,
  ViewerRevisionNavigation,
} from './components/viewer-shell.js';
import { ManagedArtifactContent } from './dashboard/managed-artifact-content.js';
import type { ArtifactPreviewPayload } from './dashboard/routes.js';
import './dashboard/artifact.css';

export function PreviewPage() {
  const payload = useLoaderData() as ArtifactPreviewPayload;
  const { artifact, revision, revisions } = payload;
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();
  const revisionLoading = navigation.state === 'loading';
  const oldestFirst = [...revisions].sort(
    (left, right) => left.revisionNumber - right.revisionNumber,
  );
  const revisionIndex = oldestFirst.findIndex(
    (candidate) => candidate.revisionId === revision.revisionId,
  );
  const previousRevisionId = oldestFirst[revisionIndex - 1]?.revisionId ?? null;
  const nextRevisionId = oldestFirst[revisionIndex + 1]?.revisionId ?? null;

  const selectRevision = (revisionId: string | null) => {
    const nextSearchParams = new URLSearchParams(searchParams);
    if (revisionId === null || revisionId === artifact.latestRevision.revisionId) {
      nextSearchParams.delete('revision');
    } else {
      nextSearchParams.set('revision', revisionId);
    }
    setSearchParams(nextSearchParams);
  };

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
          <ViewerRevisionNavigation
            currentRevisionId={revision.revisionId}
            latestRevisionId={artifact.latestRevision.revisionId}
            nextRevisionId={nextRevisionId}
            onRevisionSelect={selectRevision}
            previousRevisionId={previousRevisionId}
            revisions={revisions}
          />
          <ViewerRefreshButton
            checkingUpdates={revalidator.state === 'loading'}
            onCheckUpdates={() => void revalidator.revalidate()}
          />
          <Link
            className="preview-open-artifact"
            to={`/app/w/${encodeURIComponent(artifact.workspaceId)}/artifacts/${encodeURIComponent(artifact.artifactId)}`}
          >
            <ArrowLeftIcon aria-hidden="true" size={14} />
            <span>Back to artifact</span>
          </Link>
        </div>
      </header>
      <main aria-busy={revisionLoading} className="viewer-main">
        {revisionLoading ? (
          <ViewerRevisionLoadingState />
        ) : (
          <ManagedArtifactContent
            bytes={payload.bytes}
            entries={payload.entries}
            revision={revision}
          />
        )}
      </main>
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
