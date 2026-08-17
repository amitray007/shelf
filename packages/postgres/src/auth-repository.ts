import type {
  AccessCredentialRepository,
  AccessCredentialSummary,
  AuthEvent,
  AuthenticateCredentialInput,
  AuthenticatedActor,
  CreateActorCredentialInput,
  CreateHumanActorInput,
  CreateRotatedCredentialInput,
  CredentialGrant,
  HumanActorIdentity,
  RevokeCredentialInput,
  RotatedCredentialActor,
} from '@shelf/auth';
import { sql, type Transaction } from 'kysely';

import type { ShelfPostgresDatabase, ShelfPostgresSchema } from './database.js';

type DatabaseExecutor = ShelfPostgresDatabase | Transaction<ShelfPostgresSchema>;

export interface InstallationCredentialSummary extends AccessCredentialSummary {
  actorName: string;
  grants: Array<{ workspaceId: string; action: CredentialGrant['action'] }>;
}

async function appendEvent(
  database: DatabaseExecutor,
  event: Omit<AuthEvent, 'credentialId'> & { credentialId?: string },
): Promise<void> {
  await database
    .insertInto('shelf_auth_events')
    .values({
      event_type: event.eventType,
      installation_id: event.installationId,
      actor_id: event.actorId,
      credential_id: event.credentialId ?? null,
      performed_by_actor_id: event.performedByActorId,
      occurred_at: event.occurredAt,
    })
    .execute();
}

function credentialSummary(row: {
  credential_id: string;
  actor_id: string;
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
}): AccessCredentialSummary {
  return {
    credentialId: row.credential_id,
    actorId: row.actor_id,
    createdAt: row.created_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    ...(row.last_used_at === null ? {} : { lastUsedAt: row.last_used_at }),
  };
}

export class PostgresAuthRepository implements AccessCredentialRepository {
  readonly #database: ShelfPostgresDatabase;

  constructor(database: ShelfPostgresDatabase) {
    this.#database = database;
  }

