import { PUBLISH_OPERATION } from '@shelf/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  type ArtifactRetentionRepository,
  createArtifactRetentionService,
  type StoredTrashedArtifact,
} from '../src/index.js';

const artifactId = `art_${'a'.repeat(22)}`;
const trashed: StoredTrashedArtifact = {
  artifact: {
    installationId: 'installation-main',
    workspaceId: 'workspace-main',
    artifactId,
    kind: 'file',
    name: 'Report',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    retentionMode: 'automatic',
    autoTrashAt: null,
    latestRevision: {
      kind: 'file',
      revisionId: `rev_${'b'.repeat(22)}`,
      revisionNumber: 1,
      originalFileName: 'report.md',
      mediaType: 'text/markdown',
      contentHash: `sha256:${'c'.repeat(64)}`,
      byteCount: 10,
      fileCount: 1,
      createdAt: '2026-08-01T00:00:00.000Z',
      provenance: {
        classification: 'direct-publish',
        observed: { actorId: 'actor-owner', operation: 'file.publish' },
      },
      publisherMetadata: {},
    },
  },
  deletedAt: '2026-08-24T00:00:00.000Z',
  purgeAt: '2026-09-23T00:00:00.000Z',
  reason: 'manual',
};

function repository(purgeTrashedArtifacts: ArtifactRetentionRepository['purgeTrashedArtifacts']) {
  return {
    async findTrashedArtifact(candidate: string) {
      return candidate === artifactId ? trashed : undefined;
    },
    async listTrashedArtifacts() {
      return { items: [] };
    },
    async setArtifactRetention() {
      return undefined;
    },
    purgeTrashedArtifacts,
  } satisfies ArtifactRetentionRepository;
}

describe('artifact retention destructive operations', () => {
  it('requires publish authority and exact confirmation for permanent deletion', async () => {
    const authorize = vi.fn().mockResolvedValue(undefined);
    const purge = vi.fn().mockResolvedValue(1);
    const service = createArtifactRetentionService({
      authorizer: { authorize },
      artifacts: repository(purge),
      clock: () => new Date('2026-08-24T12:00:00.000Z'),
    });

    await expect(
      service.permanentlyDelete({
        installationId: 'installation-main',
        actorId: 'actor-owner',
        artifactId,
        confirmation: artifactId,
      }),
    ).resolves.toEqual({
      apiVersion: 'v1',
      workspaceId: 'workspace-main',
      artifactId,
      status: 'purged',
    });
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ action: PUBLISH_OPERATION, workspaceId: 'workspace-main' }),
      undefined,
    );
    expect(purge).toHaveBeenCalledWith({
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      artifactId,
      purgedAt: '2026-08-24T12:00:00.000Z',
    });

    authorize.mockClear();
    purge.mockClear();
    await expect(
      service.permanentlyDelete({
        installationId: 'installation-main',
        actorId: 'actor-owner',
        artifactId,
        confirmation: `art_${'z'.repeat(22)}`,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(authorize).not.toHaveBeenCalled();
    expect(purge).not.toHaveBeenCalled();
  });

  it('empties only the confirmed authorized workspace', async () => {
    const authorize = vi.fn().mockResolvedValue(undefined);
    const purge = vi.fn().mockResolvedValue(4);
    const service = createArtifactRetentionService({
      authorizer: { authorize },
      artifacts: repository(purge),
      clock: () => new Date('2026-08-24T12:00:00.000Z'),
    });

    await expect(
      service.emptyTrash({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        actorId: 'actor-owner',
        confirmation: 'workspace-main',
      }),
    ).resolves.toEqual({
      apiVersion: 'v1',
      workspaceId: 'workspace-main',
      purgedArtifactCount: 4,
    });
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ action: PUBLISH_OPERATION, workspaceId: 'workspace-main' }),
      undefined,
    );
    expect(purge).toHaveBeenCalledWith({
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      purgedAt: '2026-08-24T12:00:00.000Z',
    });
  });
});
