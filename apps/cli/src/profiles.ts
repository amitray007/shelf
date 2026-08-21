import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { usageFailure } from './output.js';
import type { CliKeyring, CliRuntime } from './runtime.js';
import { ensurePrivateDirectory, writePrivateFileAtomically } from './secure-state.js';

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const ENVIRONMENT_VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const MAX_CONFIG_BYTES = 1024 * 1024;

export interface EnvironmentCredentialReference {
  readonly type: 'environment';
  readonly variable: string;
}

export interface KeyringCredentialReference {
  readonly type: 'keyring';
  readonly account: string;
}

export type CredentialReference = EnvironmentCredentialReference | KeyringCredentialReference;

export interface StoredProfile {
  readonly installationUrl: string;
  readonly workspaceId: string;
  readonly allowInsecureLoopback: boolean;
  readonly credential: CredentialReference;
}

interface ProfileConfiguration {
  readonly version: 1;
  readonly profiles: Readonly<Record<string, StoredProfile>>;
}

export interface ProfileSummary extends StoredProfile {
  readonly name: string;
}

export interface ResolvedProfile extends ProfileSummary {
  readonly token: string;
}

export interface SetProfileOptions {
  readonly name: string;
  readonly url: string;
  readonly workspace: string;
  readonly credentialEnv?: string;
  readonly storeTokenFromEnv?: string;
  readonly allowInsecureLoopback?: boolean;
}

function stateDirectory(env: Readonly<Record<string, string | undefined>>): string {
  if (env.SHELF_CONFIG_DIR !== undefined && env.SHELF_CONFIG_DIR.length > 0) {
    return env.SHELF_CONFIG_DIR;
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Preferences', 'Shelf');
  if (process.platform === 'win32') {
    return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Shelf', 'Config');
  }
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'shelf');
}

function configurationPath(env: Readonly<Record<string, string | undefined>>): string {
  return join(stateDirectory(env), 'profiles.json');
}

function isCredentialReference(value: unknown): value is CredentialReference {
  if (typeof value !== 'object' || value === null || Object.keys(value).length !== 2) return false;
  const record = value as Record<string, unknown>;
  if (record.type === 'environment') {
    return typeof record.variable === 'string' && ENVIRONMENT_VARIABLE.test(record.variable);
  }
  return (
    record.type === 'keyring' &&
    typeof record.account === 'string' &&
    record.account.length >= 1 &&
    record.account.length <= 255
  );
}

function isStoredProfile(value: unknown): value is StoredProfile {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 4 &&
    typeof record.installationUrl === 'string' &&
    typeof record.workspaceId === 'string' &&
    typeof record.allowInsecureLoopback === 'boolean' &&
    isCredentialReference(record.credential)
  );
}

function isConfiguration(value: unknown): value is ProfileConfiguration {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || record.version !== 1) return false;
  if (typeof record.profiles !== 'object' || record.profiles === null) return false;
  return Object.entries(record.profiles).every(
    ([name, profile]) => PROFILE_NAME.test(name) && isStoredProfile(profile),
  );
}

async function readConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): Promise<ProfileConfiguration> {
  const path = configurationPath(env);
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_CONFIG_BYTES) {
      throw usageFailure('The Shelf profile configuration is unsafe or invalid.');
    }
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isConfiguration(parsed)) {
      throw usageFailure('The Shelf profile configuration is invalid.');
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, profiles: {} };
    if (error instanceof SyntaxError) {
      throw usageFailure('The Shelf profile configuration is invalid.');
    }
    throw error;
  }
}

async function writeConfiguration(
  env: Readonly<Record<string, string | undefined>>,
  configuration: ProfileConfiguration,
): Promise<void> {
  const path = configurationPath(env);
  const directory = dirname(path);
  await ensurePrivateDirectory(
    directory,
    'The Shelf configuration directory must be a real directory.',
  );
  await writePrivateFileAtomically(
    path,
    `${JSON.stringify(configuration, null, 2)}\n`,
    'The Shelf profile configuration is unsafe or invalid.',
  );
}

function validatedOrigin(value: string, allowInsecureLoopback: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw usageFailure('The installation URL is invalid.');
  }
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.pathname !== '' && url.pathname !== '/') ||
    (url.protocol !== 'https:' && !(allowInsecureLoopback && loopback && url.protocol === 'http:'))
  ) {
    throw usageFailure('The installation URL must be a permitted origin.');
  }
  return url.origin;
}

