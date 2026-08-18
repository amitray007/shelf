import { createHash, randomBytes } from 'node:crypto';

import type { PUBLISH_OPERATION, READ_REVISION_OPERATION } from '@shelf/contracts';

export type CredentialAction = typeof PUBLISH_OPERATION | typeof READ_REVISION_OPERATION;

export interface CredentialGrant {
  installationId: string;
  actorId: string;
  workspaceId: string;
  action: CredentialAction;
}

export interface CreateActorCredentialInput {
  installationId: string;
  actorId: string;
  actorName: string;
  credentialId: string;
  digest: string;
  grants: CredentialGrant[];
  createdByActorId: string;
  createdAt: Date;
  expiresAt?: Date;
}

export interface AuthenticateCredentialInput {
  credentialId: string;
  digest: string;
  usedAt: Date;
}

export interface CreateRotatedCredentialInput {
  previousCredentialId: string;
  credentialId: string;
  digest: string;
  rotatedByActorId: string;
  createdAt: Date;
  expiresAt?: Date;
}

export interface RotatedCredentialActor {
  installationId: string;
  actorId: string;
}

export interface RevokeCredentialInput {
  credentialId: string;
  revokedByActorId: string;
  revokedAt: Date;
}

export interface CreateHumanActorInput {
  installationId: string;
  actorId: string;
  actorName: string;
  authUserId: string;
  createdAt: Date;
  grants?: Array<{ workspaceId: string; action: CredentialAction }>;
}

export interface HumanActorIdentity {
  installationId: string;
  actorId: string;
}

export interface HumanActorResolver {
  findHumanActorByAuthUserId(authUserId: string): Promise<HumanActorIdentity | undefined>;
}

export interface AccessCredentialSummary {
  credentialId: string;
  actorId: string;
  createdAt: Date;
  expiresAt?: Date;
  revokedAt?: Date;
  lastUsedAt?: Date;
}

export type AuthEventType =
  | 'human-actor.created'
  | 'access-credential.issued'
  | 'access-credential.rotated'
  | 'access-credential.revoked'
  | 'workspace.created';

export interface AuthEvent {
  eventType: AuthEventType;
  installationId: string;
  actorId: string;
  credentialId?: string;
  performedByActorId: string;
  occurredAt: Date;
}

export interface AuthenticatedActor {
  installationId: string;
  actorId: string;
  credentialId: string;
  authenticationMethod: 'access-credential';
}

export interface AccessCredentialRepository {
  createActorCredential(input: CreateActorCredentialInput): Promise<void>;
  authenticateCredential(
    input: AuthenticateCredentialInput,
  ): Promise<AuthenticatedActor | undefined>;
  hasGrant(grant: CredentialGrant): Promise<boolean>;
  createRotatedCredential(
    input: CreateRotatedCredentialInput,
  ): Promise<RotatedCredentialActor | undefined>;
  revokeCredential(input: RevokeCredentialInput): Promise<boolean>;
}

export interface IssueAgentCredentialRequest {
  installationId: string;
  actorName: string;
  createdByActorId: string;
  grants: Array<{ workspaceId: string; action: CredentialAction }>;
  expiresAt?: Date;
}

export interface IssuedAccessCredential {
  actorId: string;
  credentialId: string;
  token: string;
  expiresAt?: Date;
}

export interface AccessCredentialService {
  issueAgent(request: IssueAgentCredentialRequest): Promise<IssuedAccessCredential>;
  rotate(request: RotateAccessCredentialRequest): Promise<IssuedAccessCredential>;
  revoke(request: RevokeAccessCredentialRequest): Promise<boolean>;
  authenticate(token: string): Promise<AuthenticatedActor | undefined>;
  authorize(grant: CredentialGrant): Promise<boolean>;
}

export interface RotateAccessCredentialRequest {
  credentialId: string;
  rotatedByActorId: string;
  expiresAt?: Date;
}

export interface RevokeAccessCredentialRequest {
  credentialId: string;
  revokedByActorId: string;
}

export class AccessCredentialNotFoundError extends Error {
  constructor() {
    super('The access credential was not found or is no longer active.');
    this.name = 'AccessCredentialNotFoundError';
  }
}

export interface CreateAccessCredentialServiceOptions {
  repository: AccessCredentialRepository;
  now?: () => Date;
}

function opaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('base64url')}`;
}

function createToken(): { credentialId: string; token: string } {
  const publicId = randomBytes(16).toString('base64url');
  return {
    credentialId: `crd_${publicId}`,
    token: `shf_v1.${publicId}.${randomBytes(32).toString('base64url')}`,
  };
}

function digestToken(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

function credentialIdFromToken(token: string): string | undefined {
  const match = /^shf_v1\.([A-Za-z0-9_-]{22})\.[A-Za-z0-9_-]{43}$/.exec(token);
  return match?.[1] === undefined ? undefined : `crd_${match[1]}`;
}

export function createAccessCredentialService(
  options: CreateAccessCredentialServiceOptions,
): AccessCredentialService {
  const now = options.now ?? (() => new Date());
  return {
    async issueAgent(request) {
      const actorId = opaqueId('act');
      const { credentialId, token } = createToken();
      await options.repository.createActorCredential({
        installationId: request.installationId,
        actorId,
        actorName: request.actorName,
        credentialId,
        digest: digestToken(token),
        grants: request.grants.map((grant) => ({
          installationId: request.installationId,
          actorId,
          ...grant,
        })),
        createdByActorId: request.createdByActorId,
        createdAt: now(),
        ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
      });
      return {
        actorId,
        credentialId,
        token,
        ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
      };
    },
    async rotate(request) {
      const { credentialId, token } = createToken();
      const actor = await options.repository.createRotatedCredential({
        previousCredentialId: request.credentialId,
        credentialId,
        digest: digestToken(token),
        rotatedByActorId: request.rotatedByActorId,
        createdAt: now(),
        ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
      });
      if (actor === undefined) throw new AccessCredentialNotFoundError();
      return {
        actorId: actor.actorId,
        credentialId,
        token,
        ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
      };
    },
    revoke(request) {
      return options.repository.revokeCredential({
        credentialId: request.credentialId,
        revokedByActorId: request.revokedByActorId,
        revokedAt: now(),
      });
    },
    authenticate(token) {
      const credentialId = credentialIdFromToken(token);
      if (credentialId === undefined) return Promise.resolve(undefined);
      return options.repository.authenticateCredential({
        credentialId,
        digest: digestToken(token),
        usedAt: now(),
      });
    },
    authorize(grant) {
      return options.repository.hasGrant(grant);
    },
  };
}
