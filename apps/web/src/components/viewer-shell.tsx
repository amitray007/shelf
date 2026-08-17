import type { PublicShareResolution } from '@shelf/contracts';

import { formatBytes } from './artifact-content.js';

export function LoadingView() {
  return (
    <div className="viewer viewer-pending" aria-busy="true">
      <div className="rail rail-placeholder">
        <span className="wordmark">shelf</span>
      </div>
      <div className="state-center">
        <span className="loading-mark" aria-hidden="true" />
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
        <span className="rail-divider" aria-hidden="true" />
        <span className="rail-muted">shared artifact</span>
      </div>
      <main className="state-center">
        <span className="unavailable-mark" aria-hidden="true" />
        <h1>This artifact is unavailable</h1>
        <p>The link may no longer be available, or it may be incomplete.</p>
      </main>
    </div>
  );
}

export function ViewerRail({ resolution }: { readonly resolution: PublicShareResolution }) {
  const revision = resolution.revision;
  const targetLabel = resolution.target.mode === 'latest' ? 'latest' : 'pinned';
  const totalBytes = formatBytes(revision.byteCount);

  return (
    <header className="rail viewer-rail">
      <div className="rail-title-group">
        <span className="wordmark">shelf</span>
        <span className="rail-divider" aria-hidden="true" />
        <strong className="artifact-title" title={resolution.artifact.name}>
          {resolution.artifact.name}
        </strong>
      </div>
      <div className="rail-context">
        <span className="trust-note">
          <span className="trust-dot" aria-hidden="true" />
          User-generated content
        </span>
        <span className="target-state">
          {targetLabel} · r{revision.revisionNumber} · {totalBytes}
        </span>
      </div>
    </header>
  );
}
