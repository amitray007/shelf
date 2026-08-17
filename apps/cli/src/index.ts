#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { CLI_EXIT_CODES } from '@shelf/contracts';
import { Command, CommanderError } from 'commander';
import { executePublish, type PublishCommandOptions } from './commands/publish.js';
import { CliFailure, failure, jsonLine, redactEnvelope, usageFailure } from './output.js';

export interface CliRuntime {
  env: Readonly<Record<string, string | undefined>>;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  fetch?: typeof globalThis.fetch;
}

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

  program
    .command('publish')
    .description('Publish one immutable file revision')
    .requiredOption('--url <url>')
    .requiredOption('--workspace <workspace>')
    .requiredOption('--file <path>')
    .requiredOption('--idempotency-key <key>')
    .option('--metadata <key=value>', 'publisher metadata; repeatable', collect, [])
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (options: PublishCommandOptions) => {
      result = await executePublish(
        options,
        runtime.env,
        runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
      );
    });

  try {
    await program.parseAsync([...argv]);
    if (result === undefined) throw usageFailure('A command is required.');
    runtime.stdout(jsonLine(result));
    return CLI_EXIT_CODES.success;
  } catch (error) {
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
