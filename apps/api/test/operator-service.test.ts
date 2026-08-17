import type { AccessCredentialService, CredentialAction, HumanActorIdentity } from '@shelf/auth';
import { describe, expect, it, vi } from 'vitest';

import { createOperatorService, type OperatorRepository } from '../src/operator/service.js';

function fixture(owner: HumanActorIdentity | false | null = null) {
  const resolvedOwner =
    owner === null
      ? { installationId: 'installation-main', actorId: 'actor-owner' }
      : owner === false
        ? undefined
        : owner;
  const repository: OperatorRepository = {
    findHumanOwnerByInstallationId: vi.fn(async () => resolvedOwner),
    listInstallationCredentials: vi.fn(async () => []),
    findInstallationCredential: vi.fn(async () => undefined),
    withOwnerBootstrapLock: vi.fn(),
    createHumanActor: vi.fn(),
  };
  const credentials: AccessCredentialService = {
    issueAgent: vi.fn(async (request) => ({
      actorId: 'actor-agent',
      credentialId: 'credential-new',
      token: 'one-time-token',
      ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
    })),
    rotate: vi.fn(),
    revoke: vi.fn(),
    authenticate: vi.fn(),
    authorize: vi.fn(),
  };
  return {
    repository,
    credentials,
    service: createOperatorService({
      installationId: 'installation-main',
      repository,
      credentials,
    }),
  };
}

describe('operator service', () => {
  it('issues exact grants and attributes the action to the resolved owner', async () => {
    const { service, credentials } = fixture();
    const grants: Array<{ workspaceId: string; action: CredentialAction }> = [
      { workspaceId: 'workspace-main', action: 'file.publish' },
    ];

    await expect(service.issue({ actorName: 'release-agent', grants })).resolves.toMatchObject({
      token: 'one-time-token',
    });
    expect(credentials.issueAgent).toHaveBeenCalledWith({
      installationId: 'installation-main',
      actorName: 'release-agent',
      createdByActorId: 'actor-owner',
      grants,
    });
  });

  it('rejects administration when the installation owner is absent', async () => {
    const { service, credentials } = fixture(false);
    await expect(
      service.issue({
        actorName: 'release-agent',
        grants: [{ workspaceId: 'workspace-main', action: 'file.publish' }],
      }),
    ).rejects.toThrow('owner');
    expect(credentials.issueAgent).not.toHaveBeenCalled();
    await expect(service.list()).rejects.toThrow('owner');
  });

  it('makes revocation idempotent only for a credential in this installation', async () => {
    const { service, repository, credentials } = fixture();
    vi.mocked(repository.findInstallationCredential).mockResolvedValue({
      credentialId: 'credential-old',
      actorId: 'actor-agent',
      actorName: 'release-agent',
      createdAt: new Date('2026-08-17T00:00:00Z'),
      revokedAt: new Date('2026-08-17T01:00:00Z'),
      grants: [{ workspaceId: 'workspace-main', action: 'file.publish' }],
    });

    await expect(service.revoke('credential-old')).resolves.toEqual({
      credentialId: 'credential-old',
      revoked: true,
      alreadyRevoked: true,
    });
    expect(credentials.revoke).not.toHaveBeenCalled();
  });

  it('treats a concurrent successful revoke as an idempotent result', async () => {
    const { service, repository, credentials } = fixture();
    const active = {
      credentialId: 'credential-old',
      actorId: 'actor-agent',
      actorName: 'release-agent',
      createdAt: new Date('2026-08-17T00:00:00Z'),
      grants: [{ workspaceId: 'workspace-main', action: 'file.publish' as const }],
    };
    vi.mocked(repository.findInstallationCredential)
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce({ ...active, revokedAt: new Date('2026-08-17T01:00:00Z') });
    vi.mocked(credentials.revoke).mockResolvedValue(false);

    await expect(service.revoke('credential-old')).resolves.toEqual({
      credentialId: 'credential-old',
      revoked: true,
      alreadyRevoked: true,
    });
  });
});
