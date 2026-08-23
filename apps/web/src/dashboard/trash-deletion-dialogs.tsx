import { Button } from '@cloudflare/kumo/components/button';
import { Input } from '@cloudflare/kumo/components/input';
import type { TrashedArtifact } from '@shelf/contracts';
import { type FormEvent, useEffect, useRef, useState } from 'react';

import { DashboardApiError, emptyTrash, permanentlyDeleteArtifact } from './api.js';
import { Modal } from './dialogs.js';

export function PermanentlyDeleteArtifactDialog({
  item,
  onOpenChange,
  onDeleted,
}: {
  readonly item: TrashedArtifact | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDeleted: (artifactId: string) => void;
}) {
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const confirmationRef = useRef<HTMLInputElement>(null);
  const artifactId = item?.artifact.artifactId;
  useEffect(() => {
    if (item !== undefined) {
      setConfirmation('');
      setError(undefined);
    }
  }, [item]);
  const close = (open: boolean) => {
    if (!open && busy) return;
    if (!open) {
      setConfirmation('');
      setError(undefined);
    }
    onOpenChange(open);
  };
  const confirmed = artifactId !== undefined && confirmation.trim() === artifactId;
  const remove = async (event: FormEvent) => {
    event.preventDefault();
    if (artifactId === undefined || !confirmed) return;
    setBusy(true);
    setError(undefined);
    try {
      await permanentlyDeleteArtifact(artifactId);
      onDeleted(artifactId);
    } catch (caught) {
      setError(
        caught instanceof DashboardApiError
          ? caught.message
          : 'Permanent artifact deletion failed.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      canClose={!busy}
      description="This cannot be undone. Shelf removes every revision and discussion immediately, then deletes unreferenced content from storage in the background."
      initialFocus={confirmationRef}
      onOpenChange={close}
      open={item !== undefined}
      title="Delete permanently?"
    >
      <form className="dialog-form" onSubmit={(event) => void remove(event)}>
        <div className="confirmation-block">
          <span>Artifact</span>
          <strong>{item?.artifact.name}</strong>
          <code>{artifactId}</code>
        </div>
        <Input
          autoComplete="off"
          description="Type the artifact ID to confirm."
          label="Confirm artifact ID"
          maxLength={26}
          onChange={(event) => setConfirmation(event.currentTarget.value)}
          placeholder={artifactId}
          ref={confirmationRef}
          value={confirmation}
        />
        {error === undefined ? null : <p className="form-error">{error}</p>}
        <div className="dialog-actions">
          <Button disabled={busy} onClick={() => close(false)} type="button">
            Cancel
          </Button>
          <Button disabled={busy || !confirmed} loading={busy} type="submit" variant="destructive">
            {busy ? 'Deleting…' : 'Delete permanently'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function EmptyTrashDialog({
  workspaceId,
  open,
  onOpenChange,
  onEmptied,
}: {
  readonly workspaceId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onEmptied: (purgedArtifactCount: number) => void;
}) {
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const confirmationRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setConfirmation('');
      setError(undefined);
    }
  }, [open]);
  const close = (next: boolean) => {
    if (!next && busy) return;
    if (!next) {
      setConfirmation('');
      setError(undefined);
    }
    onOpenChange(next);
  };
  const confirmed = confirmation.trim() === workspaceId;
  const empty = async (event: FormEvent) => {
    event.preventDefault();
    if (!confirmed) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await emptyTrash(workspaceId);
      onEmptied(result.purgedArtifactCount);
    } catch (caught) {
      setError(caught instanceof DashboardApiError ? caught.message : 'Empty Trash failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      canClose={!busy}
      description="This permanently removes every artifact in this workspace Trash. Shelf then deletes unreferenced content from storage in the background."
      initialFocus={confirmationRef}
      onOpenChange={close}
      open={open}
      title="Empty Trash?"
    >
      <form className="dialog-form" onSubmit={(event) => void empty(event)}>
        <div className="confirmation-block">
          <span>Workspace</span>
          <code>{workspaceId}</code>
        </div>
        <Input
          autoComplete="off"
          description="Type the workspace ID to confirm."
          label="Confirm workspace ID"
          maxLength={128}
          onChange={(event) => setConfirmation(event.currentTarget.value)}
          placeholder={workspaceId}
          ref={confirmationRef}
          value={confirmation}
        />
        {error === undefined ? null : <p className="form-error">{error}</p>}
        <div className="dialog-actions">
          <Button disabled={busy} onClick={() => close(false)} type="button">
            Cancel
          </Button>
          <Button disabled={busy || !confirmed} loading={busy} type="submit" variant="destructive">
            {busy ? 'Emptying…' : 'Empty Trash'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
