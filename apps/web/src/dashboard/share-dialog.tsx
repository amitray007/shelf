import { Banner } from '@cloudflare/kumo/components/banner';
import { Button } from '@cloudflare/kumo/components/button';
import { Input } from '@cloudflare/kumo/components/input';
import { Radio } from '@cloudflare/kumo/components/radio';
import { Select } from '@cloudflare/kumo/components/select';
import { CaretRightIcon } from '@phosphor-icons/react/CaretRight';
import {
  type ArtifactRevision,
  type CommentPolicy,
  PROTECTED_SHARE_EXPIRY_OPTIONS,
  PUBLIC_SHARE_EXPIRY_OPTIONS,
} from '@shelf/contracts';
import { type FormEvent, useId, useRef, useState } from 'react';
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

export const PRIVATE_COMMENT_POLICY_DESCRIPTION =
  'Visitors see only discussions they started; admins can see all.';
export const SHARED_COMMENT_POLICY_DESCRIPTION =
  'Everyone using this link can see shared discussions.';

const commentPolicySummaries: Record<CommentPolicy, string> = {
  off: 'Comments off',
  private: 'Private comments',
  shared: 'Shared comments',
};

export function expirySummary(choice: ShareExpiryChoice): string {
  if (choice === 'never') return 'Never expires';
  if (choice === 'custom') return 'Custom expiry';
  return `Expires in ${expiryLabels[choice].toLocaleLowerCase()}`;
}

