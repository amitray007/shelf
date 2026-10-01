// Entry-bundle fallbacks. This module must stay dependency-free (no Kumo, no
// icon packages, no artifact components) so the initial script stays small.

export function ArtifactLoadingState({ label = 'Loading artifact…' }: { readonly label?: string }) {
  return (
    <div aria-live="polite" className="state-center artifact-loading-state" role="status">
      <span aria-hidden="true" className="loading-mark" />
      <p>{label}</p>
    </div>
  );
}

export function LoadingView() {
  return (
    <div className="viewer viewer-pending" aria-busy="true">
      <ArtifactLoadingState label="Opening artifact…" />
      <button aria-label="Open artifact details" className="viewer-launcher" disabled type="button">
        <span aria-hidden="true" className="shelf-brand-mark" />
        <span>Details</span>
      </button>
    </div>
  );
}

export function UnavailableView({ incompleteLink = false }: { readonly incompleteLink?: boolean }) {
  return (
    <div className="viewer viewer-unavailable">
      <main className="state-center">
        <svg
          aria-hidden="true"
          className="unavailable-mark"
          fill="currentColor"
          height="28"
          viewBox="0 0 256 256"
          width="28"
        >
          <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm-8-80V80a8,8,0,0,1,16,0v56a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,172Z" />
        </svg>
        <h1>
          {incompleteLink ? 'This protected link is incomplete' : 'This artifact is unavailable'}
        </h1>
        <p>
          {incompleteLink
            ? 'Open the complete link from the sender, including the part after #.'
            : 'The link may no longer be available, or it may be incomplete.'}
        </p>
      </main>
    </div>
  );
}
