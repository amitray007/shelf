import { type Kysely, sql } from 'kysely';
import type { Migration } from 'kysely/migration';

export const humanAuthMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`create schema auth`.execute(database);

    await sql`
      create table auth."user" (
        "id" text primary key,
        "name" text not null,
        "email" text not null unique,
        "emailVerified" boolean not null,
        "image" text,
        "createdAt" timestamptz not null default current_timestamp,
        "updatedAt" timestamptz not null default current_timestamp
      )
    `.execute(database);

    await sql`
      create table auth."session" (
        "id" text primary key,
        "expiresAt" timestamptz not null,
        "token" text not null unique,
        "createdAt" timestamptz not null default current_timestamp,
        "updatedAt" timestamptz not null,
        "ipAddress" text,
        "userAgent" text,
        "userId" text not null references auth."user" ("id") on delete cascade
      )
    `.execute(database);

    await sql`
      create table auth."account" (
        "id" text primary key,
        "accountId" text not null,
        "providerId" text not null,
        "userId" text not null references auth."user" ("id") on delete cascade,
        "accessToken" text,
        "refreshToken" text,
        "idToken" text,
        "accessTokenExpiresAt" timestamptz,
        "refreshTokenExpiresAt" timestamptz,
        "scope" text,
        "password" text,
        "createdAt" timestamptz not null default current_timestamp,
        "updatedAt" timestamptz not null
      )
    `.execute(database);

    await sql`
      create table auth."verification" (
        "id" text primary key,
        "identifier" text not null,
        "value" text not null,
        "expiresAt" timestamptz not null,
        "createdAt" timestamptz not null default current_timestamp,
        "updatedAt" timestamptz not null default current_timestamp
      )
    `.execute(database);

    await sql`create index "session_userId_idx" on auth."session" ("userId")`.execute(database);
    await sql`create index "account_userId_idx" on auth."account" ("userId")`.execute(database);
    await sql`create index "verification_identifier_idx" on auth."verification" ("identifier")`.execute(
      database,
    );
  },

  async down(database: Kysely<unknown>): Promise<void> {
    await sql`drop schema auth cascade`.execute(database);
  },
};
