import { CLI_EXIT_CODES, ERROR_CODES } from '@shelf/contracts';
import { describe, expect, it } from 'vitest';

import { runCli } from '../src/index.js';
import type { SchemaCommand, SchemaCommandDocument, SchemaDocument } from '../src/schema.js';

function capture() {
  let value = '';
  return { write: (chunk: string) => (value += chunk), value: () => value };
}

async function run(...args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await runCli(['node', 'shelf', ...args], {
    env: {},
    stdout: stdout.write,
    stderr: stderr.write,
  });
  return { exitCode, stdout: stdout.value(), stderr: stderr.value() };
}

async function runSchema() {
  return run('schema');
}

async function schemaDocument(): Promise<SchemaDocument> {
  const result = await runSchema();
  expect(result.stderr).toBe('');
  expect(result.exitCode).toBe(CLI_EXIT_CODES.success);
  return JSON.parse(result.stdout) as SchemaDocument;
}

/** Run a successful single-command query and return the described command. */
async function commandDocument(...args: string[]): Promise<SchemaCommand> {
  const result = await run(...args);
  expect(result.stderr).toBe('');
  expect(result.exitCode).toBe(CLI_EXIT_CODES.success);
  const document = JSON.parse(result.stdout) as SchemaCommandDocument;
  expect(document.apiVersion).toBe('v1');
  expect(Object.keys(document)[0]).toBe('apiVersion');
  expect(document.kind).toBe('Command');
  return document.command;
}

function commandPaths(document: SchemaDocument): string[] {
  return document.commands.map((command) => command.path);
}

function commandAt(document: SchemaDocument, path: string) {
  const command = document.commands.find((entry) => entry.path === path);
  expect(command, `expected command "${path}" in the schema`).toBeDefined();
  if (command === undefined) throw new Error(`missing command ${path}`);
  return command;
}

function optionAt(command: SchemaCommand, flag: string) {
  const option = command.options?.find((entry) => entry.flags.split(/[\s,|]/u).includes(flag));
  expect(option, `expected option "${flag}" on "${command.path}"`).toBeDefined();
  if (option === undefined) throw new Error(`missing option ${flag}`);
  return option;
}

