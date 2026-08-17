import type { AccessCredentialService, HumanActorResolver, HumanAuth } from '@shelf/auth';
import { AuthorizationDeniedError, type Authorizer } from '@shelf/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { Authenticator } from '../authenticate.js';

function requestHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, String(value));
    }
  }
  return headers;
}

export function createHybridAuthenticator(options: {
  humanAuth: HumanAuth;
  credentials: AccessCredentialService;
  actors: HumanActorResolver;
}): Authenticator {
  return {
    async authenticate(request) {
      const authorization = request.headers.authorization;
      if (authorization !== undefined) {
        const match = /^Bearer ([^\s]+)$/.exec(authorization);
        if (match?.[1] === undefined) return undefined;
        const actor = await options.credentials.authenticate(match[1]);
        return actor === undefined
          ? undefined
          : {
              installationId: actor.installationId,
              actorId: actor.actorId,
              authenticationMethod: 'access-credential',
            };
      }
      const human = await options.humanAuth.authenticate(requestHeaders(request));
      if (human === undefined) return undefined;
      const actor = await options.actors.findHumanActorByAuthUserId(human.userId);
      return actor === undefined ? undefined : { ...actor, authenticationMethod: 'human-session' };
    },
  };
}

export function createShelfAuthorizer(credentials: AccessCredentialService): Authorizer {
  return {
    async authorize(request) {
      const allowed = await credentials.authorize(request);
      if (!allowed) throw new AuthorizationDeniedError();
    },
  };
}

export async function registerHumanAuthRoutes(
  app: FastifyInstance,
  humanAuth: HumanAuth,
): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    schema: { hide: true },
    async handler(request, reply) {
      const url = new URL(request.url, humanAuth.baseUrl);
      const response = await humanAuth.handle(
        new Request(url, {
          method: request.method,
          headers: requestHeaders(request),
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        }),
      );
      reply.status(response.status);
      for (const [name, value] of response.headers) {
        if (name !== 'set-cookie') reply.header(name, value);
      }
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) reply.header('set-cookie', cookies);
      const body = await response.text();
      return reply.send(body.length === 0 ? null : body);
    },
  });
}
