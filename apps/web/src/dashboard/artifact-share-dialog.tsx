import { Button } from '@cloudflare/kumo/components/button';
import type { Artifact, ArtifactRevision, ShareManagementSummary } from '@shelf/contracts';
import { useEffect, useState } from 'react';

import { ordinal } from '../components/revision-label.js';
import { DashboardApiError, loadLatestActiveArtifactShare } from './api.js';
import { Modal, SecretReveal } from './dialogs.js';
import { ShareDialog } from './share-dialog.js';

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function ArtifactShareDialog({
  artifact,
  revisions = [artifact.latestRevision],
  open,
  onOpenChange,
}: {
  readonly artifact: Artifact;
  readonly revisions?: readonly ArtifactRevision[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [share, setShare] = useState<ShareManagementSummary>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open || creating) return;
    const controller = new AbortController();
    setLoading(true);
    setShare(undefined);
    setError(undefined);
    void loadLatestActiveArtifactShare(artifact.workspaceId, artifact.artifactId, controller.signal)
      .then((latest) => setShare(latest))
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          caught instanceof DashboardApiError ? caught.message : 'Share links could not load.',
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [artifact.artifactId, artifact.workspaceId, creating, open]);

  if (creating) {
    return (
      <ShareDialog
        artifactId={artifact.artifactId}
        onOpenChange={(next) => {
          if (!next) onOpenChange(false);
        }}
        open={open}
        revisions={revisions}
        workspaceId={artifact.workspaceId}
      />
    );
  }

  const target =
    share?.target.mode === 'pinned'
      ? `${ordinal(share.target.revisionNumber)} Revision`
      : 'Always the latest revision';

  return (
    <Modal
      description={`Reuse an active link for ${artifact.name}, or create another one.`}
      onOpenChange={onOpenChange}
      open={open}
      title="Share artifact"
    >
      <div className="dialog-form artifact-share-overview">
        {loading ? <p className="share-dialog-status">Loading share links…</p> : null}
        {error === undefined ? null : <p className="form-error">{error}</p>}
        {!loading && error === undefined && share === undefined ? (
          <div className="share-dialog-empty">
            <strong>No active share link</strong>
            <span>Create a link anyone with the URL can open.</span>
          </div>
        ) : null}
        {share === undefined ? null : (
          <section className="latest-share-card" aria-label="Latest active share link">
            <div className="latest-share-heading">
              <div>
                <span>Latest active link</span>
                <strong>{target}</strong>
              </div>
              <time dateTime={share.createdAt}>
                {dateTimeFormatter.format(new Date(share.createdAt))}
              </time>
            </div>
            <SecretReveal
              hint="This link remains available here until it expires or is revoked."
              label="Share URL"
              value={new URL(share.url, window.location.origin).href}
            />
          </section>
        )}
        <div className="dialog-actions">
          <Button onClick={() => onOpenChange(false)} type="button">
            Close
          </Button>
          <Button onClick={() => setCreating(true)} type="button" variant="primary">
            Create new link
          </Button>
        </div>
      </div>
    </Modal>
  );
}
