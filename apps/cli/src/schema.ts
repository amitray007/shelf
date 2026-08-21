import { CLI_EXIT_CODES, ERROR_CODES, exitCodeForError } from '@shelf/contracts';
import type { Argument, Command, Option } from 'commander';

/**
 * Machine-readable description of the command surface. The document is derived
 * from the live Commander tree so it can never drift from the registered
 * commands, and it carries the exit-code and error-code tables an agent needs
 * to branch on failure without scraping formatted help text.
 *
 * The payload is tuned for agent consumption: every field that would carry a
 * `false` or `null` is omitted instead, and fields derivable from `flags` are
 * not repeated. What survives is what an agent cannot reconstruct on its own —
 * the canonical flag string, whether it is REQUIRED, its allowed values, its
 * default, and whether it may be repeated.
 */

/** Flag every command carries so an agent can fetch just that command's contract. */
export const SCHEMA_FLAG = '--schema';

export interface SchemaCommandOptions {
  /** Include options and commands Commander hides from formatted help. */
  readonly includeHidden?: boolean;
}

export interface SchemaArgument {
  /** Positional name without its `<>`/`[]` delimiters. */
  readonly name: string;
  readonly description?: string;
  /** Present and `true` only when the positional must be supplied. */
  readonly required?: true;
  /** Present and `true` only when the positional accepts many values. */
  readonly variadic?: true;
  readonly choices?: readonly string[];
  readonly default?: unknown;
}

export interface SchemaOption {
  /**
   * Canonical form to copy, e.g. `--metadata <key=value>`. Long flag, short
   * flag, and value placeholder are all readable from this string, so they are
   * not repeated as separate keys.
   */
  readonly flags: string;
  readonly description?: string;
  /** Present and `true` only when the option must be supplied. */
  readonly required?: true;
  /** Present and `true` only when the option may be passed more than once. */
  readonly repeatable?: true;
  /** Present and `true` only for a `--no-` style negating flag. */
  readonly negated?: true;
  readonly choices?: readonly string[];
  readonly env?: string;
  readonly default?: unknown;
}

export interface SchemaCommand {
  readonly path: string;
  readonly name: string;
  readonly description?: string;
  readonly aliases?: readonly string[];
  readonly usage: string;
  readonly arguments?: readonly SchemaArgument[];
  readonly options?: readonly SchemaOption[];
  readonly subcommands?: readonly string[];
  /** Copyable invocations lifted from the command's own help text. */
  readonly examples?: readonly string[];
}

export interface SchemaExitCode {
  readonly name: string;
  readonly code: number;
}

export interface SchemaErrorCode {
  readonly code: string;
  readonly exitCode: number;
}

export interface SchemaDocument {
  readonly apiVersion: 'v1';
  readonly kind: 'CommandSchema';
  readonly program: {
    readonly name: string;
    readonly version: string | null;
    readonly description: string | null;
    readonly arguments?: readonly SchemaArgument[];
    readonly options?: readonly SchemaOption[];
  };
  readonly commands: readonly SchemaCommand[];
  readonly exitCodes: readonly SchemaExitCode[];
  readonly errorCodes: readonly SchemaErrorCode[];
}

/** Single-command reply. Carries no exit-code or error-code tables: those are */
/** invariant across the CLI and would dominate a one-command payload. */
export interface SchemaCommandDocument {
  readonly apiVersion: 'v1';
  readonly kind: 'Command';
  readonly command: SchemaCommand;
}

/**
 * A repeatable option is either Commander-variadic or carries a custom
 * accumulating parser over an array default, which is how this CLI registers
 * its repeatable flags (`--metadata`, `--artifact`).
 */
function isRepeatable(option: Option): boolean {
  if (option.variadic) return true;
  return option.parseArg !== undefined && Array.isArray(option.defaultValue);
}

function isSerializable(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.every(isSerializable);
  const type = typeof value;
  return type === 'string' || type === 'number' || type === 'boolean';
}

/** Emit `{ key: value }` only when the flag is true, so `false` never ships. */
function whenTrue<K extends string>(
  key: K,
  value: boolean,
): Record<K, true> | Record<string, never> {
  return value ? ({ [key]: true } as Record<K, true>) : {};
}

function whenPresent<K extends string>(
  key: K,
  value: string,
): Record<K, string> | Record<string, never> {
  return value.length > 0 ? ({ [key]: value } as Record<K, string>) : {};
}

function describeArgument(argument: Argument): SchemaArgument {
  return {
    name: argument.name(),
    ...whenPresent('description', argument.description),
    ...whenTrue('required', argument.required),
    ...whenTrue('variadic', argument.variadic),
    ...(argument.argChoices === undefined ? {} : { choices: [...argument.argChoices] }),
    ...(argument.defaultValue === undefined || !isSerializable(argument.defaultValue)
      ? {}
      : { default: argument.defaultValue }),
  };
}

function describeOption(option: Option): SchemaOption {
  return {
    flags: option.flags,
    ...whenPresent('description', option.description),
    ...whenTrue('required', option.mandatory),
    ...whenTrue('repeatable', isRepeatable(option)),
    ...whenTrue('negated', option.negate),
    ...(option.argChoices === undefined ? {} : { choices: [...option.argChoices] }),
    ...(option.envVar === undefined ? {} : { env: option.envVar }),
    ...(option.defaultValue === undefined || !isSerializable(option.defaultValue)
      ? {}
      : { default: option.defaultValue }),
  };
}

