import type { PublicShareResolution } from '@shelf/contracts';

import type { ViewerAuthority } from '../api.js';
import {
  isFileShareResolution,
  type ShareRevisionPointer,
  shareLatestRevision,
} from '../share-types.js';
import { revisionLabel } from './revision-label.js';

export { LoadingView, UnavailableView } from './boot-views.js';

export function ViewerRail({
  authority: _authority,
  resolution,
  checkingUpdates = false,
  latestAvailable,
  onCheckUpdates,
  onRevisionSelect,
}: {
  readonly authority: ViewerAuthority;
  readonly resolution: PublicShareResolution;
  readonly checkingUpdates?: boolean;
  readonly latestAvailable?: ShareRevisionPointer;
  readonly onCheckUpdates?: () => void;
  readonly onRevisionSelect?: (revisionId: string | null) => void;
}) {
  const revision = resolution.revision;
  const latestRevision = shareLatestRevision(resolution);
  const targetLabel =
    resolution.target.mode === 'pinned'
      ? 'Pinned'
      : revision.revisionId === latestRevision.revisionId
        ? 'Latest'
        : 'History';
  const showArtifactTitle = !isFileShareResolution(resolution);

  return (
    <header className="rail viewer-rail">
      <div className="rail-title-group">
        <span className="wordmark">shelf</span>
        <span className="rail-separator" aria-hidden="true">
          /
        </span>
        <span className="rail-muted">Shared artifact</span>
        {showArtifactTitle ? (
          <>
            <span className="rail-separator rail-secondary-separator" aria-hidden="true">
              /
            </span>
            <strong className="artifact-title" title={resolution.artifact.name}>
              {resolution.artifact.name}
            </strong>
          </>
        ) : null}
      </div>
      <div className="rail-context">
        <fieldset aria-label="Revision navigation" className="viewer-revision-navigation">
          {resolution.navigation?.previous === null ||
          resolution.navigation?.previous === undefined ? null : (
            <button
              aria-label={`View ${revisionLabel(resolution.navigation.previous.revisionNumber)}`}
              className="viewer-revision-control"
              onClick={() =>
                onRevisionSelect?.(resolution.navigation?.previous?.revisionId ?? null)
              }
              title="View previous revision"
              type="button"
            >
              ←
            </button>
          )}
          <span className="target-state">
            {targetLabel} · {revisionLabel(revision.revisionNumber)}
          </span>
          {resolution.navigation?.next === null ||
          resolution.navigation?.next === undefined ? null : (
            <button
              aria-label={`View ${revisionLabel(resolution.navigation.next.revisionNumber)}`}
              className="viewer-revision-control"
              onClick={() => onRevisionSelect?.(resolution.navigation?.next?.revisionId ?? null)}
              title="View next revision"
              type="button"
            >
              →
            </button>
          )}
        </fieldset>
        {latestAvailable === undefined ? null : resolution.target.mode === 'latest' ? (
          <button
            className="viewer-latest-available"
            onClick={() => onRevisionSelect?.(null)}
            type="button"
          >
            {revisionLabel(latestAvailable.revisionNumber)} available
          </button>
        ) : (
          <span className="viewer-latest-notice">
            {revisionLabel(latestAvailable.revisionNumber)} available
          </span>
        )}
        {onCheckUpdates === undefined ? null : (
          <button
            aria-label="Check for a newer revision"
            className="viewer-update-check"
            disabled={checkingUpdates}
            onClick={onCheckUpdates}
            type="button"
          >
            {checkingUpdates ? 'Checking…' : 'Check updates'}
          </button>
        )}
      </div>
    </header>
  );
}
