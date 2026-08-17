import type { FastifyRequest } from 'fastify';

import { AuthenticationRequiredError } from './plugins/errors.js';

export interface AuthenticationContext {
  installationId: string;
  actorId: string;
}

export interface Authenticator {
  authenticate(request: FastifyRequest): Promise<AuthenticationContext | undefined>;
}

export async function authenticate(
  request: FastifyRequest,
  authenticator: Authenticator,
): Promise<AuthenticationContext> {
  const context = await authenticator.authenticate(request);
  if (context === undefined) throw new AuthenticationRequiredError();
  return context;
}
