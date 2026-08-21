import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceAdministrationService,
  InvalidWorkspaceIdError,
  OwnerGrantDeniedError,
  WorkspaceNotEmptyError,
  WorkspaceNotFoundError,
} from '../src/workspaces.js';

const owner = { installationId: 'installation-main', actorId: 'act_owner' };
const deletedAt = new Date('2026-08-21T00:00:00.000Z');

function fixture(
  overrides: Partial<{
    workspaceHasActiveArtifacts: () => Promise<boolean>;
    hasGrant: (grant: { action: string }) => Promise<boolean>;
    softDeleteWorkspace: (input: {
      workspaceId: string;
    }) => Promise<{ workspaceId: string; alreadyDeleted: boolean } | undefined>;
  }> = {},
) {
  const repository = {
    createOwnedWorkspace: vi.fn(),
    workspaceExists: vi.fn(async () => true),
    workspaceHasActiveArtifacts: vi.fn(
      overrides.workspaceHasActiveArtifacts ?? (async () => false),
    ),
    softDeleteWorkspace: vi.fn(
      overrides.softDeleteWorkspace ??
        (async (input: { workspaceId: string }) => ({
          workspaceId: input.workspaceId,
          alreadyDeleted: false,
        })),
    ),
    grantOwnerAction: vi.fn(),
    hasGrant: vi.fn(overrides.hasGrant ?? (async () => true)),
  };
  const service = createWorkspaceAdministrationService({ repository, now: () => deletedAt });
  return { repository, service };
}

describe('workspace deletion', () => {
  it('soft-deletes an empty workspace for an owner holding both actions', async () => {
    const { repository, service } = fixture();

    await expect(service.delete({ owner, workspaceId: 'workspace-work' })).resolves.toEqual({
      workspaceId: 'workspace-work',
      deleted: true,
      alreadyDeleted: false,
    });
    expect(repository.hasGrant).toHaveBeenCalledTimes(2);
    expect(repository.hasGrant.mock.calls.map(([grant]) => grant.action)).toEqual([
      'file.publish',
      'revision.read',
    ]);
    expect(repository.softDeleteWorkspace).toHaveBeenCalledWith({
      installationId: 'installation-main',
      actorId: 'act_owner',
      workspaceId: 'workspace-work',
      deletedAt,
    });
  });

  it('requires both owner actions rather than either one alone', async () => {
    const publishOnly = fixture({
      hasGrant: async (grant) => grant.action === 'file.publish',
    });
    await expect(
      publishOnly.service.delete({ owner, workspaceId: 'workspace-work' }),
    ).rejects.toBeInstanceOf(OwnerGrantDeniedError);
    expect(publishOnly.repository.softDeleteWorkspace).not.toHaveBeenCalled();

    const readOnly = fixture({ hasGrant: async (grant) => grant.action === 'revision.read' });
    await expect(
      readOnly.service.delete({ owner, workspaceId: 'workspace-work' }),
    ).rejects.toBeInstanceOf(OwnerGrantDeniedError);
    expect(readOnly.repository.softDeleteWorkspace).not.toHaveBeenCalled();
  });

  it('refuses a workspace that still holds active artifacts before writing anything', async () => {
    const { repository, service } = fixture({ workspaceHasActiveArtifacts: async () => true });

    await expect(service.delete({ owner, workspaceId: 'workspace-work' })).rejects.toBeInstanceOf(
      WorkspaceNotEmptyError,
    );
    expect(repository.softDeleteWorkspace).not.toHaveBeenCalled();
  });

  it('reports an already-deleted workspace as an idempotent success', async () => {
    const { service } = fixture({
      softDeleteWorkspace: async (input) => ({
        workspaceId: input.workspaceId,
        alreadyDeleted: true,
      }),
    });

    await expect(service.delete({ owner, workspaceId: 'workspace-work' })).resolves.toEqual({
      workspaceId: 'workspace-work',
      deleted: true,
      alreadyDeleted: true,
    });
  });

  it('rejects an invalid workspace ID and an unknown workspace distinctly', async () => {
    const { repository, service } = fixture();
    await expect(service.delete({ owner, workspaceId: 'workspace/work' })).rejects.toBeInstanceOf(
      InvalidWorkspaceIdError,
    );
    expect(repository.hasGrant).not.toHaveBeenCalled();

    const missing = fixture({ softDeleteWorkspace: async () => undefined });
    await expect(
      missing.service.delete({ owner, workspaceId: 'workspace-gone' }),
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });
});
