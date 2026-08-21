import type { PublicShareResolution } from '@shelf/contracts';

import type { ViewerAuthority } from '../api.js';
import { isFileShareResolution } from '../share-types.js';
import { DownloadAction } from './artifact-content.js';
import { revisionLabel } from './revision-label.js';

export { LoadingView, UnavailableView } from './boot-views.js';

export function ViewerRail({
  authority,
  resolution,
}: {
  readonly authority: ViewerAuthority;
  readonly resolution: PublicShareResolution;
}) {
  const revision = resolution.revision;
  const targetLabel = resolution.target.mode === 'latest' ? 'Latest' : 'Pinned';

  return (
    <header className="rail viewer-rail">
      <div className="rail-title-group">
        <span className="wordmark">shelf</span>
        <span className="rail-separator" aria-hidden="true">
          /
        </span>
        <span className="rail-muted">Shared artifact</span>
        <span className="rail-separator rail-secondary-separator" aria-hidden="true">
          /
        </span>
        <strong className="artifact-title" title={resolution.artifact.name}>
          {resolution.artifact.name}
        </strong>
      </div>
      <div className="rail-context">
        <span className="target-state">
          {targetLabel} · {revisionLabel(revision.revisionNumber)}
        </span>
        {isFileShareResolution(resolution) ? (
          <DownloadAction authority={authority} compact resolution={resolution} />
        ) : null}
      </div>
    </header>
  );
}
