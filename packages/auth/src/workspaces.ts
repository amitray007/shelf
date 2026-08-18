import type { DashboardCredentialAction } from '@shelf/contracts';
import { isWorkspaceId, PUBLISH_OPERATION, READ_REVISION_OPERATION } from '@shelf/contracts';

import type {
  CredentialAction,
  CredentialGrant,
  HumanActorIdentity,
} from './access-credentials.js';

export const OWNER_WORKSPACE_ACTIONS = [PUBLISH_OPERATION, READ_REVISION_OPERATION] as const;

export class WorkspaceAlreadyExistsError extends Error {
  constructor() {
    super('A workspace with this ID already exists.');
    this.name = 'WorkspaceAlreadyExistsError';
  }
}

export class InvalidWorkspaceIdError extends Error {
  constructor() {
    super('The workspace ID is invalid.');
    this.name = 'InvalidWorkspaceIdError';
  }
}

export class WorkspaceNotFoundError extends Error {
  constructor() {
    super('The workspace was not found.');
    this.name = 'WorkspaceNotFoundError';
  }
}

export class OwnerGrantDeniedError extends Error {
  constructor() {
    super('The owner does not hold that workspace action.');
    this.name = 'OwnerGrantDeniedError';
  }
}

export interface WorkspaceAdministrationRepository {
  createOwnedWorkspace(input: {
    installationId: string;
    actorId: string;
    workspaceId: string;
    createdAt: Date;
  }): Promise<{ workspaceId: string; actions: readonly CredentialAction[] }>;
  workspaceExists(input: { installationId: string; workspaceId: string }): Promise<boolean>;
  grantOwnerAction(input: {
    installationId: string;
    actorId: string;
    workspaceId: string;
    action: CredentialAction;
    grantedAt: Date;
  }): Promise<void>;
  hasGrant(grant: CredentialGrant): Promise<boolean>;
}

export function createWorkspaceAdministrationService(options: {
  repository: WorkspaceAdministrationRepository;
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());

  return {
    async create(input: {
      installationId: string;
      actorId: string;
      workspaceId: string;
    }): Promise<{ workspaceId: string; actions: DashboardCredentialAction[] }> {
      if (!isWorkspaceId(input.workspaceId)) throw new InvalidWorkspaceIdError();
      const created = await options.repository.createOwnedWorkspace({
        ...input,
        createdAt: now(),
      });
      return {
        workspaceId: created.workspaceId,
        actions: [...created.actions],
      };
    },

    async grantOwner(input: {
      owner: HumanActorIdentity;
      workspaceId: string;
      action: CredentialAction;
    }): Promise<void> {
      if (!isWorkspaceId(input.workspaceId)) throw new InvalidWorkspaceIdError();
      if (
        !(await options.repository.workspaceExists({
          installationId: input.owner.installationId,
          workspaceId: input.workspaceId,
        }))
      ) {
        throw new WorkspaceNotFoundError();
      }
      await options.repository.grantOwnerAction({
        installationId: input.owner.installationId,
        actorId: input.owner.actorId,
        workspaceId: input.workspaceId,
        action: input.action,
        grantedAt: now(),
      });
    },

    async assertOwnerHolds(input: {
      owner: HumanActorIdentity;
      grants: Array<{ workspaceId: string; action: CredentialAction }>;
    }): Promise<void> {
      for (const grant of input.grants) {
        const allowed = await options.repository.hasGrant({
          installationId: input.owner.installationId,
          actorId: input.owner.actorId,
          workspaceId: grant.workspaceId,
          action: grant.action,
        });
        if (!allowed) throw new OwnerGrantDeniedError();
      }
    },
  };
}

export type WorkspaceAdministrationService = ReturnType<
  typeof createWorkspaceAdministrationService
>;