describe('shelf schema', () => {
  it('writes one machine-readable JSON document to stdout', async () => {
    const result = await runSchema();

    expect(result.exitCode).toBe(CLI_EXIT_CODES.success);
    expect(result.stderr).toBe('');
    expect(result.stdout.endsWith('\n')).toBe(true);
    expect(result.stdout.trimEnd().includes('\n')).toBe(false);

    const document = JSON.parse(result.stdout) as SchemaDocument;
    expect(document.apiVersion).toBe('v1');
    expect(Object.keys(document)[0]).toBe('apiVersion');
  });

  it('describes the program itself', async () => {
    const document = await schemaDocument();

    expect(document.program.name).toBe('shelf');
    expect(document.program.version).toBe('0.0.0-dev');
    expect(document.program.description).toBe(
      'Publish, version, inspect, and share Shelf artifacts',
    );
  });

  it('enumerates the full command tree by path', async () => {
    const document = await schemaDocument();
    const paths = commandPaths(document);

    for (const path of [
      'publish',
      'artifacts',
      'artifacts list',
      'artifacts show',
      'artifacts resolve',
      'artifacts history',
      'artifacts delete',
      'artifacts recover',
      'artifacts retention set',
      'trash list',
      'trash show',
      'trash recover',
      'shares create',
      'shares list',
      'shares revoke',
      'shares defaults',
      'comments list',
      'comments create',
      'comments reply',
      'comments edit',
      'comments delete',
      'comments summaries',
      'folders publish',
      'folders tree',
      'folders download',
      'revisions compare',
      'revisions download',
      'profiles set',
      'profiles list',
      'profiles show',
      'profiles remove',
      'schema',
    ]) {
      expect(paths, `expected "${path}" in the command schema`).toContain(path);
    }

    expect(new Set(paths).size).toBe(paths.length);
    expect(commandAt(document, 'artifacts').subcommands).toContain('artifacts list');
  });

  it('marks required options as required and omits the key on optional ones', async () => {
    const document = await schemaDocument();
    const create = commandAt(document, 'shares create');

    const artifact = optionAt(create, '--artifact');
    expect(artifact.required).toBe(true);
    expect(artifact.flags).toBe('--artifact <artifact-id>');

    expect(optionAt(create, '--idempotency-key').required).toBe(true);

    // Optional options carry no `required` key at all rather than `false`.
    const profile = optionAt(create, '--profile');
    expect(profile.required).toBeUndefined();
    expect('required' in profile).toBe(false);
    expect(profile.flags).toBe('--profile <name>');

    const loopback = optionAt(create, '--allow-insecure-loopback');
    expect('required' in loopback).toBe(false);
    // A boolean flag carries no value placeholder in its canonical form.
    expect(loopback.flags).toBe('--allow-insecure-loopback');

    const list = commandAt(document, 'artifacts list');
    expect((list.options ?? []).every((option) => option.required === undefined)).toBe(true);
    expect((list.options ?? []).map((option) => option.flags)).toContain('--search <text>');
  });

  it('reports repeatable options and their defaults', async () => {
    const document = await schemaDocument();

    const metadata = optionAt(commandAt(document, 'publish'), '--metadata');
    expect(metadata.repeatable).toBe(true);
    expect(metadata.default).toEqual([]);
    expect(metadata.description).toContain('repeatable');

    const summaries = optionAt(commandAt(document, 'comments summaries'), '--artifact');
    expect(summaries.repeatable).toBe(true);
    expect(summaries.required).toBe(true);

    // A non-repeatable option omits the key rather than emitting false.
    const share = optionAt(commandAt(document, 'shares revoke'), '--share');
    expect(share.repeatable).toBeUndefined();
    expect('repeatable' in share).toBe(false);
  });

  it('preserves enum choices inside the canonical flag string', async () => {
    const document = await schemaDocument();

    expect(optionAt(commandAt(document, 'shares create'), '--access').flags).toBe(
      '--access <protected|public>',
    );
    expect(optionAt(commandAt(document, 'shares create'), '--comments').flags).toBe(
      '--comments <off|private|shared>',
    );
    expect(optionAt(commandAt(document, 'artifacts list'), '--sort').flags).toBe(
      '--sort <created|updated>',
    );
    expect(optionAt(commandAt(document, 'shares comments'), '--comments').required).toBe(true);
  });

  it('never emits a false or null field anywhere in the document', async () => {
    const result = await runSchema();
    const document = JSON.parse(result.stdout) as SchemaDocument;

    const offenders: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        for (const [index, item] of value.entries()) walk(item, `${path}[${index}]`);
        return;
      }
      if (typeof value !== 'object' || value === null) return;
      for (const [key, item] of Object.entries(value)) {
        if (item === false) offenders.push(`${path}.${key}=false`);
        walk(item, `${path}.${key}`);
      }
    };
    for (const command of document.commands) walk(command, command.path);

    expect(offenders).toEqual([]);
  });

  it('describes positional arguments and marks only the required ones', async () => {
    const document = await schemaDocument();

    // An optional positional omits `required` instead of emitting false.
    const publish = commandAt(document, 'publish');
    expect(publish.arguments).toHaveLength(1);
    expect(publish.arguments?.[0]?.name).toBe('path');
    expect(publish.arguments?.[0]?.required).toBeUndefined();

    const profilesSet = commandAt(document, 'profiles set');
    expect(profilesSet.arguments?.[0]?.name).toBe('name');
    expect(profilesSet.arguments?.[0]?.required).toBe(true);

    // A command with no positionals omits the key entirely.
    expect(commandAt(document, 'artifacts list').arguments).toBeUndefined();
  });

  it('includes the exit-code table so an agent can branch on failure', async () => {
    const document = await schemaDocument();

    const exitCodes = Object.fromEntries(
      document.exitCodes.map((entry) => [entry.name, entry.code]),
    );
    expect(exitCodes).toEqual({ ...CLI_EXIT_CODES });
    expect(exitCodes.success).toBe(0);
    expect(exitCodes.usage).toBe(2);
    expect(exitCodes.authentication).toBe(3);
  });

  it('includes every error code mapped to its exit code', async () => {
    const document = await schemaDocument();

    expect(document.errorCodes.map((entry) => entry.code)).toEqual([...ERROR_CODES]);
    const mapped = Object.fromEntries(
      document.errorCodes.map((entry) => [entry.code, entry.exitCode]),
    );
    expect(mapped.AUTHENTICATION_REQUIRED).toBe(CLI_EXIT_CODES.authentication);
    expect(mapped.AUTHORIZATION_DENIED).toBe(CLI_EXIT_CODES.authorization);
    expect(mapped.ARTIFACT_NOT_FOUND).toBe(CLI_EXIT_CODES.validation);
    expect(mapped.SERVICE_UNAVAILABLE).toBe(CLI_EXIT_CODES.transient);
    expect(mapped.INTERNAL_ERROR).toBe(CLI_EXIT_CODES.unexpected);
  });

  it('needs no profile, network access, or credential', async () => {
    const stdout = capture();
    const stderr = capture();

    const exitCode = await runCli(['node', 'shelf', 'schema'], {
      env: {},
      stdout: stdout.write,
      stderr: stderr.write,
      fetch: (() => {
        throw new Error('shelf schema must not perform network requests');
      }) as unknown as typeof globalThis.fetch,
    });

    expect(exitCode).toBe(CLI_EXIT_CODES.success);
    expect(stderr.value()).toBe('');
    expect(JSON.parse(stdout.value()).apiVersion).toBe('v1');
  });
});

