import { randomBytes } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';

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
  resetHumanOwner(input: ResetHumanOwnerInput): Promise<ResetHumanOwnerResult | undefined>;
}

export interface ResetHumanOwnerInput {
  installationId: string;
  actorName: string;
  email: string;
  name: string;
  passwordHash: string;
}

export interface ResetHumanOwnerResult extends HumanActorIdentity {
  email: string;
  name: string;
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

export class OwnerNotFoundError extends Error {
  constructor() {
    super('This Shelf installation does not have an owner.');
    this.name = 'OwnerNotFoundError';
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

export async function resetShelfOwner(input: {
  actors: OwnerActorRepository;
  installationId: string;
  identity: BootstrapOwnerInput;
}): Promise<ResetHumanOwnerResult> {
  const email = input.identity.email.trim().toLowerCase();
  const name = input.identity.name.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new Error('The owner email is invalid.');
  if (name.length === 0 || name.length > 128) throw new Error('The owner name is invalid.');
  if (input.identity.password.length < 8 || input.identity.password.length > 128) {
    throw new Error('The owner password must contain between 8 and 128 characters.');
  }
  const passwordHash = await hashPassword(input.identity.password);
  return input.actors.withOwnerBootstrapLock(input.installationId, async () => {
    const owner = await input.actors.resetHumanOwner({
      installationId: input.installationId,
      actorName: name,
      email,
      name,
      passwordHash,
    });
    if (owner === undefined) throw new OwnerNotFoundError();
    return owner;
  });
}
