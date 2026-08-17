import type { ReferencedContent, ReferencedContentInventory } from '@shelf/core';
import { sql } from 'kysely';

import type { ShelfPostgresDatabase } from './database.js';

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Stored ${label} is invalid.`);
  }
  return parsed;
}

export class PostgresReferencedContentInventory implements ReferencedContentInventory {
  readonly #database: ShelfPostgresDatabase;

  constructor(database: ShelfPostgresDatabase) {
    this.#database = database;
  }

  async listReferencedContent(installationId: string): Promise<ReferencedContent[]> {
    const rows = await this.#database
      .selectFrom('shelf_revisions')
      .select(['content_id', 'content_hash', 'byte_count'])
      .select(sql<string>`count(*)`.as('revision_count'))
      .where('installation_id', '=', installationId)
      .groupBy(['content_id', 'content_hash', 'byte_count'])
      .orderBy('content_id')
      .execute();

    const inventory = new Map<string, ReferencedContent>();
    for (const row of rows) {
      const current = {
        contentId: row.content_id,
        contentHash: row.content_hash,
        byteCount: positiveInteger(row.byte_count, 'content byte count'),
        revisionCount: positiveInteger(row.revision_count, 'revision count'),
      };
      const existing = inventory.get(current.contentId);
      if (
        existing !== undefined &&
        (existing.contentHash !== current.contentHash || existing.byteCount !== current.byteCount)
      ) {
        throw new Error('Stored content identity has conflicting descriptors.');
      }
      if (existing === undefined) {
        inventory.set(current.contentId, current);
      } else {
        existing.revisionCount += current.revisionCount;
      }
    }
    return [...inventory.values()];
  }
}
