#!/usr/bin/env node

import pg from 'pg';

const { Client } = pg;

function databaseNameFromUrl(connectionUrl) {
  const databaseName = decodeURIComponent(connectionUrl.pathname.slice(1));
  if (databaseName.length === 0 || databaseName.includes('/') || databaseName.includes('\u0000')) {
    throw new Error('DATABASE_URL must name one database.');
  }
  return databaseName;
}

function isLoopback(connectionUrl) {
  return (
    connectionUrl.hostname === '' ||
    connectionUrl.hostname === 'localhost' ||
    connectionUrl.hostname === '127.0.0.1' ||
    connectionUrl.hostname === '[::1]'
  );
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined) throw new Error('DATABASE_URL is required.');

  const connectionUrl = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(connectionUrl.protocol)) {
    throw new Error('DATABASE_URL must use PostgreSQL.');
  }
  const databaseName = databaseNameFromUrl(connectionUrl);

  if (!isLoopback(connectionUrl)) {
    process.stdout.write(`${JSON.stringify({ status: 'external', database: databaseName })}\n`);
    return;
  }

  const adminUrl = new URL(connectionUrl);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName,
    ]);
    if (existing.rowCount !== 0) {
      process.stdout.write(`${JSON.stringify({ status: 'exists', database: databaseName })}\n`);
      return;
    }

    const identifier = `"${databaseName.replaceAll('"', '""')}"`;
    try {
      await admin.query(`CREATE DATABASE ${identifier}`);
      process.stdout.write(`${JSON.stringify({ status: 'created', database: databaseName })}\n`);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === '42P04') {
        process.stdout.write(`${JSON.stringify({ status: 'exists', database: databaseName })}\n`);
        return;
      }
      throw error;
    }
  } finally {
    await admin.end();
  }
}

main().catch(() => {
  process.stderr.write(
    `${JSON.stringify({ error: 'Development database setup failed. Check DATABASE_URL and PostgreSQL.' })}\n`,
  );
  process.exitCode = 1;
});
