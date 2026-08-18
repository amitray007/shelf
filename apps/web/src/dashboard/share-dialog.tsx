import { Button } from '@cloudflare/kumo/components/button';
import { Input } from '@cloudflare/kumo/components/input';
import { Radio } from '@cloudflare/kumo/components/radio';
import { Select } from '@cloudflare/kumo/components/select';
import type { ArtifactRevision } from '@shelf/contracts';
import { type FormEvent, useRef, useState } from 'react';
import { useRevalidator } from 'react-router';

import { revisionLabel, revisionSourceName } from '../components/revision-label.js';
import { createArtifactShare, DashboardApiError } from './api.js';
import { Modal, SecretReveal } from './dialogs.js';

export function ShareDialog({
  workspaceId,
  artifactId,
  revisions,
  open,
  onOpenChange,
}: {
  readonly workspaceId: string;
  readonly artifactId: string;
  readonly revisions: readonly ArtifactRevision[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const revalidator = useRevalidator();
  const [mode, setMode] = useState<'latest' | 'pinned'>('latest');
  const [revisionId, setRevisionId] = useState(revisions[0]?.revisionId ?? '');
  const [expiresAt, setExpiresAt] = useState('');
  const [shareUrl, setShareUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const idempotencyRef = useRef<{ intent: string; key: string } | undefined>(undefined);
  const close = (next: boolean) => {
    if (!next && busy) return;
    if (!next) {
      setShareUrl(undefined);
      setError(undefined);
      idempotencyRef.current = undefined;
    }
    onOpenChange(next);
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const target = mode === 'latest' ? { mode } : { mode, revisionId };
      const expiry = expiresAt === '' ? null : new Date(expiresAt).toISOString();
      const intent = JSON.stringify({ target, expiresAt: expiry });
      if (idempotencyRef.current?.intent !== intent) {
        idempotencyRef.current = { intent, key: crypto.randomUUID() };
      }
      const result = await createArtifactShare(
        workspaceId,
        artifactId,
        target,
        expiry,
        idempotencyRef.current.key,
      );
      idempotencyRef.current = undefined;
      setShareUrl(new URL(result.url, window.location.origin).href);
      void revalidator.revalidate();
    } catch (caught) {
      setError(caught instanceof DashboardApiError ? caught.message : 'Share creation failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      canClose={!busy}
      description="Anyone with the generated capability link can open this unlisted artifact."
      onOpenChange={close}
      open={open}
      title="Create share link"
    >
      {shareUrl === undefined ? (
        <form className="dialog-form" onSubmit={create}>
          <Radio.Group
            className="choice-group"
            legend="Link target"
            name="share-mode"
            onValueChange={(value) => setMode(value)}
            value={mode}
          >
            <Radio.Item
              label={
                <span>
                  <strong>Latest</strong>
                  <small>Follows the artifact as new revisions arrive.</small>
                </span>
              }
              value="latest"
            />
            <Radio.Item
              label={
                <span>
                  <strong>Pinned</strong>
                  <small>Always opens one exact immutable revision.</small>
                </span>
              }
              value="pinned"
            />
          </Radio.Group>
          {mode === 'pinned' ? (
            <Select<string>
              label="Revision"
              onValueChange={(value) => setRevisionId(value ?? '')}
              renderValue={(value) => {
                const revision = revisions.find((candidate) => candidate.revisionId === value);
                return revision === undefined
                  ? null
                  : `${revisionLabel(revision.revisionNumber)} — ${revisionSourceName(revision)}`;
              }}
              value={revisionId}
            >
              {revisions.map((revision) => (
                <Select.Option key={revision.revisionId} value={revision.revisionId}>
                  {revisionLabel(revision.revisionNumber)} — {revisionSourceName(revision)}
                </Select.Option>
              ))}
            </Select>
          ) : null}
          <Input
            label="Expires"
            onChange={(event) => setExpiresAt(event.currentTarget.value)}
            required={false}
            type="datetime-local"
            value={expiresAt}
          />
          {error === undefined ? null : <p className="form-error">{error}</p>}
          <div className="dialog-actions">
            <Button disabled={busy} onClick={() => close(false)} type="button">
              Cancel
            </Button>
            <Button disabled={busy} loading={busy} type="submit" variant="primary">
              {busy ? 'Creating…' : 'Create link'}
            </Button>
          </div>
        </form>
      ) : (
        <div className="dialog-form">
          <SecretReveal
            hint="Copy this now. Shelf never includes the capability in share listings."
            label="Share URL"
            value={shareUrl}
          />
          <div className="dialog-actions">
            <Button onClick={() => close(false)} type="button" variant="primary">
              Done
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
