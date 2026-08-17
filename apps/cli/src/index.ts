#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { CLI_EXIT_CODES } from '@shelf/contracts';
import { Command, CommanderError } from 'commander';
import {
  type ArtifactHistoryCommandOptions,
  executeArtifactHistory,
  executeListArtifacts,
  executeRenameArtifact,
  executeRestoreArtifact,
  executeShowArtifact,
  type ListArtifactsCommandOptions,
  type RenameArtifactCommandOptions,
  type RestoreArtifactCommandOptions,
  type ShowArtifactCommandOptions,
} from './commands/artifacts.js';
import {
  executeFolderTree,
  executePublishFolder,
  type FolderTreeCommandOptions,
  type PublishFolderCommandOptions,
} from './commands/folders.js';
import { executePublish, type PublishCommandOptions } from './commands/publish.js';
import {
  executePublishWorkflow,
  type PublishWorkflowOptions,
} from './commands/publish-workflow.js';
import {
  type CompareRevisionsCommandOptions,
  executeCompareRevisions,
} from './commands/revisions.js';
import {
  type CreateShareCommandOptions,
  executeCreateShare,
  executeListShares,
  executeRevokeShare,
  type ListSharesCommandOptions,
  type RevokeShareCommandOptions,
} from './commands/shares.js';
import {
  CliFailure,
  CliPartialFailure,
  failure,
  jsonLine,
  redactEnvelope,
  redactValue,
  usageFailure,
} from './output.js';
import {
  executeListProfiles,
  executeRemoveProfile,
  executeSetProfile,
  executeShowProfile,
  type SetProfileOptions,
} from './profiles.js';
import type { CliRuntime } from './runtime.js';

export type { CliRuntime } from './runtime.js';