  async withOwnerBootstrapLock<T>(installationId: string, operation: () => Promise<T>): Promise<T> {
    return this.#database.connection().execute(async (connection) => {
      await sql`select pg_advisory_lock(hashtextextended(${installationId}, 0))`.execute(
        connection,
      );
      try {
        return await operation();
      } finally {
        await sql`select pg_advisory_unlock(hashtextextended(${installationId}, 0))`.execute(
          connection,
        );
      }
    });
  }

  async createHumanActor(input: CreateHumanActorInput): Promise<void> {
    await this.#database.transaction().execute(async (transaction) => {
      await transaction
        .insertInto('shelf_actors')
        .values({
          actor_id: input.actorId,
          installation_id: input.installationId,
          actor_kind: 'human',
          actor_name: input.actorName,
          auth_user_id: input.authUserId,
          created_by_actor_id: null,
          created_at: input.createdAt,
          disabled_at: null,
        })
        .execute();
      await appendEvent(transaction, {
        eventType: 'human-actor.created',
        installationId: input.installationId,
        actorId: input.actorId,
        performedByActorId: input.actorId,
        occurredAt: input.createdAt,
      });
      if (input.grants !== undefined && input.grants.length > 0) {
        await transaction
          .insertInto('shelf_actor_grants')
          .values(
            input.grants.map((grant) => ({
              installation_id: input.installationId,
              actor_id: input.actorId,
              workspace_id: grant.workspaceId,
              action: grant.action,
              granted_by_actor_id: input.actorId,
              granted_at: input.createdAt,
            })),
          )
          .execute();
      }
    });
  }

  async findHumanActorByAuthUserId(authUserId: string): Promise<HumanActorIdentity | undefined> {
    const actor = await this.#database
      .selectFrom('shelf_actors')
      .select(['installation_id', 'actor_id'])
      .where('auth_user_id', '=', authUserId)
      .where('actor_kind', '=', 'human')
      .where('disabled_at', 'is', null)
      .executeTakeFirst();
    return actor === undefined
      ? undefined
      : { installationId: actor.installation_id, actorId: actor.actor_id };
  }

  async findHumanOwnerByInstallationId(
    installationId: string,
  ): Promise<HumanActorIdentity | undefined> {
    const actor = await this.#database
      .selectFrom('shelf_actors')
      .select(['installation_id', 'actor_id'])
      .where('installation_id', '=', installationId)
      .where('actor_kind', '=', 'human')
      .where('disabled_at', 'is', null)
      .executeTakeFirst();
    return actor === undefined
      ? undefined
      : { installationId: actor.installation_id, actorId: actor.actor_id };
  }

  async createActorCredential(input: CreateActorCredentialInput): Promise<void> {
    await this.#database.transaction().execute(async (transaction) => {
      await transaction
        .insertInto('shelf_actors')
        .values({
          actor_id: input.actorId,
          installation_id: input.installationId,
          actor_kind: 'service',
          actor_name: input.actorName,
          auth_user_id: null,
          created_by_actor_id: input.createdByActorId,
          created_at: input.createdAt,
          disabled_at: null,
        })
        .execute();
      await transaction
        .insertInto('shelf_access_credentials')
        .values({
          credential_id: input.credentialId,
          installation_id: input.installationId,
          actor_id: input.actorId,
          digest: input.digest,
          created_by_actor_id: input.createdByActorId,
          created_at: input.createdAt,
          expires_at: input.expiresAt ?? null,
          revoked_at: null,
          revoked_by_actor_id: null,
          last_used_at: null,
        })
        .execute();
      if (input.grants.length > 0) {
        await transaction
          .insertInto('shelf_actor_grants')
          .values(
            input.grants.map((grant) => ({
              installation_id: grant.installationId,
              actor_id: grant.actorId,
              workspace_id: grant.workspaceId,
              action: grant.action,
              granted_by_actor_id: input.createdByActorId,
              granted_at: input.createdAt,
            })),
          )
          .execute();
      }
      await appendEvent(transaction, {
        eventType: 'access-credential.issued',
        installationId: input.installationId,
        actorId: input.actorId,
        credentialId: input.credentialId,
        performedByActorId: input.createdByActorId,
        occurredAt: input.createdAt,
      });
    });
  }

  async authenticateCredential(
    input: AuthenticateCredentialInput,
  ): Promise<AuthenticatedActor | undefined> {
    const result = await sql<{
      installation_id: string;
      actor_id: string;
      credential_id: string;
    }>`
      update shelf_access_credentials as credential
      set last_used_at = ${input.usedAt}
      from shelf_actors as actor
      where credential.credential_id = ${input.credentialId}
        and credential.digest = ${input.digest}
        and credential.revoked_at is null
        and (credential.expires_at is null or credential.expires_at > ${input.usedAt})
        and actor.actor_id = credential.actor_id
        and actor.installation_id = credential.installation_id
        and actor.disabled_at is null
      returning credential.installation_id, credential.actor_id, credential.credential_id
    `.execute(this.#database);
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      installationId: row.installation_id,
      actorId: row.actor_id,
      credentialId: row.credential_id,
      authenticationMethod: 'access-credential',
    };
  }

  async hasGrant(grant: CredentialGrant): Promise<boolean> {
    const found = await this.#database
      .selectFrom('shelf_actor_grants as actor_grant')
      .innerJoin('shelf_actors as actor', 'actor.actor_id', 'actor_grant.actor_id')
      .select('actor_grant.actor_id')
      .where('actor_grant.installation_id', '=', grant.installationId)
      .where('actor_grant.actor_id', '=', grant.actorId)
      .where('actor_grant.workspace_id', '=', grant.workspaceId)
      .where('actor_grant.action', '=', grant.action)
      .where('actor.disabled_at', 'is', null)
      .executeTakeFirst();
    return found !== undefined;
  }

  async createRotatedCredential(
    input: CreateRotatedCredentialInput,
  ): Promise<RotatedCredentialActor | undefined> {
    return this.#database.transaction().execute(async (transaction) => {
      const previous = await transaction
        .selectFrom('shelf_access_credentials as credential')
        .innerJoin('shelf_actors as actor', 'actor.actor_id', 'credential.actor_id')
        .select(['credential.installation_id', 'credential.actor_id'])
        .where('credential.credential_id', '=', input.previousCredentialId)
        .where('credential.revoked_at', 'is', null)
        .where('actor.disabled_at', 'is', null)
        .forUpdate('credential')
        .executeTakeFirst();
      if (previous === undefined) return undefined;
      await transaction
        .insertInto('shelf_access_credentials')
        .values({
          credential_id: input.credentialId,
          installation_id: previous.installation_id,
          actor_id: previous.actor_id,
          digest: input.digest,
          created_by_actor_id: input.rotatedByActorId,
          created_at: input.createdAt,
          expires_at: input.expiresAt ?? null,
          revoked_at: null,
          revoked_by_actor_id: null,
          last_used_at: null,
        })
        .execute();
      await appendEvent(transaction, {
        eventType: 'access-credential.rotated',
        installationId: previous.installation_id,
        actorId: previous.actor_id,
        credentialId: input.credentialId,
        performedByActorId: input.rotatedByActorId,
        occurredAt: input.createdAt,
      });
      return { installationId: previous.installation_id, actorId: previous.actor_id };
    });
  }

  async revokeCredential(input: RevokeCredentialInput): Promise<boolean> {
    return this.#database.transaction().execute(async (transaction) => {
      const revoked = await transaction
        .updateTable('shelf_access_credentials')
        .set({ revoked_at: input.revokedAt, revoked_by_actor_id: input.revokedByActorId })
        .where('credential_id', '=', input.credentialId)
        .where('revoked_at', 'is', null)
        .returning(['installation_id', 'actor_id'])
        .executeTakeFirst();
      if (revoked === undefined) return false;
      await appendEvent(transaction, {
        eventType: 'access-credential.revoked',
        installationId: revoked.installation_id,
        actorId: revoked.actor_id,
        credentialId: input.credentialId,
        performedByActorId: input.revokedByActorId,
        occurredAt: input.revokedAt,
      });
      return true;
    });
  }

  async listActorCredentials(actorId: string): Promise<AccessCredentialSummary[]> {
    const rows = await this.#database
      .selectFrom('shelf_access_credentials')
      .select([
        'credential_id',
        'actor_id',
        'created_at',
        'expires_at',
        'revoked_at',
        'last_used_at',
      ])
      .where('actor_id', '=', actorId)
      .orderBy('created_at')
      .orderBy('credential_id')
      .execute();
    return rows.map(credentialSummary);
  }

  async listInstallationCredentials(
    installationId: string,
  ): Promise<InstallationCredentialSummary[]> {
    const [rows, grants] = await Promise.all([
      this.#database
        .selectFrom('shelf_access_credentials as credential')
        .innerJoin('shelf_actors as actor', 'actor.actor_id', 'credential.actor_id')
        .select([
          'credential.credential_id',
          'credential.actor_id',
          'actor.actor_name',
          'credential.created_at',
          'credential.expires_at',
          'credential.revoked_at',
          'credential.last_used_at',
        ])
        .where('credential.installation_id', '=', installationId)
        .orderBy('credential.created_at')
        .orderBy('credential.credential_id')
        .execute(),
      this.#database
        .selectFrom('shelf_actor_grants')
        .select(['actor_id', 'workspace_id', 'action'])
        .where('installation_id', '=', installationId)
        .orderBy('workspace_id')
        .orderBy('action')
        .execute(),
    ]);
    const grantsByActor = new Map<
      string,
      Array<{ workspaceId: string; action: CredentialGrant['action'] }>
    >();
    for (const grant of grants) {
      const actorGrants = grantsByActor.get(grant.actor_id) ?? [];
      actorGrants.push({ workspaceId: grant.workspace_id, action: grant.action });
      grantsByActor.set(grant.actor_id, actorGrants);
    }
    return rows.map((row) => ({
      ...credentialSummary(row),
      actorName: row.actor_name,
      grants: [...(grantsByActor.get(row.actor_id) ?? [])],
    }));
  }

  async findInstallationCredential(
    installationId: string,
    credentialId: string,
  ): Promise<InstallationCredentialSummary | undefined> {
    const row = await this.#database
      .selectFrom('shelf_access_credentials as credential')
      .innerJoin('shelf_actors as actor', 'actor.actor_id', 'credential.actor_id')
      .select([
        'credential.credential_id',
        'credential.actor_id',
        'actor.actor_name',
        'credential.created_at',
        'credential.expires_at',
        'credential.revoked_at',
        'credential.last_used_at',
      ])
      .where('credential.installation_id', '=', installationId)
      .where('credential.credential_id', '=', credentialId)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    const grants = await this.#database
      .selectFrom('shelf_actor_grants')
      .select(['workspace_id', 'action'])
      .where('installation_id', '=', installationId)
      .where('actor_id', '=', row.actor_id)
      .orderBy('workspace_id')
      .orderBy('action')
      .execute();
    return {
      ...credentialSummary(row),
      actorName: row.actor_name,
      grants: grants.map((grant) => ({ workspaceId: grant.workspace_id, action: grant.action })),
    };
  }

  async listAuthEvents(installationId: string): Promise<AuthEvent[]> {
    const rows = await this.#database
      .selectFrom('shelf_auth_events')
      .select([
        'event_type',
        'installation_id',
        'actor_id',
        'credential_id',
        'performed_by_actor_id',
        'occurred_at',
      ])
      .where('installation_id', '=', installationId)
      .orderBy('event_sequence')
      .execute();
    return rows.map((row) => ({
      eventType: row.event_type,
      installationId: row.installation_id,
      actorId: row.actor_id,
      ...(row.credential_id === null ? {} : { credentialId: row.credential_id }),
      performedByActorId: row.performed_by_actor_id,
      occurredAt: row.occurred_at,
    }));
  }
}
