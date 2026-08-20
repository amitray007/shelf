import { usageFailure } from './output.js';
import { resolveProfile } from './profiles.js';
import type { CliRuntime } from './runtime.js';

export interface RemoteContextOptions {
  profile?: string;
  url?: string;
  workspace?: string;
  allowInsecureLoopback?: boolean;
}

export interface RemoteContext {
  readonly installationUrl: string;
  readonly workspaceId: string | undefined;
  readonly token: string;
  readonly allowInsecureLoopback?: boolean;
}

export interface WorkspaceRemoteContext extends RemoteContext {
  readonly workspaceId: string;
}

function environmentToken(runtime: CliRuntime): string {
  const value = runtime.env.SHELF_TOKEN;
  if (value === undefined || value.length === 0) throw usageFailure('SHELF_TOKEN is required.');
  return value;
}

function workspaceId(value: string): string {
  if (value.length === 0 || value.length > 128) throw usageFailure('The workspace ID is invalid.');
  return value;
}

/**
 * Resolves one remote command context from either a configured profile or explicit flags.
 * Mixing --profile with --url, --workspace, or --allow-insecure-loopback is a usage error.
 */
export async function resolveRemoteContext(
  options: RemoteContextOptions,
  runtime: CliRuntime,
): Promise<RemoteContext> {
  if (options.profile !== undefined) {
    if (
      options.url !== undefined ||
      options.workspace !== undefined ||
      options.allowInsecureLoopback !== undefined
    ) {
      throw usageFailure(
        '--profile cannot be combined with --url, --workspace, or --allow-insecure-loopback.',
      );
    }
    const profile = await resolveProfile(options.profile, runtime);
    return {
      installationUrl: profile.installationUrl,
      workspaceId: profile.workspaceId,
      token: profile.token,
      allowInsecureLoopback: profile.allowInsecureLoopback,
    };
  }
  if (options.url === undefined) throw usageFailure('--url or --profile is required.');
  return {
    installationUrl: options.url,
    workspaceId: options.workspace === undefined ? undefined : workspaceId(options.workspace),
    token: environmentToken(runtime),
    ...(options.allowInsecureLoopback === undefined
      ? {}
      : { allowInsecureLoopback: options.allowInsecureLoopback }),
  };
}

/** Resolves one workspace-scoped remote command context, requiring a workspace ID. */
export async function resolveWorkspaceContext(
  options: RemoteContextOptions,
  runtime: CliRuntime,
): Promise<WorkspaceRemoteContext> {
  const context = await resolveRemoteContext(options, runtime);
  if (context.workspaceId === undefined)
    throw usageFailure('--workspace or --profile is required.');
  return { ...context, workspaceId: context.workspaceId };
}

/** Reduces one resolved context to the transport fields shared by every client request. */
export function transportFields(context: RemoteContext): {
  installationUrl: string;
  token: string;
  allowInsecureLoopback?: boolean;
} {
  return {
    installationUrl: context.installationUrl,
    token: context.token,
    ...(context.allowInsecureLoopback === undefined
      ? {}
      : { allowInsecureLoopback: context.allowInsecureLoopback }),
  };
}