describe('shelf <command> --schema', () => {
  it('prints only that command and exits zero', async () => {
    const result = await run('artifacts', 'list', '--schema');

    expect(result.exitCode).toBe(CLI_EXIT_CODES.success);
    expect(result.stderr).toBe('');
    expect(result.stdout.trimEnd().includes('\n')).toBe(false);

    const document = JSON.parse(result.stdout) as SchemaCommandDocument;
    expect(document.command.path).toBe('artifacts list');
    // A single-command reply carries no exit-code or error-code tables.
    expect('exitCodes' in document).toBe(false);
    expect('errorCodes' in document).toBe(false);
    expect('commands' in document).toBe(false);
  });

  it('succeeds without supplying the command required options', async () => {
    // --artifact is a requiredOption on "artifacts show"; --schema must answer
    // before Commander enforces it, without the option being weakened.
    const command = await commandDocument('artifacts', 'show', '--schema');

    expect(command.path).toBe('artifacts show');
    expect(optionAt(command, '--artifact').required).toBe(true);
  });

  it('succeeds for a command with several required options', async () => {
    const command = await commandDocument('comments', 'reply', '--schema');

    expect(command.path).toBe('comments reply');
    for (const flag of ['--artifact', '--thread', '--body']) {
      expect(optionAt(command, flag).required).toBe(true);
    }
    expect(optionAt(command, '--display-name').required).toBeUndefined();
  });

  it('succeeds for a command with a required positional argument', async () => {
    // <name> is required on "profiles set" and is not supplied here.
    const command = await commandDocument('profiles', 'set', '--schema');

    expect(command.path).toBe('profiles set');
    expect(command.arguments?.[0]?.name).toBe('name');
    expect(command.arguments?.[0]?.required).toBe(true);
    expect(optionAt(command, '--url').required).toBe(true);
  });

  it('works on every nested command in the tree', async () => {
    const document = await schemaDocument();

    for (const path of commandPaths(document)) {
      const command = await commandDocument(...path.split(' '), '--schema');
      expect(command.path, `expected --schema to work for "${path}"`).toBe(path);
    }
  });

  it('works on a command group and lists its subcommands', async () => {
    const command = await commandDocument('folders', '--schema');

    expect(command.path).toBe('folders');
    expect(command.subcommands).toContain('folders publish');
  });

  it('preserves enum choices, defaults, and repeatability', async () => {
    const publish = await commandDocument('folders', 'publish', '--schema');
    const metadata = optionAt(publish, '--metadata');
    expect(metadata.repeatable).toBe(true);
    expect(metadata.default).toEqual([]);

    const summaries = await commandDocument('comments', 'summaries', '--schema');
    const artifact = optionAt(summaries, '--artifact');
    expect(artifact.repeatable).toBe(true);
    expect(artifact.required).toBe(true);

    const create = await commandDocument('shares', 'create', '--schema');
    expect(optionAt(create, '--access').flags).toBe('--access <protected|public>');
    expect(optionAt(create, '--comments').flags).toBe('--comments <off|private|shared>');
  });

  it('carries the command description and its help examples', async () => {
    const command = await commandDocument('artifacts', 'list', '--schema');

    expect(command.description).toBe('List a workspace artifact page');
    expect(command.examples).toContain('shelf artifacts list --profile default');
    expect(command.examples?.every((example) => example.startsWith('shelf '))).toBe(true);
  });

  it('emits no false or null field', async () => {
    const command = await commandDocument('artifacts', 'list', '--schema');
    const serialized = JSON.stringify(command);

    expect(serialized).not.toContain(':false');
    expect(serialized).not.toContain(':null');
  });

  it('is materially smaller than the full tree dump', async () => {
    const single = await run('artifacts', 'list', '--schema');
    const full = await runSchema();

    expect(single.stdout.length).toBeLessThan(full.stdout.length / 10);
  });
});

describe('shelf schema <path>', () => {
  it('returns the same document as "<command> --schema"', async () => {
    for (const path of ['artifacts list', 'comments reply', 'folders publish', 'profiles set']) {
      const segments = path.split(' ');
      const viaSubcommand = await run('schema', ...segments);
      const viaFlag = await run(...segments, '--schema');

      expect(viaSubcommand.exitCode).toBe(CLI_EXIT_CODES.success);
      expect(viaSubcommand.stdout, `mismatch for "${path}"`).toBe(viaFlag.stdout);
    }
  });

  it('exits 2 with a usage error for an unknown path', async () => {
    const result = await run('schema', 'nope', 'bogus');

    expect(result.exitCode).toBe(CLI_EXIT_CODES.usage);
    expect(result.stdout).toBe('');

    const envelope = JSON.parse(result.stderr) as { error: { code: string; message: string } };
    expect(envelope.error.code).toBe('INVALID_REQUEST');
    expect(envelope.error.message).toContain('nope bogus');
  });

  it('exits 2 when a known group is followed by an unknown subcommand', async () => {
    const result = await run('schema', 'artifacts', 'nope');

    expect(result.exitCode).toBe(CLI_EXIT_CODES.usage);
    expect(JSON.parse(result.stderr).error.code).toBe('INVALID_REQUEST');
  });

  it('still dumps the full tree when no path is given', async () => {
    const document = await schemaDocument();

    expect(document.kind).toBe('CommandSchema');
    expect(document.commands.length).toBeGreaterThan(30);
  });
});
