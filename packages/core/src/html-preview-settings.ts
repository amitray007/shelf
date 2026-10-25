import { ShelfCoreError } from './errors.js';
import { validatedTrustedResourceOrigins } from './trusted-resource-origins.js';

export interface HtmlPreviewSettingsRepository {
  findTrustedResourceOrigins(installationId: string): Promise<unknown | undefined>;
  saveTrustedResourceOrigins(installationId: string, origins: readonly string[]): Promise<void>;
}

/** A missing row uses deployment defaults; a saved empty list explicitly blocks external assets. */
export function createHtmlPreviewSettingsService(options: {
  installationId: string;
  repository: HtmlPreviewSettingsRepository;
  appOrigin: string;
  rendererOrigin?: string;
  defaultTrustedResourceOrigins?: readonly string[];
}) {
  const defaults = validatedTrustedResourceOrigins(
    options.defaultTrustedResourceOrigins ?? [],
    options.appOrigin,
  );
  const rendererHostname =
    options.rendererOrigin === undefined
      ? undefined
      : new URL(options.rendererOrigin).hostname.replace(/\.$/u, '');
  const excludeRenderer = (origins: string[]) =>
    origins.filter((origin) => new URL(origin).hostname.replace(/\.$/u, '') !== rendererHostname);
  const unavailable = () =>
    new ShelfCoreError('SERVICE_UNAVAILABLE', 'HTML preview settings are unavailable. Try again.', {
      retryable: true,
    });
  return {
    async read(): Promise<string[]> {
      try {
        const stored = await options.repository.findTrustedResourceOrigins(options.installationId);
        return excludeRenderer(
          validatedTrustedResourceOrigins(
            stored === undefined ? defaults : stored,
            options.appOrigin,
          ),
        );
      } catch {
        // Never restore deployment permissions after a failed or invalid database read.
        throw unavailable();
      }
    },
    async save(values: unknown): Promise<string[]> {
      const origins = validatedTrustedResourceOrigins(values, options.appOrigin);
      if (excludeRenderer(origins).length !== origins.length) {
        throw new ShelfCoreError(
          'INVALID_REQUEST',
          'The renderer hostname cannot be a trusted asset source.',
          { retryable: false },
        );
      }
      try {
        await options.repository.saveTrustedResourceOrigins(options.installationId, origins);
      } catch {
        throw unavailable();
      }
      return origins;
    },
  };
}
export type HtmlPreviewSettingsService = ReturnType<typeof createHtmlPreviewSettingsService>;
