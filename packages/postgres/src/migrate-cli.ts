#!/usr/bin/env node

import { createPostgresDatabase } from './database.js';
import { migratePostgresToLatest } from './migrations.js';

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString.length === 0) {
  process.stderr.write(`${JSON.stringify({ error: 'DATABASE_URL is required.' })}\n`);
  process.exitCode = 2;
} else {
  const database = createPostgresDatabase({ connectionString });
  try {
    const migrations = await migratePostgresToLatest(database);
    process.stdout.write(`${JSON.stringify({ status: 'ok', migrations })}\n`);
  } catch {
    process.stderr.write(`${JSON.stringify({ error: 'PostgreSQL migration failed.' })}\n`);
    process.exitCode = 1;
  } finally {
    await database.destroy();
  }
}
