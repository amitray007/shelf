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

function nonNegativeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
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
    const result = await sql<{
      content_id: string;
      content_hash: string;
      byte_count: string;
      revision_count: string;
    }>`
      select content_id, content_hash, byte_count, count(*) as revision_count
      from (
        select content_id, content_hash, byte_count
        from shelf_revisions
        where installation_id = ${installationId}
        union all
        select content_id, content_hash, byte_count
        from shelf_revision_entries
        where installation_id = ${installationId} and kind = 'file'
      ) referenced_objects
      group by content_id, content_hash, byte_count
      order by content_id
    `.execute(this.#database);

    const inventory = new Map<string, ReferencedContent>();
    for (const row of result.rows) {
      const current = {
        contentId: row.content_id,
        contentHash: row.content_hash,
        byteCount: nonNegativeInteger(row.byte_count, 'content byte count'),
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