export function targetSummary(
  mode: 'latest' | 'pinned',
  revisions: readonly ArtifactRevision[],
  revisionId: string,
): string {
  if (mode === 'latest') return 'Latest revision';
  const revision = revisions.find((candidate) => candidate.revisionId === revisionId);
  return revision === undefined
    ? 'Pinned revision'
    : `Pinned: ${ordinal(revision.revisionNumber)} revision`;
}

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
  const [commentPolicy, setCommentPolicy] = useState<CommentPolicy>('off');
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState<string>();
  const [createdSummary, setCreatedSummary] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const optionsId = useId();
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
      setCommentPolicy('off');
      setOptionsOpen(false);
      setShareUrl(undefined);
      setCreatedSummary(undefined);
      setError(undefined);
      idempotencyRef.current = undefined;
    }
    onOpenChange(next);
  };
  const changeAccessType = (next: 'protected' | 'public') => {
    setAccessType(next);
    setError(undefined);
    idempotencyRef.current = undefined;
  };
  const failCreate = (message: string) => {
    setError(message);
    setOptionsOpen(true);
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
      commentPolicy,
    });
    if ('error' in built) {
      failCreate(built.error);
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
      setCreatedSummary(
        [
          accessType === 'protected' ? 'Protected' : 'Public',
          mode === 'latest'
            ? 'latest revision'
            : targetSummary(mode, revisions, revisionId).toLocaleLowerCase().replace(':', ' to'),
          'previewAt' in expiry
            ? `expires ${expiryFormatter.format(new Date(expiry.previewAt))}`
            : 'never expires',
        ].join(' · '),
      );
      void revalidator.revalidate();
    } catch (caught) {
      failCreate(caught instanceof DashboardApiError ? caught.message : 'Share creation failed.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const options: readonly ShareExpiryChoice[] =
    accessType === 'protected' ? PROTECTED_SHARE_EXPIRY_OPTIONS : PUBLIC_SHARE_EXPIRY_OPTIONS;
  const optionsSummary = [
    targetSummary(mode, revisions, revisionId),
    expirySummary(expiryChoice),
    commentPolicySummaries[commentPolicy],
    ...(accessType === 'protected' && maxSessions !== '' ? [`${maxSessions} sessions`] : []),
  ].join(' · ');
  return (
    <Modal
      canClose={!busy}
      description={
        shareUrl === undefined
          ? 'Share this artifact with people outside the workspace.'
          : 'Anyone you send this to can use it until it expires or is revoked.'
      }
      onOpenChange={close}
      open={open}
      title={shareUrl === undefined ? 'Create share link' : 'Share link created'}
    >
      {shareUrl === undefined ? (
        <form className="dialog-form share-create-form" onSubmit={create}>
          <Radio.Group
            appearance="card"
            className="share-access-group"
            legend="Access type"
            name="share-access-type"
            onValueChange={(value) => changeAccessType(value === 'public' ? 'public' : 'protected')}
            orientation="horizontal"
            value={accessType}
          >
            <Radio.Item
              description="Private capability with optional expiry and viewer-session limit."
              label="Protected"
              value="protected"
            />
            <Radio.Item
              description="Short unlisted URL with optional expiry."
              label="Public"
              value="public"
            />
          </Radio.Group>

          <div className="share-options">
            <button
              aria-controls={optionsId}
              aria-expanded={optionsOpen}
              className="share-options-trigger"
              onClick={() => setOptionsOpen((current) => !current)}
              type="button"
            >
              <CaretRightIcon aria-hidden="true" className="share-options-caret" weight="bold" />
              <span className="share-options-label">Options</span>
              <span className="share-options-summary">{optionsSummary}</span>
            </button>
            {optionsOpen ? (
              <div className="share-options-grid" id={optionsId}>
                <div className="share-option-cell">
                  <Select<'latest' | 'pinned'>
                    className="share-option-select"
                    label="Target"
                    onValueChange={(value) => setMode(value === 'pinned' ? 'pinned' : 'latest')}
                    renderValue={(value) =>
                      value === 'pinned' ? 'Pinned revision' : 'Latest revision'
                    }
                    value={mode}
                  >
                    <Select.Option value="latest">Latest revision</Select.Option>
                    <Select.Option value="pinned">Pinned revision</Select.Option>
                  </Select>
                  {mode === 'pinned' ? (
                    <Select<string>
                      className="share-option-select"
                      label="Revision"
                      onValueChange={(value) => setRevisionId(value ?? '')}
                      renderValue={(value) => {
                        const revision = revisions.find(
                          (candidate) => candidate.revisionId === value,
                        );
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
                </div>

                <div className="share-option-cell">
                  <Select<CommentPolicy>
                    className="share-option-select"
                    label="Comments"
                    onValueChange={(value) =>
                      setCommentPolicy(value === 'private' || value === 'shared' ? value : 'off')
                    }
                    renderValue={(value) =>
                      value === 'private' ? 'Private' : value === 'shared' ? 'Shared' : 'Off'
                    }
                    value={commentPolicy}
                  >
                    <Select.Option value="off">Off</Select.Option>
                    <Select.Option value="private">Private</Select.Option>
                    <Select.Option value="shared">Shared</Select.Option>
                  </Select>
                  {commentPolicy === 'off' ? null : (
                    <p className="share-policy-help">
                      {commentPolicy === 'private'
                        ? PRIVATE_COMMENT_POLICY_DESCRIPTION
                        : SHARED_COMMENT_POLICY_DESCRIPTION}
                    </p>
                  )}
                </div>

                <div className="share-option-cell">
                  <Select<ShareExpiryChoice>
                    className="share-option-select"
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
                </div>

                {accessType === 'protected' ? (
                  <div className="share-option-cell">
                    <Input
                      label="Session limit"
                      max={1_000_000}
                      min={1}
                      onChange={(event) => setMaxSessions(event.currentTarget.value)}
                      placeholder="Unlimited"
                      type="number"
                      value={maxSessions}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

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
              {busy
                ? 'Creating…'
                : accessType === 'protected'
                  ? 'Create protected link'
                  : 'Create public link'}
            </Button>
          </div>
        </form>
      ) : (
        <div className="dialog-form">
          {createdSummary === undefined ? null : (
            <p className="share-created-summary">{createdSummary}</p>
          )}
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
