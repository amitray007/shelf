import { AuthorizationDeniedError } from '@shelf/core';
import type { FastifyRequest } from 'fastify';

import { AuthenticationRequiredError } from './plugins/errors.js';

export interface AuthenticationContext {
  installationId: string;
  actorId: string;
  authenticationMethod?: 'human-session' | 'access-credential';
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

export async function authenticateHumanSession(
  request: FastifyRequest,
  authenticator: Authenticator,
): Promise<AuthenticationContext & { authenticationMethod: 'human-session' }> {
  const context = await authenticate(request, authenticator);
  if (context.authenticationMethod !== 'human-session') throw new AuthorizationDeniedError();
  return context as AuthenticationContext & { authenticationMethod: 'human-session' };
}
