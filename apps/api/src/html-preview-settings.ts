import type { OwnerActorRepository } from '@shelf/auth';
import {
  AuthorizationDeniedError,
  type HtmlPreviewSettingsService,
  InvalidTrustedResourceOriginsError,
  ShelfCoreError,
} from '@shelf/core';
import type { AuthenticationContext } from './authenticate.js';

export function createDashboardHtmlPreviewSettings(options: {
  installationId: string;
  appOrigin: string;
  owners: Pick<OwnerActorRepository, 'findHumanOwnerByInstallationId'>;
  settings: HtmlPreviewSettingsService;
}) {
  async function isOwner(identity: AuthenticationContext): Promise<boolean> {
    if (
      identity.authenticationMethod !== 'human-session' ||
      identity.installationId !== options.installationId
    )
      return false;
    const owner = await options.owners.findHumanOwnerByInstallationId(options.installationId);
    return owner?.installationId === identity.installationId && owner.actorId === identity.actorId;
  }
  async function requireOwner(identity: AuthenticationContext): Promise<void> {
    if (!(await isOwner(identity))) throw new AuthorizationDeniedError();
  }
  return {
    isOwner,
    async read(identity: AuthenticationContext) {
      await requireOwner(identity);
      return { apiVersion: 'v1' as const, trustedResourceOrigins: await options.settings.read() };
    },
    async save(identity: AuthenticationContext, values: unknown, origin: string | undefined) {
      await requireOwner(identity);
      // Cookie-authenticated changes must originate on the dashboard itself.
      if (origin !== options.appOrigin) throw new AuthorizationDeniedError();
      try {
        return {
          apiVersion: 'v1' as const,
          trustedResourceOrigins: await options.settings.save(values),
        };
      } catch (error) {
        if (error instanceof InvalidTrustedResourceOriginsError) {
          throw new ShelfCoreError('INVALID_REQUEST', error.message, {
            retryable: false,
            details: [{ field: 'trustedResourceOrigins', reason: 'invalid' }],
          });
        }
        throw error;
      }
    },
  };
}
export type DashboardHtmlPreviewSettings = ReturnType<typeof createDashboardHtmlPreviewSettings>;
