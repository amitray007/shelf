import { describe, expect, it } from 'vitest';

import {
  type AccessCredentialRepository,
  type AuthenticateCredentialInput,
  type AuthenticatedActor,
  type CreateActorCredentialInput,
  type CreateRotatedCredentialInput,
  type CredentialGrant,
  createAccessCredentialService,
  type RevokeCredentialInput,
  type RotatedCredentialActor,
} from '../src/index.js';

class MemoryAccessCredentialRepository implements AccessCredentialRepository {
  readonly credentials = new Map<
    string,
    {
      actorId: string;
      installationId: string;
      digest: string;
      expiresAt?: Date;
      revokedAt?: Date;
    }
  >();
  readonly grants: CredentialGrant[] = [];

  async createActorCredential(input: CreateActorCredentialInput): Promise<void> {
    this.credentials.set(input.credentialId, {
      actorId: input.actorId,
      installationId: input.installationId,
      digest: input.digest,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    });
    this.grants.push(...input.grants.map((grant) => ({ ...grant, actorId: input.actorId })));
  }

  async authenticateCredential(
    input: AuthenticateCredentialInput,
  ): Promise<AuthenticatedActor | undefined> {
    const credential = this.credentials.get(input.credentialId);
    if (
      credential === undefined ||
      credential.digest !== input.digest ||
      credential.revokedAt !== undefined ||
      (credential.expiresAt !== undefined && credential.expiresAt <= input.usedAt)
    ) {
      return undefined;
    }
    return {
      installationId: credential.installationId,
      actorId: credential.actorId,
      credentialId: input.credentialId,
      authenticationMethod: 'access-credential',
    };
  }

  async hasGrant(grant: CredentialGrant): Promise<boolean> {
    return this.grants.some(
      (stored) =>
        stored.actorId === grant.actorId &&
        stored.installationId === grant.installationId &&
        stored.workspaceId === grant.workspaceId &&
        stored.action === grant.action,
    );
  }

  async createRotatedCredential(
    input: CreateRotatedCredentialInput,
  ): Promise<RotatedCredentialActor | undefined> {
    const previous = this.credentials.get(input.previousCredentialId);
    if (previous === undefined || previous.revokedAt !== undefined) return undefined;
    this.credentials.set(input.credentialId, {
      actorId: previous.actorId,
      installationId: previous.installationId,
      digest: input.digest,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    });
    return { actorId: previous.actorId, installationId: previous.installationId };
  }

  async revokeCredential(input: RevokeCredentialInput): Promise<boolean> {
    const credential = this.credentials.get(input.credentialId);
    if (credential === undefined || credential.revokedAt !== undefined) return false;
    credential.revokedAt = input.revokedAt;
    return true;
  }
}

describe('access credential service', () => {
  it('issues one opaque secret for a scoped service actor and authenticates it', async () => {
    const repository = new MemoryAccessCredentialRepository();
    const credentials = createAccessCredentialService({ repository });

    const issued = await credentials.issueAgent({
      installationId: 'installation-main',
      actorName: 'release-agent',
      createdByActorId: 'actor-owner',
      grants: [{ workspaceId: 'workspace-main', action: 'file.publish' }],
    });

    expect(issued.token).toMatch(/^shf_v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    const authenticated = await credentials.authenticate(issued.token);
    expect(authenticated).toEqual({
      installationId: 'installation-main',
      actorId: issued.actorId,
      credentialId: issued.credentialId,
      authenticationMethod: 'access-credential',
    });
    expect(JSON.stringify(authenticated)).not.toContain(issued.token);
    await expect(
      credentials.authorize({
        installationId: 'installation-main',
        actorId: issued.actorId,
        workspaceId: 'workspace-main',
        action: 'file.publish',
      }),
    ).resolves.toBe(true);
    await expect(
      credentials.authorize({
        installationId: 'installation-main',
        actorId: issued.actorId,
        workspaceId: 'workspace-other',
        action: 'file.publish',
      }),
    ).resolves.toBe(false);
    await expect(
      credentials.authorize({
        installationId: 'installation-main',
        actorId: issued.actorId,
        workspaceId: 'workspace-main',
        action: 'revision.read',
      }),
    ).resolves.toBe(false);
    await expect(
      credentials.authorize({
        installationId: 'installation-other',
        actorId: issued.actorId,
        workspaceId: 'workspace-main',
        action: 'file.publish',
      }),
    ).resolves.toBe(false);
  });

  it('rotates without changing the actor and revokes only the selected credential', async () => {
    const repository = new MemoryAccessCredentialRepository();
    const credentials = createAccessCredentialService({ repository });
    const issued = await credentials.issueAgent({
      installationId: 'installation-main',
      actorName: 'release-agent',
      createdByActorId: 'actor-owner',
      grants: [{ workspaceId: 'workspace-main', action: 'file.publish' }],
    });

    const replacement = await credentials.rotate({
      credentialId: issued.credentialId,
      rotatedByActorId: 'actor-owner',
    });
    expect(replacement.actorId).toBe(issued.actorId);
    await expect(credentials.authenticate(issued.token)).resolves.toMatchObject({
      actorId: issued.actorId,
    });
    await expect(credentials.authenticate(replacement.token)).resolves.toMatchObject({
      actorId: issued.actorId,
    });

    await expect(
      credentials.revoke({
        credentialId: issued.credentialId,
        revokedByActorId: 'actor-owner',
      }),
    ).resolves.toBe(true);
    await expect(credentials.authenticate(issued.token)).resolves.toBeUndefined();
    await expect(credentials.authenticate(replacement.token)).resolves.toMatchObject({
      actorId: issued.actorId,
    });
  });

  it('fails closed for malformed, wrong, expired, and ungranted credentials', async () => {
    const repository = new MemoryAccessCredentialRepository();
    const now = new Date('2026-08-17T12:00:00.000Z');
    const credentials = createAccessCredentialService({ repository, now: () => now });
    const expired = await credentials.issueAgent({
      installationId: 'installation-main',
      actorName: 'expired-agent',
      createdByActorId: 'actor-owner',
      grants: [],
      expiresAt: now,
    });

    await expect(credentials.authenticate('not-a-shelf-token')).resolves.toBeUndefined();
    await expect(
      credentials.authenticate(`${expired.token.slice(0, -1)}x`),
    ).resolves.toBeUndefined();
    await expect(credentials.authenticate(expired.token)).resolves.toBeUndefined();
    await expect(
      credentials.authorize({
        installationId: 'installation-main',
        actorId: expired.actorId,
        workspaceId: 'workspace-main',
        action: 'file.publish',
      }),
    ).resolves.toBe(false);
    await expect(
      credentials.authorize({
        installationId: 'installation-other',
        actorId: expired.actorId,
        workspaceId: 'workspace-main',
        action: 'revision.read',
      }),
    ).resolves.toBe(false);
  });
});
