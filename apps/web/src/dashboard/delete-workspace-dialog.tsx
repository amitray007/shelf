import { Button } from '@cloudflare/kumo/components/button';
import { Input } from '@cloudflare/kumo/components/input';
import { type FormEvent, useEffect, useRef, useState } from 'react';

import { DashboardApiError, deleteWorkspace } from './api.js';
import { Modal } from './dialogs.js';

export function DeleteWorkspaceDialog({
  workspaceId,
  onOpenChange,
  onDeleted,
}: {
  readonly workspaceId: string | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDeleted: (workspaceId: string) => void;
}) {
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const confirmationRef = useRef<HTMLInputElement>(null);
  const open = workspaceId !== undefined;
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
  const confirmed = workspaceId !== undefined && confirmation.trim() === workspaceId;
  const remove = async (event: FormEvent) => {
    event.preventDefault();
    if (workspaceId === undefined || !confirmed) return;
    setBusy(true);
    setError(undefined);
    try {
      await deleteWorkspace(workspaceId);
      onDeleted(workspaceId);
    } catch (caught) {
      setError(caught instanceof DashboardApiError ? caught.message : 'Workspace deletion failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      canClose={!busy}
      description="A workspace can only be deleted once it holds no artifacts. Delete every artifact first. The workspace ID stays reserved and cannot be reused."
      initialFocus={confirmationRef}
      onOpenChange={close}
      open={open}
      title="Delete workspace?"
    >
      <form className="dialog-form" onSubmit={(event) => void remove(event)}>
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
            {busy ? 'Deleting…' : 'Delete workspace'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
