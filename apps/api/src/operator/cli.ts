#!/usr/bin/env node

import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { type CredentialAction, createAccessCredentialService, createHumanAuth } from '@shelf/auth';
import { PUBLISH_OPERATION, READ_REVISION_OPERATION } from '@shelf/contracts';
import { createReconciliationService } from '@shelf/core';
import { createPostgresDatabase, migratePostgresToLatest } from '@shelf/postgres';
import { Command } from 'commander';

import { installationIdFromEnvironment, requiredEnvironmentValue } from '../environment.js';
import { createShelfPersistence } from '../persistence.js';
import { shelfPersistenceConfigFromEnv } from '../persistence-env.js';
import { loadShelfServerConfig, type ShelfServerEnvironment } from '../server-config.js';
import { createLocalBackup, restoreLocalBackup, runBackupCommand } from './backup.js';
import { createOperatorService, type OperatorGrant } from './service.js';

export interface ShelfAdminRuntime {
  env: ShelfServerEnvironment;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  readStdin: (maxBytes: number) => Promise<string>;
}

const MAX_PASSWORD_BYTES = 4096;
const DEFAULT_RECONCILIATION_MINIMUM_AGE_SECONDS = 86_400;
const CREDENTIAL_ACTIONS = [PUBLISH_OPERATION, READ_REVISION_OPERATION] as const;

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function minimumAgeSeconds(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 60) {
    throw new Error('The reconciliation minimum age must be an integer of at least 60 seconds.');
  }
  return parsed;
}

function grants(values: string[]): OperatorGrant[] {
  const parsed = values.map((value) => {
    const separator = value.lastIndexOf(':');
    const workspaceId = value.slice(0, separator);
    const action = value.slice(separator + 1);
    if (workspaceId.length === 0 || !isCredentialAction(action)) {
      throw new Error('Each grant must be workspace:file.publish or workspace:revision.read.');
    }
    return { workspaceId, action };
  });
  if (parsed.length === 0) throw new Error('At least one --grant is required.');
  const unique = new Set(parsed.map((grant) => `${grant.workspaceId}\u0000${grant.action}`));
  if (unique.size !== parsed.length) throw new Error('Duplicate grants are not allowed.');
  return parsed;
}

async function readPassword(path: string, runtime: ShelfAdminRuntime): Promise<string> {
  const password = (
    path === '-' ? await runtime.readStdin(MAX_PASSWORD_BYTES) : await readBoundedFile(path)
  ).replace(/\r?\n$/u, '');
  if (password.length === 0 || password.includes('\u0000'))
    throw new Error('Password input is invalid.');
  return password;
}

function isCredentialAction(value: string): value is CredentialAction {
  return CREDENTIAL_ACTIONS.some((action) => action === value);
}

