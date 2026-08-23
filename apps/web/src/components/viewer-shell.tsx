import type { PublicShareResolution } from '@shelf/contracts';

import type { ViewerAuthority } from '../api.js';
import { isFileShareResolution } from '../share-types.js';
import { revisionLabel } from './revision-label.js';

export { LoadingView, UnavailableView } from './boot-views.js';

export function ViewerRail({
  authority: _authority,
  resolution,
}: {
  readonly authority: ViewerAuthority;
  readonly resolution: PublicShareResolution;
}) {
  const revision = resolution.revision;
  const targetLabel = resolution.target.mode === 'latest' ? 'Latest' : 'Pinned';
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
        <span className="target-state">
          {targetLabel} · {revisionLabel(revision.revisionNumber)}
        </span>
      </div>
    </header>
  );
}
