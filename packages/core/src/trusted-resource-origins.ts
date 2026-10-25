import { URL } from 'node:url';

export class InvalidTrustedResourceOriginsError extends Error {
  constructor() {
    super(
      'Enter at most 32 exact HTTPS origins (2048 characters total), without credentials, paths, wildcards, or the Shelf application hostname.',
    );
    this.name = 'InvalidTrustedResourceOriginsError';
  }
}

/** Only exact HTTPS origins are allowed here: CSP keywords, paths, and wildcards are not. */
export function validatedTrustedResourceOrigins(values: unknown, appOrigin: string): string[] {
  const invalid = () => new InvalidTrustedResourceOriginsError();
  if (
    !Array.isArray(values) ||
    values.some((value) => typeof value !== 'string') ||
    values.length > 32 ||
    values.join(' ').length > 2_048
  )
    throw invalid();
  const appHostname = new URL(appOrigin).hostname.replace(/\.$/u, '');
  const origins = values.map((value) => {
    if (!/^https:\/\/[^/?#\\\s*]+\/?$/u.test(value)) throw invalid();
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw invalid();
    }
    if (
      url.username !== '' ||
      url.password !== '' ||
      !/^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])$/u.test(url.hostname) ||
      url.hostname.replace(/\.$/u, '') === appHostname
    ) {
      throw invalid();
    }
    return url.origin;
  });
  return [...new Set(origins)];
}
