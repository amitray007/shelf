import {
  type HtmlPreviewSettingsRequest,
  HtmlPreviewSettingsRequestSchema,
  HtmlPreviewSettingsSchema,
} from '@shelf/contracts';
import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { type Authenticator, authenticateHumanSession } from '../authenticate.js';
import type { DashboardHtmlPreviewSettings } from '../html-preview-settings.js';

export function registerHtmlPreviewSettingsRoutes(
  app: FastifyInstance,
  dependencies: {
    authenticator: Authenticator;
    settings: DashboardHtmlPreviewSettings;
  },
): void {
  const response = {
    200: HtmlPreviewSettingsSchema,
    400: Type.Ref('ErrorEnvelope'),
    401: Type.Ref('ErrorEnvelope'),
    403: Type.Ref('ErrorEnvelope'),
    500: Type.Ref('ErrorEnvelope'),
    503: Type.Ref('ErrorEnvelope'),
  };
  app.get(
    '/api/v1/dashboard/settings/html-preview',
    {
      schema: {
        operationId: 'getHtmlPreviewSettingsV1',
        summary: 'Read installation HTML preview settings as the owner',
        tags: ['dashboard'],
        security: [{ cookieAuth: [] }],
        response,
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return dependencies.settings.read(
        await authenticateHumanSession(request, dependencies.authenticator),
      );
    },
  );
  app.put(
    '/api/v1/dashboard/settings/html-preview',
    {
      schema: {
        operationId: 'updateHtmlPreviewSettingsV1',
        summary: 'Set installation HTML preview settings as the owner',
        tags: ['dashboard'],
        security: [{ cookieAuth: [] }],
        body: HtmlPreviewSettingsRequestSchema,
        response,
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const identity = await authenticateHumanSession(request, dependencies.authenticator);
      return dependencies.settings.save(
        identity,
        (request.body as HtmlPreviewSettingsRequest).trustedResourceOrigins,
        request.headers.origin,
      );
    },
  );
}
