import {
  type AccessCredentialService,
  bootstrapShelfOwner,
  type CredentialAction,
  createWorkspaceAdministrationService,
  type HumanActorIdentity,
  type HumanAuth,
  type OwnerActorRepository,
  OwnerGrantDeniedError,
  resetShelfOwner,
  type WorkspaceAdministrationRepository,
} from '@shelf/auth';
import type { InstallationCredentialSummary } from '@shelf/postgres';

export interface OperatorRepository
  extends OwnerActorRepository,
    WorkspaceAdministrationRepository {
  findHumanOwnerByInstallationId(installationId: string): Promise<HumanActorIdentity | undefined>;
  listInstallationCredentials(installationId: string): Promise<InstallationCredentialSummary[]>;
  findInstallationCredential(
    installationId: string,
    credentialId: string,
  ): Promise<InstallationCredentialSummary | undefined>;
}

export interface OperatorGrant {
  workspaceId: string;
  action: CredentialAction;
}

export function createOperatorService(options: {
  installationId: string;
  repository: OperatorRepository;
  credentials: AccessCredentialService;
}) {
  async function owner(): Promise<HumanActorIdentity> {
    const found = await options.repository.findHumanOwnerByInstallationId(options.installationId);
    if (found === undefined)
      throw new Error('The Shelf installation owner has not been bootstrapped.');
    return found;
  }

  const workspaces = createWorkspaceAdministrationService({ repository: options.repository });

  return {
    bootstrap(input: {
      humanAuth: HumanAuth;
      actorName: string;
      email: string;
      name: string;
      password: string;
      grants: OperatorGrant[];
    }) {
      if (input.grants.length === 0) throw new Error('At least one explicit grant is required.');
      return bootstrapShelfOwner({
        humanAuth: input.humanAuth,
        actors: options.repository,
        installationId: options.installationId,
        actorName: input.actorName,
        identity: { email: input.email, name: input.name, password: input.password },
        grants: input.grants,
      });
    },
    reset(input: { email: string; name: string; password: string }) {
      return resetShelfOwner({
        actors: options.repository,
        installationId: options.installationId,
        identity: input,
      });
    },
    async createWorkspace(workspaceId: string) {
      const installedOwner = await owner();
      return workspaces.create({
        installationId: options.installationId,
        actorId: installedOwner.actorId,
        workspaceId,
      });
    },
    async grantOwner(input: OperatorGrant) {
      const installedOwner = await owner();
      await workspaces.grantOwner({
        owner: installedOwner,
        workspaceId: input.workspaceId,
        action: input.action,
      });
      return { workspaceId: input.workspaceId, action: input.action, granted: true as const };
    },
    async issue(input: { actorName: string; grants: OperatorGrant[] }) {
      if (input.actorName.length === 0 || input.actorName.length > 200) {
        throw new Error('The agent name is invalid.');
      }
      if (input.grants.length === 0) throw new Error('At least one explicit grant is required.');
      const installedOwner = await owner();
      try {
        await workspaces.assertOwnerHolds({ owner: installedOwner, grants: input.grants });
      } catch (error) {
        if (error instanceof OwnerGrantDeniedError) {
          throw new Error('The owner does not hold that workspace action.');
        }
        throw error;
      }
      return options.credentials.issueAgent({
        installationId: options.installationId,
        actorName: input.actorName,
        createdByActorId: installedOwner.actorId,
        grants: input.grants,
      });
    },
    async list() {
      await owner();
      return options.repository.listInstallationCredentials(options.installationId);
    },
    async rotate(credentialId: string) {
      const credential = await options.repository.findInstallationCredential(
        options.installationId,
        credentialId,
      );
      if (credential === undefined || credential.revokedAt !== undefined) {
        throw new Error('The access credential was not found or is already revoked.');
      }
      const installedOwner = await owner();
      const replacement = await options.credentials.rotate({
        credentialId,
        rotatedByActorId: installedOwner.actorId,
      });
      return { ...replacement, previousCredentialId: credentialId, previousRemainsActive: true };
    },
    async revoke(credentialId: string) {
      const credential = await options.repository.findInstallationCredential(
        options.installationId,
        credentialId,
      );
      if (credential === undefined) throw new Error('The access credential was not found.');
      if (credential.revokedAt !== undefined) {
        return { credentialId, revoked: true, alreadyRevoked: true };
      }
      const installedOwner = await owner();
      const revoked = await options.credentials.revoke({
        credentialId,
        revokedByActorId: installedOwner.actorId,
      });
      if (!revoked) {
        const current = await options.repository.findInstallationCredential(
          options.installationId,
          credentialId,
        );
        if (current?.revokedAt !== undefined) {
          return { credentialId, revoked: true, alreadyRevoked: true };
        }
        throw new Error('The access credential could not be revoked.');
      }
      return { credentialId, revoked: true, alreadyRevoked: false };
    },
  };
}