export async function executeSetProfile(
  options: SetProfileOptions,
  runtime: CliRuntime,
): Promise<{ readonly apiVersion: 'v1'; readonly profile: ProfileSummary }> {
  if (!PROFILE_NAME.test(options.name)) throw usageFailure('The profile name is invalid.');
  if (options.workspace.length === 0 || options.workspace.length > 128) {
    throw usageFailure('The workspace ID is invalid.');
  }
  if (
    (options.credentialEnv === undefined) === (options.storeTokenFromEnv === undefined) ||
    (options.credentialEnv !== undefined && !ENVIRONMENT_VARIABLE.test(options.credentialEnv)) ||
    (options.storeTokenFromEnv !== undefined &&
      !ENVIRONMENT_VARIABLE.test(options.storeTokenFromEnv))
  ) {
    throw usageFailure('The credential environment variable name is invalid.');
  }
  const installationUrl = validatedOrigin(options.url, options.allowInsecureLoopback ?? false);
  let credential: CredentialReference;
  let newKeyring: { adapter: CliKeyring; account: string } | undefined;
  if (options.credentialEnv !== undefined) {
    credential = { type: 'environment', variable: options.credentialEnv };
  } else {
    const variable = options.storeTokenFromEnv as string;
    const token = runtime.env[variable];
    if (token === undefined || token.length === 0) {
      throw usageFailure(`Environment variable ${variable} is required to store this credential.`);
    }
    const adapter = await keyring(runtime);
    const context = createHash('sha256')
      .update(`${installationUrl}\0${options.workspace}`)
      .digest('hex')
      .slice(0, 16);
    const account = `profile:${options.name}:${context}:${randomUUID()}`;
    try {
      await adapter.setPassword('shelf-cli', account, token);
    } catch {
      throw usageFailure(
        'The native keyring could not store the credential; use --credential-env for an explicit environment reference.',
      );
    }
    newKeyring = { adapter, account };
    credential = { type: 'keyring', account };
  }
  const profile: StoredProfile = {
    installationUrl,
    workspaceId: options.workspace,
    allowInsecureLoopback: options.allowInsecureLoopback ?? false,
    credential,
  };
  const configuration = await readConfiguration(runtime.env);
  try {
    await writeConfiguration(runtime.env, {
      version: 1,
      profiles: { ...configuration.profiles, [options.name]: profile },
    });
  } catch (error) {
    if (newKeyring !== undefined) {
      await newKeyring.adapter
        .deletePassword('shelf-cli', newKeyring.account)
        .catch(() => undefined);
    }
    throw error;
  }
  const previous = configuration.profiles[options.name]?.credential;
  if (previous?.type === 'keyring' && previous.account !== newKeyring?.account) {
    const adapter = newKeyring?.adapter ?? (await keyring(runtime));
    await adapter.deletePassword('shelf-cli', previous.account).catch(() => undefined);
  }
  return { apiVersion: 'v1', profile: { name: options.name, ...profile } };
}

export async function executeListProfiles(
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ readonly apiVersion: 'v1'; readonly profiles: readonly ProfileSummary[] }> {
  const configuration = await readConfiguration(env);
  const profiles = Object.entries(configuration.profiles)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, profile]) => ({ name, ...profile }));
  return { apiVersion: 'v1', profiles };
}

export async function executeShowProfile(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ readonly apiVersion: 'v1'; readonly profile: ProfileSummary }> {
  if (!PROFILE_NAME.test(name)) throw usageFailure('The profile name is invalid.');
  const profile = (await readConfiguration(env)).profiles[name];
  if (profile === undefined) throw usageFailure(`Shelf profile "${name}" is not configured.`);
  return { apiVersion: 'v1', profile: { name, ...profile } };
}

export async function executeRemoveProfile(
  name: string,
  confirmed: boolean | undefined,
  runtime: CliRuntime,
): Promise<{ readonly apiVersion: 'v1'; readonly removed: { readonly name: string } }> {
  if (!PROFILE_NAME.test(name)) throw usageFailure('The profile name is invalid.');
  if (!confirmed) throw usageFailure('Profile removal requires --yes.');
  const configuration = await readConfiguration(runtime.env);
  const profile = configuration.profiles[name];
  if (profile === undefined) throw usageFailure(`Shelf profile "${name}" is not configured.`);
  if (profile.credential.type === 'keyring') {
    try {
      await (await keyring(runtime)).deletePassword('shelf-cli', profile.credential.account);
    } catch {
      throw usageFailure('The native keyring could not remove this profile credential.');
    }
  }
  await writeConfiguration(runtime.env, {
    version: 1,
    profiles: Object.fromEntries(
      Object.entries(configuration.profiles).filter(([profileName]) => profileName !== name),
    ),
  });
  return { apiVersion: 'v1', removed: { name } };
}

/** Reports whether a profile with this name is configured, without resolving its credential. */
export async function hasProfile(name: string, runtime: CliRuntime): Promise<boolean> {
  if (!PROFILE_NAME.test(name)) return false;
  return (await readConfiguration(runtime.env)).profiles[name] !== undefined;
}

export async function resolveProfile(
  requestedName: string | undefined,
  runtime: CliRuntime,
): Promise<ResolvedProfile> {
  const name = requestedName ?? 'default';
  if (!PROFILE_NAME.test(name)) throw usageFailure('The profile name is invalid.');
  const profile = (await readConfiguration(runtime.env)).profiles[name];
  if (profile === undefined) {
    throw usageFailure(`Shelf profile "${name}" is not configured.`);
  }
  let token: string | null | undefined;
  if (profile.credential.type === 'environment') {
    token = runtime.env[profile.credential.variable];
  } else {
    try {
      token = await (await keyring(runtime)).getPassword('shelf-cli', profile.credential.account);
    } catch {
      throw usageFailure('The native keyring could not read this profile credential.');
    }
  }
  if (token === undefined || token === null || token.length === 0) {
    throw usageFailure(
      profile.credential.type === 'environment'
        ? `Shelf profile "${name}" requires environment variable ${profile.credential.variable}.`
        : `Shelf profile "${name}" has no readable native-keyring credential.`,
    );
  }
  return { name, ...profile, token };
}

async function keyring(runtime: CliRuntime): Promise<CliKeyring> {
  if (runtime.keyring !== undefined) return runtime.keyring;
  try {
    const { Entry } = await import('@napi-rs/keyring');
    return {
      async setPassword(service, account, password) {
        new Entry(service, account).setPassword(password);
      },
      async getPassword(service, account) {
        return new Entry(service, account).getPassword();
      },
      async deletePassword(service, account) {
        new Entry(service, account).deletePassword();
      },
    };
  } catch {
    throw usageFailure(
      'The native keyring is unavailable; configure an explicit environment credential reference.',
    );
  }
}
