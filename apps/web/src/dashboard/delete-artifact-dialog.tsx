import { Button } from '@cloudflare/kumo/components/button';
import type { Artifact, ArtifactDeletionResult } from '@shelf/contracts';
import { useState } from 'react';

import { DashboardApiError, deleteArtifact } from './api.js';
import { Modal } from './dialogs.js';

export function DeleteArtifactDialog({
  artifact,
  onOpenChange,
  onDeleted,
}: {
  readonly artifact: Artifact | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDeleted: (artifact: Artifact, result: ArtifactDeletionResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const close = (open: boolean) => {
    if (!open && busy) return;
    if (!open) setError(undefined);
    onOpenChange(open);
  };
  const remove = async () => {
    if (artifact === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await deleteArtifact(artifact.artifactId);
      onDeleted(artifact, result);
    } catch (caught) {
      setError(caught instanceof DashboardApiError ? caught.message : 'Artifact deletion failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      canClose={!busy}
      description="The artifact leaves the catalog immediately and active share links are revoked. Its immutable content remains recoverable for 30 days."
      onOpenChange={close}
      open={artifact !== undefined}
      title="Delete artifact?"
    >
      <div className="dialog-form">
        <div className="confirmation-block">
          <span>Artifact</span>
          <strong>{artifact?.name}</strong>
          <code>{artifact?.artifactId}</code>
        </div>
        {error === undefined ? null : <p className="form-error">{error}</p>}
        <div className="dialog-actions">
          <Button disabled={busy} onClick={() => close(false)} type="button">
            Cancel
          </Button>
          <Button
            disabled={busy}
            loading={busy}
            onClick={remove}
            type="button"
            variant="destructive"
          >
            {busy ? 'Deleting…' : 'Delete artifact'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
