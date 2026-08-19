import { Button } from '@cloudflare/kumo/components/button';
import type {
  Artifact,
  ArtifactDefaultShares,
  ArtifactRevision,
  ShareManagementSummary,
} from '@shelf/contracts';
import { useEffect, useState } from 'react';

import { ordinal } from '../components/revision-label.js';
import { DashboardApiError, ensureArtifactDefaultShares } from './api.js';
import { Modal, SecretReveal } from './dialogs.js';
import { ShareDialog } from './share-dialog.js';
import { shareSessionUsage } from './status.js';

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
  const [shares, setShares] = useState<ArtifactDefaultShares>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry is an explicit reload trigger.
  useEffect(() => {
    if (!open || creating) return;
    const controller = new AbortController();
    setLoading(true);
    setShares(undefined);
    setError(undefined);
    void ensureArtifactDefaultShares(artifact.workspaceId, artifact.artifactId, controller.signal)
      .then((defaults) => {
        if (!controller.signal.aborted) setShares(defaults);
      })
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
  }, [artifact.artifactId, artifact.workspaceId, creating, open, retry]);

  if (creating) {
    return (
      <ShareDialog
        artifactId={artifact.artifactId}
        onOpenChange={(next) => {
          if (!next) {
            setCreating(false);
            onOpenChange(false);
          }
        }}
        open={open}
        revisions={revisions}
        workspaceId={artifact.workspaceId}
      />
    );
  }

  const shareCard = (share: ShareManagementSummary) => {
    const target =
      share.target.mode === 'pinned'
        ? `${ordinal(share.target.revisionNumber)} Revision`
        : 'Always the latest revision';
    return (
      <section className="latest-share-summary" aria-label={`${share.accessType} default link`}>
        <div className="latest-share-heading">
          <div>
            <span>{share.accessType === 'protected' ? 'Protected link' : 'Public link'}</span>
            <strong>{target}</strong>
          </div>
          <time dateTime={share.createdAt}>
            {dateTimeFormatter.format(new Date(share.createdAt))}
          </time>
        </div>
        <dl className="share-dialog-metadata">
          <div>
            <dt>Expires</dt>
            <dd>Never</dd>
          </div>
          {share.accessType === 'protected' ? (
            <div>
              <dt>Sessions</dt>
              <dd>{shareSessionUsage(share)}</dd>
            </div>
          ) : null}
        </dl>
        <SecretReveal
          hint="This reusable default link stays available until you revoke it."
          label={share.accessType === 'protected' ? 'Protected URL' : 'Public URL'}
          value={new URL(share.url, window.location.origin).href}
        />
      </section>
    );
  };

  return (
    <Modal
      description={`Copy a permanent default link for ${artifact.name}, or create a custom one.`}
      onOpenChange={onOpenChange}
      open={open}
      title="Share artifact"
    >
      <div className="dialog-form artifact-share-overview">
        {loading ? <p className="share-dialog-status">Loading share links…</p> : null}
        {error === undefined ? null : (
          <div className="share-dialog-error" role="alert">
            <p className="form-error">{error}</p>
            <Button onClick={() => setRetry((value) => value + 1)} size="sm" type="button">
              Try again
            </Button>
          </div>
        )}
        {shares === undefined ? null : (
          <div className="artifact-default-shares">
            {shareCard(shares.protected)}
            {shareCard(shares.public)}
          </div>
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
