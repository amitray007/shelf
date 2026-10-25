import { validatedAppOrigin, validatedTrustedResourceOrigins } from './policy.js';
import { DEFAULT_MAX_HTML_BYTES } from './resolver.js';

export type RendererEnvironment = Readonly<Record<string, string | undefined>>;

export interface RendererConfig {
  host: string;
  port: number;
  appOrigin: string;
  maxHtmlBytes: number;
  trustedResourceOrigins?: readonly string[];
}

function environmentValue(environment: RendererEnvironment, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function boundedInteger(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

export function loadRendererConfig(environment: RendererEnvironment = process.env): RendererConfig {
  const host = environment.SHELF_RENDERER_HOST ?? '127.0.0.1';
  if (
    host.length === 0 ||
    host.length > 253 ||
    host.includes('\u0000') ||
    host.includes('\r') ||
    host.includes('\n')
  ) {
    throw new Error('SHELF_RENDERER_HOST is invalid.');
  }
  const appOrigin = validatedAppOrigin(environmentValue(environment, 'SHELF_RENDERER_APP_ORIGIN'));
  let trustedResourceOrigins: string[];
  try {
    trustedResourceOrigins = validatedTrustedResourceOrigins(
      (environment.SHELF_RENDERER_TRUSTED_RESOURCE_ORIGINS ?? '').split(/[\s,]+/u).filter(Boolean),
      appOrigin,
    );
  } catch {
    throw new Error(
      'SHELF_RENDERER_TRUSTED_RESOURCE_ORIGINS must list at most 32 exact HTTPS origins without paths, credentials, wildcards, or the application hostname.',
    );
  }
  return {
    host,
    port: boundedInteger(
      environment.SHELF_RENDERER_PORT ?? '3001',
      'SHELF_RENDERER_PORT',
      1,
      65_535,
    ),
    appOrigin,
    trustedResourceOrigins,
    maxHtmlBytes: boundedInteger(
      environment.SHELF_RENDERER_MAX_HTML_BYTES ?? String(DEFAULT_MAX_HTML_BYTES),
      'SHELF_RENDERER_MAX_HTML_BYTES',
      1,
      DEFAULT_MAX_HTML_BYTES,
    ),
  };
}
