import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';

const PublicClientConfigSchema = Type.Object(
  {
    apiVersion: Type.Literal('v1'),
    rendererOrigin: Type.Union([Type.String({ format: 'uri' }), Type.Null()]),
  },
  { additionalProperties: false },
);

export function registerPublicConfigRoute(
  app: FastifyInstance,
  rendererOrigin: string | undefined,
): void {
  app.get(
    '/api/v1/public/config',
    {
      schema: {
        operationId: 'getPublicClientConfigV1',
        summary: 'Get non-secret browser runtime configuration',
        tags: ['public configuration'],
        response: { 200: PublicClientConfigSchema },
      },
    },
    async (_request, reply) => {
      void reply.header('Cache-Control', 'public, max-age=300');
      return { apiVersion: 'v1' as const, rendererOrigin: rendererOrigin ?? null };
    },
  );
}
