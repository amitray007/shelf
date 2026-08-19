import { PUBLISH_OPERATION } from '@shelf/contracts';
import { createShareLifecycleService } from '@shelf/core';

import type { ShelfAppDependencies } from './app.js';

function lifecycleDependencies(dependencies: ShelfAppDependencies) {
  return {
    shares: dependencies.shareRepository,
    capabilityCodec: dependencies.shareCapabilityCodec,
    ...(dependencies.shareClock === undefined ? {} : { clock: dependencies.shareClock }),
    ...(dependencies.generateShareId === undefined
      ? {}
      : { generateShareId: dependencies.generateShareId }),
    ...(dependencies.generatePublicCode === undefined
      ? {}
      : { generatePublicCode: dependencies.generatePublicCode }),
  };
}

export function createAuthenticatedShareLifecycle(dependencies: ShelfAppDependencies) {
  return createShareLifecycleService({
    ...lifecycleDependencies(dependencies),
    authorizer: dependencies.authorizer,
  });
}

export function createPublishDefaultShareLifecycle(dependencies: ShelfAppDependencies) {
  const lifecycle = createShareLifecycleService({
    ...lifecycleDependencies(dependencies),
    authorizer: {
      authorize(request, signal) {
        if (request.action === PUBLISH_OPERATION) {
          return dependencies.authorizer.authorize(request, signal);
        }
        // Defaults are hidden infrastructure created only after Publish authorization succeeds.
        // The authenticated defaults endpoint uses the full authorizer before returning URLs.
        return Promise.resolve();
      },
    },
  });
  return { ensureDefaultShares: lifecycle.ensureDefaultShares };
}
