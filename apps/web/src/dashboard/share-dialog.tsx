import { Banner } from '@cloudflare/kumo/components/banner';
import { Button } from '@cloudflare/kumo/components/button';
import { Input } from '@cloudflare/kumo/components/input';
import { Radio } from '@cloudflare/kumo/components/radio';
import { Select } from '@cloudflare/kumo/components/select';
import {
  type ArtifactRevision,
  PROTECTED_SHARE_EXPIRY_OPTIONS,
  PUBLIC_SHARE_EXPIRY_OPTIONS,
} from '@shelf/contracts';
import { type FormEvent, useRef, useState } from 'react';
import { useRevalidator } from 'react-router';

import { ordinal, revisionSourceName } from '../components/revision-label.js';
import { createArtifactShare, DashboardApiError } from './api.js';
import { Modal, SecretReveal } from './dialogs.js';
import {
  buildShareCreateInput,
  defaultSharePolicy,
  resolveShareExpiry,
  type ShareExpiryChoice,
} from './status.js';

const expiryLabels: Record<ShareExpiryChoice, string> = {
  never: 'Never',
  '5m': '5 minutes',
  '30m': '30 minutes',
  '2hr': '2 hours',
  '6hr': '6 hours',
  '24hr': '24 hours',
  '3d': '3 days',
  '7d': '7 days',
  '15d': '15 days',
  '30d': '30 days',
  custom: 'Custom',
};
const expiryFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

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
  const [accessType, setAccessType] = useState<'protected' | 'public'>('protected');
  const [mode, setMode] = useState<'latest' | 'pinned'>('latest');
  const [revisionId, setRevisionId] = useState(revisions[0]?.revisionId ?? '');
  const [expiryChoice, setExpiryChoice] = useState<ShareExpiryChoice>('never');
  const [customExpiresAt, setCustomExpiresAt] = useState('');
  const [maxSessions, setMaxSessions] = useState('');
  const [shareUrl, setShareUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const idempotencyRef = useRef<{ intent: string; key: string } | undefined>(undefined);
  const close = (next: boolean) => {
    if (!next && busyRef.current) return;
    if (!next) {
      const defaults = defaultSharePolicy();
      setAccessType('protected');
      setMode('latest');
      setRevisionId(revisions[0]?.revisionId ?? '');
      setExpiryChoice(defaults.expiryChoice);
      setCustomExpiresAt(defaults.customExpiresAt);
      setMaxSessions(defaults.maxSessions);
      setShareUrl(undefined);
      setError(undefined);
      idempotencyRef.current = undefined;
    }
    onOpenChange(next);
  };
  const changeAccessType = (next: 'protected' | 'public') => {
    const defaults = defaultSharePolicy();
    setAccessType(next);
    setExpiryChoice(defaults.expiryChoice);
    setCustomExpiresAt(defaults.customExpiresAt);
    setMaxSessions(defaults.maxSessions);
    setError(undefined);
    idempotencyRef.current = undefined;
  };
  const expiry = resolveShareExpiry(accessType, expiryChoice, customExpiresAt);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (busyRef.current) return;
    const built = buildShareCreateInput({
      accessType,
      targetMode: mode,
      revisionId,
      expiryChoice,
      customExpiresAt,
      maxSessions,
    });
    if ('error' in built) {
      setError(built.error);
      return;
    }
    const { input } = built;
    const intent = JSON.stringify(input);
    if (idempotencyRef.current?.intent !== intent) {
      idempotencyRef.current = { intent, key: crypto.randomUUID() };
    }
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const result = await createArtifactShare(
        workspaceId,
        artifactId,
        input,
        idempotencyRef.current.key,
      );
      idempotencyRef.current = undefined;
      setShareUrl(new URL(result.url, window.location.origin).href);
      void revalidator.revalidate();
    } catch (caught) {
      setError(caught instanceof DashboardApiError ? caught.message : 'Share creation failed.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const options: readonly ShareExpiryChoice[] =
    accessType === 'protected' ? PROTECTED_SHARE_EXPIRY_OPTIONS : PUBLIC_SHARE_EXPIRY_OPTIONS;
  return (
    <Modal
      canClose={!busy}
      description={
        accessType === 'protected'
          ? 'Protected links require their private capability before a viewer session can begin.'
          : 'Public links are unlisted and accessible to anyone with the URL.'
      }
      onOpenChange={close}
      open={open}
      title="Create share link"
    >
      {shareUrl === undefined ? (
        <form className="dialog-form" onSubmit={create}>
          <Radio.Group
            className="choice-group"
            legend="Access type"
            name="share-access-type"
            onValueChange={(value) => changeAccessType(value === 'public' ? 'public' : 'protected')}
            value={accessType}
          >
            <Radio.Item
              label={
                <span>
                  <strong>Protected</strong>
                  <small>Private capability with optional expiry and viewer-session limit.</small>
                </span>
              }
              value="protected"
            />
            <Radio.Item
              label={
                <span>
                  <strong>Public</strong>
                  <small>Short unlisted URL with optional expiry.</small>
                </span>
              }
              value="public"
            />
          </Radio.Group>

          <Radio.Group
            className="choice-group compact-choice-group"
            legend="Target"
            name="share-mode"
            onValueChange={(value) => setMode(value === 'pinned' ? 'pinned' : 'latest')}
            value={mode}
          >
            <Radio.Item label="Latest revision" value="latest" />
            <Radio.Item label="Pinned revision" value="pinned" />
          </Radio.Group>
          {mode === 'pinned' ? (
            <Select<string>
              label="Revision"
              onValueChange={(value) => setRevisionId(value ?? '')}
              renderValue={(value) => {
                const revision = revisions.find((candidate) => candidate.revisionId === value);
                return revision === undefined
                  ? null
                  : `${ordinal(revision.revisionNumber)} — ${revisionSourceName(revision)}`;
              }}
              value={revisionId}
            >
              {revisions.map((revision) => (
                <Select.Option key={revision.revisionId} value={revision.revisionId}>
                  {ordinal(revision.revisionNumber)} — {revisionSourceName(revision)}
                </Select.Option>
              ))}
            </Select>
          ) : null}

          <Select<ShareExpiryChoice>
            label="Expiry"
            onValueChange={(value) => {
              setExpiryChoice(value ?? 'never');
              setError(undefined);
            }}
            renderValue={(value) => (value === null ? null : expiryLabels[value])}
            value={expiryChoice}
          >
            {options.map((option) => (
              <Select.Option key={option} value={option}>
                {expiryLabels[option]}
              </Select.Option>
            ))}
          </Select>
          {expiryChoice === 'custom' ? (
            <Input
              label={`Custom expiry (${Intl.DateTimeFormat().resolvedOptions().timeZone})`}
              onChange={(event) => setCustomExpiresAt(event.currentTarget.value)}
              required
              type="datetime-local"
              value={customExpiresAt}
            />
          ) : null}
          {'previewAt' in expiry ? (
            <p className="expiry-preview">
              Expires{' '}
              <time dateTime={expiry.previewAt}>
                {expiryFormatter.format(new Date(expiry.previewAt))}
              </time>
            </p>
          ) : null}

          {accessType === 'protected' ? (
            <Input
              label="Viewer sessions (optional)"
              max={1_000_000}
              min={1}
              onChange={(event) => setMaxSessions(event.currentTarget.value)}
              placeholder="Unlimited"
              type="number"
              value={maxSessions}
            />
          ) : null}

          {error === undefined ? null : (
            <Banner
              description={error}
              role="alert"
              size="sm"
              title="Link wasn't created"
              variant="error"
            />
          )}
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
            hint="You can copy this link again later from the artifact's Links tab."
            label={accessType === 'protected' ? 'Protected share URL' : 'Public share URL'}
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
