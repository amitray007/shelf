import {
  AccessCredentialNotFoundError,
  type AccessCredentialService,
  type CredentialAdministrationRepository,
  createDashboardAccessService,
  DashboardGrantDeniedError,
  type ManagedAccessCredentialSummary,
} from '@shelf/auth';
import { describe, expect, it, vi } from 'vitest';

const active: ManagedAccessCredentialSummary = {
  credentialId: 'crd_1234567890123456789012',
  actorId: 'act_agent',
  actorName: 'release-agent',
  createdAt: new Date('2026-08-18T00:00:00.000Z'),
  grants: [{ workspaceId: 'workspace-main', action: 'revision.read' }],
};

function fixture(overrides: Partial<CredentialAdministrationRepository> = {}) {
  const repository: CredentialAdministrationRepository = {
    async listActorGrants() {
      return [
        {
          installationId: 'installation-main',
          actorId: 'act_owner',
          workspaceId: 'workspace-main',
          action: 'revision.read',
        },
        {
          installationId: 'installation-main',
          actorId: 'act_owner',
          workspaceId: 'workspace-main',
          action: 'file.publish',
        },
      ];
    },
    async listInstallationCredentialPage() {
      return { items: [active] };
    },
    async findInstallationCredential(_installationId, credentialId) {
      return credentialId === active.credentialId ? active : undefined;
    },
    async createOwnedWorkspace(input) {
      return {
        workspaceId: input.workspaceId,
        actions: ['file.publish', 'revision.read'],
      };
    },
    async workspaceExists() {
      return true;
    },
    async grantOwnerAction() {},
    async hasGrant() {
      return true;
    },
    ...overrides,
  };
  const credentials: AccessCredentialService = {
    issueAgent: vi.fn(async () => ({
      actorId: 'act_new',
      credentialId: 'crd_abcdefghijklmnopqrstuv',
      token: `shf_v1.${'a'.repeat(22)}.${'b'.repeat(43)}`,
    })),
    rotate: vi.fn(),
    revoke: vi.fn(async () => true),
    authenticate: vi.fn(),
    authorize: vi.fn(),
  };
  return {
    repository,
    credentials,
    service: createDashboardAccessService({ repository, credentials }),
  };
}

describe('dashboard access service', () => {
  it('groups and sorts only the current actor grants', async () => {
    const { service } = fixture();
    await expect(
      service.session({ installationId: 'installation-main', actorId: 'act_owner' }),
    ).resolves.toEqual({
      actorId: 'act_owner',
      workspaces: [{ workspaceId: 'workspace-main', actions: ['file.publish', 'revision.read'] }],
    });
  });

  it('creates a workspace only when the identifier is durable', async () => {
    const created = vi.fn(async (input: { workspaceId: string }) => ({
      workspaceId: input.workspaceId,
      actions: ['file.publish', 'revision.read'] as const,
    }));
    const { service } = fixture({ createOwnedWorkspace: created });
    await expect(
      service.createWorkspace({
        installationId: 'installation-main',
        actorId: 'act_owner',
        workspaceId: 'workspace-work',
      }),
    ).resolves.toEqual({
      workspaceId: 'workspace-work',
      actions: ['file.publish', 'revision.read'],
    });
    await expect(
      service.createWorkspace({
        installationId: 'installation-main',
        actorId: 'act_owner',
        workspaceId: 'workspace/work',
      }),
    ).rejects.toThrow('workspace ID is invalid');
    expect(created).toHaveBeenCalledTimes(1);
  });

  it('issues only grants already held by the human actor', async () => {
    const { service, credentials } = fixture();
    await expect(
      service.issue({
        installationId: 'installation-main',
        actorId: 'act_owner',
        actorName: 'release-agent',
        grants: [{ workspaceId: 'workspace-main', action: 'revision.read' }],
      }),
    ).resolves.toMatchObject({ credentialId: 'crd_abcdefghijklmnopqrstuv' });
    expect(credentials.issueAgent).toHaveBeenCalledWith({
      installationId: 'installation-main',
      actorName: 'release-agent',
      createdByActorId: 'act_owner',
      grants: [{ workspaceId: 'workspace-main', action: 'revision.read' }],
    });

    await expect(
      service.issue({
        installationId: 'installation-main',
        actorId: 'act_owner',
        actorName: 'overreach',
        grants: [{ workspaceId: 'workspace-other', action: 'revision.read' }],
      }),
    ).rejects.toBeInstanceOf(DashboardGrantDeniedError);
    expect(credentials.issueAgent).toHaveBeenCalledTimes(1);
  });

  it('lists within the authenticated installation and preserves pagination', async () => {
    const list = vi.fn(async () => ({ items: [active], nextCursor: 'next-page' }));
    const { service } = fixture({ listInstallationCredentialPage: list });
    await expect(
      service.list({
        installationId: 'installation-main',
        actorId: 'act_owner',
        limit: 20,
        cursor: 'cursor',
      }),
    ).resolves.toEqual({ items: [active], nextCursor: 'next-page' });
    expect(list).toHaveBeenCalledWith({
      installationId: 'installation-main',
      limit: 20,
      cursor: 'cursor',
    });
  });

  it('scopes credential pages to a workspace held by the human actor', async () => {
    const list = vi.fn(async () => ({ items: [active] }));
    const { service } = fixture({ listInstallationCredentialPage: list });
    await expect(
      service.list({
        installationId: 'installation-main',
        actorId: 'act_owner',
        limit: 20,
        workspaceId: 'workspace-main',
      }),
    ).resolves.toEqual({ items: [active] });
    expect(list).toHaveBeenCalledWith({
      installationId: 'installation-main',
      limit: 20,
      workspaceId: 'workspace-main',
    });
    await expect(
      service.list({
        installationId: 'installation-main',
        actorId: 'act_owner',
        limit: 20,
        workspaceId: 'workspace-other',
      }),
    ).rejects.toBeInstanceOf(DashboardGrantDeniedError);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('does not reveal or mutate a missing or cross-installation credential', async () => {
    const { service, credentials } = fixture({
      async findInstallationCredential() {
        return undefined;
      },
    });
    await expect(
      service.revoke({
        installationId: 'installation-main',
        actorId: 'act_owner',
        credentialId: 'crd_abcdefghijklmnopqrstuv',
      }),
    ).rejects.toBeInstanceOf(AccessCredentialNotFoundError);
    expect(credentials.revoke).not.toHaveBeenCalled();
  });

  it('replays revocation without a second mutation', async () => {
    const { service, credentials } = fixture({
      async findInstallationCredential() {
        return { ...active, revokedAt: new Date('2026-08-18T01:00:00.000Z') };
      },
    });
    await expect(
      service.revoke({
        installationId: 'installation-main',
        actorId: 'act_owner',
        credentialId: active.credentialId,
      }),
    ).resolves.toEqual({
      credentialId: active.credentialId,
      revoked: true,
      alreadyRevoked: true,
    });
    expect(credentials.revoke).not.toHaveBeenCalled();
  });
});
