import { Loader } from '@cloudflare/kumo/components/loader';
import { WarningCircleIcon } from '@phosphor-icons/react/WarningCircle';
import type { PublicShareResolution } from '@shelf/contracts';

import { revisionLabel } from './revision-label.js';

export function LoadingView() {
  return (
    <div className="viewer viewer-pending" aria-busy="true">
      <div className="rail rail-placeholder">
        <span className="wordmark">shelf</span>
      </div>
      <div className="state-center">
        <Loader aria-hidden="true" size="sm" />
        <p>Opening artifact…</p>
      </div>
    </div>
  );
}

export function UnavailableView() {
  return (
    <div className="viewer viewer-unavailable">
      <div className="rail">
        <span className="wordmark">shelf</span>
        <span className="rail-separator" aria-hidden="true">
          /
        </span>
        <span className="rail-muted">Shared artifact</span>
      </div>
      <main className="state-center">
        <WarningCircleIcon aria-hidden="true" className="unavailable-mark" size={28} />
        <h1>This artifact is unavailable</h1>
        <p>The link may no longer be available, or it may be incomplete.</p>
      </main>
    </div>
  );
}

export function ViewerRail({ resolution }: { readonly resolution: PublicShareResolution }) {
  const revision = resolution.revision;
  const targetLabel = resolution.target.mode === 'latest' ? 'latest' : 'pinned';

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
      </div>
    </header>
  );
}