async function readBoundedFile(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(MAX_PASSWORD_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    if (bytesRead > MAX_PASSWORD_BYTES) throw new Error('Password input is too large.');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export async function runShelfAdmin(
  argv: readonly string[],
  runtime: ShelfAdminRuntime = {
    env: process.env,
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
    async readStdin(maxBytes) {
      const chunks: string[] = [];
      let bytes = 0;
      process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) throw new Error('Password input is too large.');
        chunks.push(chunk);
      }
      return chunks.join('');
    },
  },
): Promise<number> {
  const program = new Command()
    .name('shelf-admin')
    .exitOverride()
    .showHelpAfterError(false)
    .showSuggestionAfterError(false)
    .allowExcessArguments(false)
    .configureOutput({ writeOut() {}, writeErr() {} });
  let result: unknown;

  program.command('migrate').action(async () => {
    const database = createPostgresDatabase({
      connectionString: requiredEnvironmentValue(runtime.env, 'DATABASE_URL'),
    });
    try {
      await migratePostgresToLatest(database);
      result = { status: 'migrated' };
    } finally {
      await database.destroy();
    }
  });

  const owner = program.command('owner');
  owner
    .command('bootstrap')
    .requiredOption('--email <email>')
    .requiredOption('--name <name>')
    .requiredOption('--password-file <path>')
    .requiredOption('--grant <workspace:action>', 'repeatable explicit grant', collect, [])
    .action(
      async (options: { email: string; name: string; passwordFile: string; grant: string[] }) => {
        const config = await loadShelfServerConfig(runtime.env);
        const persistence = createShelfPersistence(config.persistence);
        const humanAuth = createHumanAuth({
          connectionString: config.persistence.postgres.connectionString,
          baseUrl: config.auth.baseUrl,
          secret: config.auth.secret,
        });
        try {
          await persistence.ready();
          const service = createOperatorService({
            installationId: config.installationId,
            repository: persistence.authRepository,
            credentials: createAccessCredentialService({ repository: persistence.authRepository }),
          });
          const bootstrapped = await service.bootstrap({
            humanAuth,
            actorName: options.name,
            email: options.email,
            name: options.name,
            password: await readPassword(options.passwordFile, runtime),
            grants: grants(options.grant),
          });
          result = {
            installationId: bootstrapped.installationId,
            actorId: bootstrapped.actorId,
            email: bootstrapped.email,
            name: bootstrapped.name,
          };
        } finally {
          await humanAuth.close().catch(() => undefined);
          await persistence.close();
        }
      },
    );
  owner
    .command('reset')
    .requiredOption('--email <email>')
    .requiredOption('--name <name>')
    .requiredOption('--password-file <path>')
    .action(async (options: { email: string; name: string; passwordFile: string }) => {
      const password = await readPassword(options.passwordFile, runtime);
      result = await withOperator(runtime.env, (service) =>
        service.reset({
          email: options.email,
          name: options.name,
          password,
        }),
      );
    });
  owner
    .command('grant')
    .requiredOption('--workspace <workspace-id>')
    .requiredOption('--action <action>', 'repeatable workspace action', collect, [])
    .action(async (options: { workspace: string; action: string[] }) => {
      const parsed = grants(options.action.map((action) => `${options.workspace}:${action}`));
      result = {
        grants: await Promise.all(
          parsed.map((grant) => withOperator(runtime.env, (service) => service.grantOwner(grant))),
        ),
      };
    });

  const workspace = program.command('workspace');
  workspace
    .command('create')
    .requiredOption('--id <workspace-id>')
    .action(async (options: { id: string }) => {
      result = await withOperator(runtime.env, (service) => service.createWorkspace(options.id));
    });

  const credential = program.command('credential');
  credential
    .command('issue')
    .requiredOption('--name <name>')
    .requiredOption('--grant <workspace:action>', 'repeatable explicit grant', collect, [])
    .action(async (options: { name: string; grant: string[] }) => {
      result = await withOperator(runtime.env, (service) =>
        service.issue({ actorName: options.name, grants: grants(options.grant) }),
      );
    });
  credential.command('list').action(async () => {
    result = { credentials: await withOperator(runtime.env, (service) => service.list()) };
  });
  credential
    .command('rotate')
    .requiredOption('--credential-id <id>')
    .action(async (options: { credentialId: string }) => {
      result = await withOperator(runtime.env, (service) => service.rotate(options.credentialId));
    });
  credential
    .command('revoke')
    .requiredOption('--credential-id <id>')
    .action(async (options: { credentialId: string }) => {
      result = await withOperator(runtime.env, (service) => service.revoke(options.credentialId));
    });

  const backup = program.command('backup');
  backup
    .command('create')
    .requiredOption('--output <directory>')
    .requiredOption('--confirm-offline <installation-id>')
    .action(async (options: { output: string; confirmOffline: string }) => {
      if (options.confirmOffline !== installationIdFromEnvironment(runtime.env)) {
        throw new Error('The offline confirmation does not match this installation.');
      }
      const persistence = createShelfPersistence(shelfPersistenceConfigFromEnv(runtime.env));
      try {
        await persistence.assertMetadataCurrent();
        result = await createLocalBackup({
          environment: runtime.env,
          outputDirectory: options.output,
          offlineConfirmation: options.confirmOffline,
          installations: persistence.installationInventory,
          references: persistence.referencedContentInventory,
          content: persistence.contentReader,
          inventory: persistence.contentInventory,
          runCommand: runBackupCommand,
        });
      } finally {
        await persistence.close();
      }
    });
  backup
    .command('restore')
    .requiredOption('--from <directory>')
    .requiredOption('--confirm-offline <installation-id>')
    .action(async (options: { from: string; confirmOffline: string }) => {
      if (options.confirmOffline !== installationIdFromEnvironment(runtime.env)) {
        throw new Error('The offline confirmation does not match this installation.');
      }
      const persistence = createShelfPersistence(shelfPersistenceConfigFromEnv(runtime.env));
      try {
        result = await restoreLocalBackup({
          environment: runtime.env,
          inputDirectory: options.from,
          offlineConfirmation: options.confirmOffline,
          installations: persistence.installationInventory,
          references: persistence.referencedContentInventory,
          content: persistence.contentReader,
          inventory: persistence.contentInventory,
          assertMetadataCurrent: () => persistence.assertMetadataCurrent(),
          runCommand: runBackupCommand,
        });
      } finally {
        await persistence.close();
      }
    });

  const reconciliation = program.command('reconcile');
  reconciliation
    .command('scan')
    .option(
      '--minimum-age-seconds <seconds>',
      'minimum object age before reporting a cleanup candidate',
      String(DEFAULT_RECONCILIATION_MINIMUM_AGE_SECONDS),
    )
    .action(async (options: { minimumAgeSeconds: string }) => {
      const persistence = createShelfPersistence(shelfPersistenceConfigFromEnv(runtime.env));
      try {
        await persistence.assertMetadataCurrent();
        result = await createReconciliationService({
          references: persistence.referencedContentInventory,
          content: persistence.contentInventory,
        })({
          installationId: installationIdFromEnvironment(runtime.env),
          minimumAgeSeconds: minimumAgeSeconds(options.minimumAgeSeconds),
        });
      } finally {
        await persistence.close();
      }
    });

  try {
    await program.parseAsync([...argv]);
    if (result === undefined) throw new Error('A command is required.');
    runtime.stdout(`${JSON.stringify(result)}\n`);
    return 0;
  } catch {
    runtime.stderr(
      `${JSON.stringify({ error: { code: 'ADMIN_FAILED', message: 'Shelf administration failed.' } })}\n`,
    );
    return 1;
  }
}

async function withOperator<T>(
  environment: ShelfServerEnvironment,
  operation: (service: ReturnType<typeof createOperatorService>) => Promise<T>,
): Promise<T> {
  const persistence = createShelfPersistence(shelfPersistenceConfigFromEnv(environment));
  try {
    await persistence.ready();
    return await operation(
      createOperatorService({
        installationId: installationIdFromEnvironment(environment),
        repository: persistence.authRepository,
        credentials: createAccessCredentialService({ repository: persistence.authRepository }),
      }),
    );
  } finally {
    await persistence.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runShelfAdmin(process.argv);
}
