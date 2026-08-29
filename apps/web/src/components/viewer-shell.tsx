import { Select } from '@cloudflare/kumo/components/select';
import { ArrowClockwiseIcon } from '@phosphor-icons/react/ArrowClockwise';
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
          {resolution.navigation === undefined ? (
            <span className="target-state">
              {targetLabel} · {revisionLabel(revision.revisionNumber)}
            </span>
          ) : (
            <>
              <button
                aria-label="View previous revision"
                className="viewer-revision-control"
                disabled={resolution.navigation.previous === null}
                onClick={() =>
                  onRevisionSelect?.(resolution.navigation?.previous?.revisionId ?? null)
                }
                type="button"
              >
                ←
              </button>
              <Select<string>
                aria-label="Select revision"
                className="viewer-revision-select"
                onValueChange={(revisionId) => {
                  if (revisionId === null) return;
                  onRevisionSelect?.(revisionId === latestRevision.revisionId ? null : revisionId);
                }}
                renderValue={(revisionId) => {
                  const selected = resolution.navigation?.revisions.find(
                    (candidate) => candidate.revisionId === revisionId,
                  );
                  if (selected === undefined) return null;
                  return selected.revisionId === latestRevision.revisionId
                    ? 'Latest Revision'
                    : revisionLabel(selected.revisionNumber);
                }}
                size="sm"
                value={revision.revisionId}
              >
                {[...resolution.navigation.revisions].reverse().map((candidate) => (
                  <Select.Option
                    className="viewer-revision-option"
                    key={candidate.revisionId}
                    value={candidate.revisionId}
                  >
                    {candidate.revisionId === latestRevision.revisionId
                      ? 'Latest Revision'
                      : revisionLabel(candidate.revisionNumber)}
                  </Select.Option>
                ))}
              </Select>
              <button
                aria-label="View next revision"
                className="viewer-revision-control"
                disabled={resolution.navigation.next === null}
                onClick={() => onRevisionSelect?.(resolution.navigation?.next?.revisionId ?? null)}
                type="button"
              >
                →
              </button>
            </>
          )}
        </fieldset>
        {latestAvailable === undefined ? null : resolution.target.mode === 'latest' ? (
          <button
            className="viewer-latest-available"
            onClick={() => onRevisionSelect?.(null)}
            type="button"
          >
            Latest Revision available
          </button>
        ) : (
          <span className="viewer-latest-notice">Latest Revision available</span>
        )}
        {onCheckUpdates === undefined ? null : (
          <button
            aria-label={checkingUpdates ? 'Refreshing…' : 'Refresh'}
            className="viewer-update-check"
            disabled={checkingUpdates}
            onClick={onCheckUpdates}
            type="button"
          >
            <ArrowClockwiseIcon
              aria-hidden="true"
              className="viewer-update-icon"
              data-refreshing={checkingUpdates || undefined}
              size={14}
            />
            <span>Refresh</span>
          </button>
        )}
      </div>
    </header>
  );
}
