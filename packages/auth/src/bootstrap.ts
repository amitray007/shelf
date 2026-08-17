import { randomBytes } from 'node:crypto';

import type {
  CreateHumanActorInput,
  CredentialAction,
  HumanActorIdentity,
} from './access-credentials.js';
import type { BootstrapOwnerInput, HumanAuth, HumanIdentity } from './human.js';

export interface OwnerActorRepository {
  withOwnerBootstrapLock<T>(installationId: string, operation: () => Promise<T>): Promise<T>;
  createHumanActor(input: CreateHumanActorInput): Promise<void>;
  findHumanOwnerByInstallationId(installationId: string): Promise<HumanActorIdentity | undefined>;
}

export interface BootstrapShelfOwnerInput {
  humanAuth: HumanAuth;
  actors: OwnerActorRepository;
  installationId: string;
  actorName: string;
  identity: BootstrapOwnerInput;
  grants: Array<{ workspaceId: string; action: CredentialAction }>;
  now?: () => Date;
}

export interface BootstrappedShelfOwner extends HumanIdentity, HumanActorIdentity {}

export class OwnerAlreadyExistsError extends Error {
  constructor() {
    super('This Shelf installation already has an owner.');
    this.name = 'OwnerAlreadyExistsError';
  }
}

export async function bootstrapShelfOwner(
  input: BootstrapShelfOwnerInput,
): Promise<BootstrappedShelfOwner> {
  return input.actors.withOwnerBootstrapLock(input.installationId, async () => {
    const existing = await input.actors.findHumanOwnerByInstallationId(input.installationId);
    if (existing !== undefined) throw new OwnerAlreadyExistsError();

    const identity = await input.humanAuth.bootstrapOwner(input.identity);
    const actorId = `act_${randomBytes(16).toString('base64url')}`;
    try {
      await input.actors.createHumanActor({
        installationId: input.installationId,
        actorId,
        actorName: input.actorName,
        authUserId: identity.userId,
        createdAt: (input.now ?? (() => new Date()))(),
        grants: input.grants,
      });
    } catch (error) {
      const owner = await input.actors.findHumanOwnerByInstallationId(input.installationId);
      if (owner !== undefined) throw new OwnerAlreadyExistsError();
      throw error;
    }
    return { ...identity, installationId: input.installationId, actorId };
  });
}