function visibleOptions(command: Command, includeHidden: boolean): readonly SchemaOption[] {
  return command.options
    .filter((option) => includeHidden || !option.hidden)
    .map((option) => describeOption(option));
}

/**
 * Commander has no public accessor for a hidden subcommand, so mirror the
 * private flag its own help formatter reads (`Help.visibleCommands`).
 */
function isHidden(command: Command): boolean {
  return (command as Command & { _hidden?: boolean })._hidden === true;
}

export function subcommandsOf(command: Command, includeHidden = false): readonly Command[] {
  return command.commands.filter((child) => includeHidden || !isHidden(child));
}

/**
 * `addHelpText('after', ...)` registers an `afterHelp` listener that writes its
 * block to a caller-supplied sink; emitting that event with a capturing sink is
 * how the help formatter itself collects the text. Every example in this CLI is
 * written as a line beginning with `shelf `, so lift exactly those lines and
 * drop the surrounding prose. A block with no such line yields no examples
 * rather than guessed ones.
 */
function extractExamples(command: Command): readonly string[] {
  // Commander's Command extends EventEmitter at runtime, but its type
  // declarations do not surface `emit`, so reach it through a narrow shape.
  const emitter = command as unknown as {
    emit?: (event: string, context: unknown) => unknown;
  };
  if (typeof emitter.emit !== 'function') return [];

  let text = '';
  try {
    emitter.emit('afterHelp', {
      error: false,
      write: (chunk: string) => {
        text += chunk;
      },
      command,
    });
  } catch {
    return [];
  }

  const examples: string[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('shelf ') && !examples.includes(line)) examples.push(line);
  }
  return examples;
}

function describeOne(
  command: Command,
  segments: readonly string[],
  children: readonly Command[],
  includeHidden: boolean,
): SchemaCommand {
  const aliases = command.aliases();
  const args = command.registeredArguments.map((argument) => describeArgument(argument));
  const options = visibleOptions(command, includeHidden);
  const examples = extractExamples(command);

  return {
    path: segments.join(' '),
    name: command.name(),
    ...whenPresent('description', command.description()),
    ...(aliases.length === 0 ? {} : { aliases: [...aliases] }),
    usage: `${['shelf', ...segments].join(' ')} ${command.usage()}`.trim(),
    ...(args.length === 0 ? {} : { arguments: args }),
    ...(options.length === 0 ? {} : { options }),
    ...(children.length === 0
      ? {}
      : { subcommands: children.map((child) => [...segments, child.name()].join(' ')) }),
    ...(examples.length === 0 ? {} : { examples }),
  };
}

function describeCommand(
  command: Command,
  ancestors: readonly string[],
  includeHidden: boolean,
): readonly SchemaCommand[] {
  const segments = [...ancestors, command.name()];
  const children = subcommandsOf(command, includeHidden);
  const entry = describeOne(command, segments, children, includeHidden);
  const nested = children.flatMap((c) => describeCommand(c, segments, includeHidden));
  return [entry, ...nested];
}

/**
 * Resolve a space- or token-separated command path against the live tree.
 * Returns `undefined` for an unknown path so the caller can raise a normal
 * usage error rather than crashing.
 */
export function resolveCommandPath(
  program: Command,
  segments: readonly string[],
): { readonly command: Command; readonly path: readonly string[] } | undefined {
  let current = program;
  const path: string[] = [];
  for (const segment of segments) {
    const child = subcommandsOf(current, true).find(
      (candidate) => candidate.name() === segment || candidate.aliases().includes(segment),
    );
    if (child === undefined) return undefined;
    current = child;
    path.push(child.name());
  }
  if (path.length === 0) return undefined;
  return { command: current, path };
}

/** Build the single-command reply for an already-resolved command. */
export function describeCommandAt(
  command: Command,
  path: readonly string[],
  options: SchemaCommandOptions = {},
): SchemaCommandDocument {
  const includeHidden = options.includeHidden === true;
  return {
    apiVersion: 'v1',
    kind: 'Command',
    command: describeOne(command, path, subcommandsOf(command, includeHidden), includeHidden),
  };
}

export async function executeSchema(
  program: Command,
  options: SchemaCommandOptions = {},
): Promise<SchemaDocument> {
  const includeHidden = options.includeHidden === true;
  const commands = subcommandsOf(program, includeHidden).flatMap((child) =>
    describeCommand(child, [], includeHidden),
  );
  const programArguments = program.registeredArguments.map((argument) =>
    describeArgument(argument),
  );
  const programOptions = visibleOptions(program, includeHidden);

  return {
    apiVersion: 'v1',
    kind: 'CommandSchema',
    program: {
      name: program.name(),
      version: program.version() ?? null,
      description: program.description().length > 0 ? program.description() : null,
      ...(programArguments.length === 0 ? {} : { arguments: programArguments }),
      ...(programOptions.length === 0 ? {} : { options: programOptions }),
    },
    commands,
    exitCodes: Object.entries(CLI_EXIT_CODES).map(([name, code]) => ({ name, code })),
    errorCodes: ERROR_CODES.map((code) => ({ code, exitCode: exitCodeForError(code) })),
  };
}
