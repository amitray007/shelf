import { Button } from '@cloudflare/kumo/components/button';
import { Radio } from '@cloudflare/kumo/components/radio';
import type {
  Artifact,
  ArtifactDefaultShares,
  ArtifactRevision,
  CommentPolicy,
  ShareManagementSummary,
} from '@shelf/contracts';
import { useEffect, useRef, useState } from 'react';

import { ordinal } from '../components/revision-label.js';
import { DashboardApiError, ensureArtifactDefaultShares, setShareCommentPolicy } from './api.js';
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
  const [policyBusy, setPolicyBusy] = useState<ReadonlySet<'protected' | 'public'>>(
    () => new Set(),
  );
  const policyBusyRef = useRef<Set<'protected' | 'public'>>(new Set());
  const [policyErrors, setPolicyErrors] = useState<Partial<Record<'protected' | 'public', string>>>(
    {},
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry is an explicit reload trigger.
  useEffect(() => {
    if (!open || creating) return;
    const controller = new AbortController();
    setLoading(true);
    setShares(undefined);
    setError(undefined);
    setPolicyBusy(new Set());
    policyBusyRef.current = new Set();
    setPolicyErrors({});
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

  const updatePolicy = async (share: ShareManagementSummary, commentPolicy: CommentPolicy) => {
    if (policyBusyRef.current.has(share.accessType)) return;
    policyBusyRef.current.add(share.accessType);
    setPolicyBusy((current) => new Set(current).add(share.accessType));
    setPolicyErrors((current) => ({ ...current, [share.accessType]: undefined }));
    try {
      const updated = await setShareCommentPolicy(
        artifact.workspaceId,
        share.shareId,
        commentPolicy,
      );
      setShares((current) => {
        if (current === undefined) return current;
        return {
          ...current,
          [share.accessType]: updated,
        } as ArtifactDefaultShares;
      });
    } catch (caught) {
      setPolicyErrors((current) => ({
        ...current,
        [share.accessType]:
          caught instanceof DashboardApiError
            ? caught.message
            : 'Comments policy could not be updated.',
      }));
    } finally {
      setPolicyBusy((current) => {
        const next = new Set(current);
        next.delete(share.accessType);
        return next;
      });
      policyBusyRef.current.delete(share.accessType);
    }
  };

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
        <div aria-busy={policyBusy.has(share.accessType)} className="share-policy-control">
          <Radio.Group
            className="choice-group compact-choice-group"
            disabled={policyBusy.has(share.accessType)}
            legend="Comments"
            name={`default-share-comments-${share.accessType}`}
            onValueChange={(value) =>
              void updatePolicy(share, value === 'private' || value === 'shared' ? value : 'off')
            }
            value={share.commentPolicy ?? 'off'}
          >
            <Radio.Item label="Off" value="off" />
            <Radio.Item label="Private" value="private" />
            <Radio.Item label="Shared" value="shared" />
          </Radio.Group>
          {policyErrors[share.accessType] === undefined ? null : (
            <p aria-live="polite" className="form-error">
              {policyErrors[share.accessType]}
            </p>
          )}
        </div>
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
