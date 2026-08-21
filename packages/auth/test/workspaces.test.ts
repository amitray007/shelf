import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceAdministrationService,
  InvalidWorkspaceIdError,
  OwnerGrantDeniedError,
  WorkspaceNotFoundError,
} from '../src/workspaces.js';

describe('workspace administration', () => {
  it('creates a workspace after validating the identifier', async () => {
    const repository = {
      createOwnedWorkspace: vi.fn(async (input: { workspaceId: string }) => ({
        workspaceId: input.workspaceId,
        actions: ['file.publish', 'revision.read'] as const,
      })),
      workspaceExists: vi.fn(async () => true),
      workspaceHasActiveArtifacts: vi.fn(async () => false),
      softDeleteWorkspace: vi.fn(),
      grantOwnerAction: vi.fn(),
      hasGrant: vi.fn(async () => true),
    };
    const service = createWorkspaceAdministrationService({
      repository,
      now: () => new Date('2026-08-18T00:00:00.000Z'),
    });

    await expect(
      service.create({
        installationId: 'installation-main',
        actorId: 'act_owner',
        workspaceId: 'workspace-work',
      }),
    ).resolves.toEqual({
      workspaceId: 'workspace-work',
      actions: ['file.publish', 'revision.read'],
    });
    await expect(
      service.create({
        installationId: 'installation-main',
        actorId: 'act_owner',
        workspaceId: 'workspace/work',
      }),
    ).rejects.toBeInstanceOf(InvalidWorkspaceIdError);
    expect(repository.createOwnedWorkspace).toHaveBeenCalledTimes(1);
  });

  it('refuses owner grants and agent grants that invent a workspace', async () => {
    const repository = {
      createOwnedWorkspace: vi.fn(),
      workspaceExists: vi.fn(async () => false),
      workspaceHasActiveArtifacts: vi.fn(async () => false),
      softDeleteWorkspace: vi.fn(),
      grantOwnerAction: vi.fn(),
      hasGrant: vi.fn(async () => false),
    };
    const service = createWorkspaceAdministrationService({ repository });
    const owner = { installationId: 'installation-main', actorId: 'act_owner' };
    await expect(
      service.grantOwner({ owner, workspaceId: 'workspace-missing', action: 'file.publish' }),
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
    await expect(
      service.assertOwnerHolds({
        owner,
        grants: [{ workspaceId: 'workspace-missing', action: 'file.publish' }],
      }),
    ).rejects.toBeInstanceOf(OwnerGrantDeniedError);
    expect(repository.grantOwnerAction).not.toHaveBeenCalled();
  });
});