type PublishCliOptions = Partial<PublishCommandOptions> & Omit<PublishWorkflowOptions, 'path'>;

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export async function runCli(
  argv: readonly string[],
  runtime: CliRuntime = {
    env: process.env,
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
  },
): Promise<number> {
  const program = new Command()
    .name('shelf')
    .showHelpAfterError(false)
    .showSuggestionAfterError(false)
    .exitOverride()
    .configureOutput({ writeOut() {}, writeErr() {} })
    .allowExcessArguments(false);

  let result: unknown;
  let finalizeResult: (() => Promise<void>) | undefined;

  program
    .command('publish')
    .description('Publish one immutable file or folder revision')
    .argument('[path]')
    .option('--profile <name>', 'use one configured profile')
    .option('--url <url>')
    .option('--workspace <workspace>')
    .option('--file <path>')
    .option('--idempotency-key <key>')
    .option('--artifact <artifact-id>', 'publish another revision to this artifact')
    .option('--metadata <key=value>', 'publisher metadata; repeatable', collect, [])
    .option('--share', 'create one unlisted latest share after publishing')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (path: string | undefined, options: PublishCliOptions) => {
      if (path !== undefined) {
        if (
          options.file !== undefined ||
          options.url !== undefined ||
          options.workspace !== undefined ||
          options.allowInsecureLoopback !== undefined
        ) {
          throw usageFailure('Profile-backed publishing cannot mix legacy context flags.');
        }
        const execution = await executePublishWorkflow({ ...options, path }, runtime);
        result = execution.output;
        finalizeResult = execution.finalize;
        return;
      }
      if (
        options.url === undefined ||
        options.workspace === undefined ||
        options.file === undefined ||
        options.idempotencyKey === undefined
      ) {
        throw usageFailure('A publish path or complete legacy publish context is required.');
      }
      if (options.profile !== undefined || options.share) {
        throw usageFailure('Legacy publishing cannot mix profile or share options.');
      }
      result = await executePublish(
        options as PublishCommandOptions,
        runtime.env,
        runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
      );
    });

  const folders = program.command('folders').description('Publish and inspect folder snapshots');
  folders
    .command('publish')
    .description('Publish one complete immutable folder snapshot')
    .requiredOption('--url <url>')
    .requiredOption('--workspace <workspace>')
    .requiredOption('--directory <path>')
    .requiredOption('--idempotency-key <key>')
    .option('--artifact <artifact-id>', 'publish another snapshot to this folder artifact')
    .option('--metadata <key=value>', 'publisher metadata; repeatable', collect, [])
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (options: PublishFolderCommandOptions) => {
      result = await executePublishFolder(options, runtime);
    });
  folders
    .command('tree')
    .description('Read one immutable folder revision tree')
    .requiredOption('--url <url>')
    .requiredOption('--revision <revision-id>')
    .option('--limit <count>')
    .option('--cursor <cursor>')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (options: FolderTreeCommandOptions) => {
      result = await executeFolderTree(options, runtime);
    });

  const revisions = program.command('revisions').description('Inspect immutable revisions');
  revisions
    .command('compare')
    .description('Compare two revisions of one artifact')
    .requiredOption('--url <url>')
    .requiredOption('--base <revision-id>')
    .requiredOption('--target <revision-id>')
    .option('--limit <count>')
    .option('--cursor <cursor>')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (options: CompareRevisionsCommandOptions) => {
      result = await executeCompareRevisions(options, runtime);
    });

  const artifacts = program.command('artifacts').description('Inspect versioned artifacts');
  artifacts
    .command('list')
    .requiredOption('--url <url>')
    .requiredOption('--workspace <workspace>')
    .option('--limit <count>')
    .option('--cursor <cursor>')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (options: ListArtifactsCommandOptions) => {
      result = await executeListArtifacts(options, runtime);
    });
  artifacts
    .command('show')
    .requiredOption('--url <url>')
    .requiredOption('--artifact <artifact-id>')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (options: ShowArtifactCommandOptions) => {
      result = await executeShowArtifact(options, runtime);
    });
  artifacts
    .command('history')
    .requiredOption('--url <url>')
    .requiredOption('--artifact <artifact-id>')
    .option('--limit <count>')
    .option('--cursor <cursor>')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (options: ArtifactHistoryCommandOptions) => {
      result = await executeArtifactHistory(options, runtime);
    });
  artifacts
    .command('rename')
    .requiredOption('--url <url>')
    .requiredOption('--artifact <artifact-id>')
    .requiredOption('--name <name>')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (options: RenameArtifactCommandOptions) => {
      result = await executeRenameArtifact(options, runtime);
    });
  artifacts
    .command('restore')
    .requiredOption('--url <url>')
    .requiredOption('--workspace <workspace>')
    .requiredOption('--artifact <artifact-id>')
    .requiredOption('--revision <revision-id>')
    .requiredOption('--idempotency-key <key>')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (options: RestoreArtifactCommandOptions) => {
      result = await executeRestoreArtifact(options, runtime);
    });

  const shares = program.command('shares').description('Create and manage share links');
  shares
    .command('create')
    .requiredOption('--url <url>')
    .requiredOption('--workspace <workspace>')
    .requiredOption('--artifact <artifact-id>')
    .requiredOption('--idempotency-key <key>')
    .option('--revision <revision-id>', 'pin the share to one immutable revision')
    .option('--expires-at <instant>', 'expire the share at an ISO instant')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (options: CreateShareCommandOptions) => {
      result = await executeCreateShare(options, runtime);
    });
  shares
    .command('list')
    .requiredOption('--url <url>')
    .requiredOption('--workspace <workspace>')
    .option('--limit <count>')
    .option('--cursor <cursor>')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (options: ListSharesCommandOptions) => {
      result = await executeListShares(options, runtime);
    });
  shares
    .command('revoke')
    .requiredOption('--url <url>')
    .requiredOption('--workspace <workspace>')
    .requiredOption('--share <share-id>')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (options: RevokeShareCommandOptions) => {
      result = await executeRevokeShare(options, runtime);
    });

  const profiles = program.command('profiles').description('Configure isolated CLI contexts');
  profiles
    .command('set')
    .argument('<name>')
    .requiredOption('--url <url>')
    .requiredOption('--workspace <workspace>')
    .option('--credential-env <variable>')
    .option('--store-token-from-env <variable>')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (name: string, options: Omit<SetProfileOptions, 'name'>) => {
      result = await executeSetProfile({ name, ...options }, runtime);
    });
  profiles.command('list').action(async () => {
    result = await executeListProfiles(runtime.env);
  });
  profiles
    .command('show')
    .argument('<name>')
    .action(async (name: string) => {
      result = await executeShowProfile(name, runtime.env);
    });
  profiles
    .command('remove')
    .argument('<name>')
    .option('--yes', 'confirm removal without prompting')
    .action(async (name: string, options: { yes?: boolean }) => {
      result = await executeRemoveProfile(name, options.yes, runtime);
    });

  try {
    await program.parseAsync([...argv]);
    if (result === undefined) throw usageFailure('A command is required.');
    await finalizeResult?.();
    runtime.stdout(jsonLine(result));
    return CLI_EXIT_CODES.success;
  } catch (error) {
    if (error instanceof CliPartialFailure) {
      runtime.stderr(
        jsonLine(redactValue(error.payload, [...error.secrets, runtime.env.SHELF_TOKEN])),
      );
      return error.exitCode;
    }
    const token = runtime.env.SHELF_TOKEN;
    const cliFailure =
      error instanceof CliFailure
        ? error
        : error instanceof CommanderError
          ? usageFailure(error.message)
          : failure('INTERNAL_ERROR', 'An unexpected CLI error occurred.');
    runtime.stderr(jsonLine(redactEnvelope(cliFailure.envelope, token)));
    return cliFailure.exitCode;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv);
}
