import { Button } from '@cloudflare/kumo/components/button';
import { Input } from '@cloudflare/kumo/components/input';
import { type FormEvent, useRef, useState } from 'react';

import { createWorkspace, DashboardApiError } from './api.js';
import { Modal } from './dialogs.js';

export function CreateWorkspaceDialog({
  open,
  onCreated,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onCreated: (workspaceId: string) => void;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [workspaceId, setWorkspaceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const idRef = useRef<HTMLInputElement>(null);
  const close = (next: boolean) => {
    if (!next && busy) return;
    if (!next) {
      setWorkspaceId('');
      setError(undefined);
    }
    onOpenChange(next);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const created = await createWorkspace(workspaceId.trim());
      setWorkspaceId('');
      onCreated(created.workspaceId);
    } catch (caught) {
      setError(caught instanceof DashboardApiError ? caught.message : 'Workspace creation failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      canClose={!busy}
      description="Creates an isolated artifact namespace. The owner can publish and read there immediately."
      initialFocus={idRef}
      onOpenChange={close}
      open={open}
      title="New workspace"
    >
      <form className="dialog-form" onSubmit={(event) => void submit(event)}>
        <Input
          description="Letters, numbers, dots, underscores, and hyphens."
          label="Workspace ID"
          maxLength={128}
          onChange={(event) => setWorkspaceId(event.currentTarget.value)}
          pattern="[A-Za-z0-9](?:[A-Za-z0-9._]|-){0,127}"
          placeholder="workspace-work"
          ref={idRef}
          required
          value={workspaceId}
        />
        {error === undefined ? null : <p className="form-error">{error}</p>}
        <div className="dialog-actions">
          <Button disabled={busy} onClick={() => close(false)} type="button">
            Cancel
          </Button>
          <Button disabled={busy} loading={busy} type="submit" variant="primary">
            {busy ? 'Creating…' : 'Create workspace'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
