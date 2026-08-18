import type {
  DashboardCredentialAction,
  DashboardCredentialGrant,
  DashboardWorkspace,
} from '@shelf/contracts';
import { isWorkspaceId } from '@shelf/contracts';

import {
  AccessCredentialNotFoundError,
  type AccessCredentialService,
  type AccessCredentialSummary,
  type CredentialGrant,
} from './access-credentials.js';
import { InvalidWorkspaceIdError, type WorkspaceAdministrationRepository } from './workspaces.js';

export interface ManagedAccessCredentialSummary extends AccessCredentialSummary {
  actorName: string;
  grants: DashboardCredentialGrant[];
}

export interface CredentialAdministrationRepository extends WorkspaceAdministrationRepository {
  listActorGrants(input: { installationId: string; actorId: string }): Promise<CredentialGrant[]>;
  listInstallationCredentialPage(input: {
    installationId: string;
    limit: number;
    cursor?: string;
    workspaceId?: string;
  }): Promise<{ items: ManagedAccessCredentialSummary[]; nextCursor?: string }>;
  findInstallationCredential(
    installationId: string,
    credentialId: string,
  ): Promise<ManagedAccessCredentialSummary | undefined>;
}

export class DashboardGrantDeniedError extends Error {
  constructor() {
    super('The requested credential grant is not held by this actor.');
    this.name = 'DashboardGrantDeniedError';
  }
}

export class InvalidCredentialPageError extends Error {
  constructor() {
    super('The credential page request is invalid.');
    this.name = 'InvalidCredentialPageError';
  }
}

export function createDashboardAccessService(options: {
  repository: CredentialAdministrationRepository;
  credentials: AccessCredentialService;
}) {
  async function grantsFor(input: {
    installationId: string;
    actorId: string;
  }): Promise<CredentialGrant[]> {
    return options.repository.listActorGrants(input);
  }

  return {
    async session(input: { installationId: string; actorId: string }): Promise<{
      actorId: string;
      workspaces: DashboardWorkspace[];
    }> {
      const grants = await grantsFor(input);
      const actionsByWorkspace = new Map<string, Set<DashboardCredentialAction>>();
      for (const grant of grants) {
        const actions = actionsByWorkspace.get(grant.workspaceId) ?? new Set();
        actions.add(grant.action);
        actionsByWorkspace.set(grant.workspaceId, actions);
      }
      return {
        actorId: input.actorId,
        workspaces: [...actionsByWorkspace]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([workspaceId, actions]) => ({
            workspaceId,
            actions: [...actions].sort(),
          })),
      };
    },

    async issue(input: {
      installationId: string;
      actorId: string;
      actorName: string;
      grants: DashboardCredentialGrant[];
      expiresAt?: Date;
    }) {
      const held = new Set(
        (await grantsFor(input)).map((grant) => `${grant.workspaceId}\u0000${grant.action}`),
      );
      if (input.grants.some((grant) => !held.has(`${grant.workspaceId}\u0000${grant.action}`))) {
        throw new DashboardGrantDeniedError();
      }
      const issued = await options.credentials.issueAgent({
        installationId: input.installationId,
        actorName: input.actorName,
        createdByActorId: input.actorId,
        grants: input.grants,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      });
      return { ...issued, actorName: input.actorName, grants: input.grants };
    },

    async list(input: {
      installationId: string;
      actorId: string;
      limit: number;
      cursor?: string;
      workspaceId?: string;
    }) {
      if (
        input.workspaceId !== undefined &&
        !(await grantsFor(input)).some((grant) => grant.workspaceId === input.workspaceId)
      ) {
        throw new DashboardGrantDeniedError();
      }
      return options.repository.listInstallationCredentialPage({
        installationId: input.installationId,
        limit: input.limit,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      });
    },

    async createWorkspace(input: {
      installationId: string;
      actorId: string;
      workspaceId: string;
    }): Promise<{ workspaceId: string; actions: DashboardCredentialAction[] }> {
      if (!isWorkspaceId(input.workspaceId)) throw new InvalidWorkspaceIdError();
      const created = await options.repository.createOwnedWorkspace({
        ...input,
        createdAt: new Date(),
      });
      return { workspaceId: created.workspaceId, actions: [...created.actions] };
    },

    async revoke(input: {
      installationId: string;
      actorId: string;
      credentialId: string;
    }): Promise<{ credentialId: string; revoked: true; alreadyRevoked: boolean }> {
      const credential = await options.repository.findInstallationCredential(
        input.installationId,
        input.credentialId,
      );
      if (credential === undefined) throw new AccessCredentialNotFoundError();
      if (credential.revokedAt !== undefined) {
        return { credentialId: input.credentialId, revoked: true, alreadyRevoked: true };
      }
      const revoked = await options.credentials.revoke({
        credentialId: input.credentialId,
        revokedByActorId: input.actorId,
      });
      if (revoked) {
        return { credentialId: input.credentialId, revoked: true, alreadyRevoked: false };
      }
      const current = await options.repository.findInstallationCredential(
        input.installationId,
        input.credentialId,
      );
      if (current?.revokedAt !== undefined) {
        return { credentialId: input.credentialId, revoked: true, alreadyRevoked: true };
      }
      throw new AccessCredentialNotFoundError();
    },
  };
}

export type DashboardAccessService = ReturnType<typeof createDashboardAccessService>;
