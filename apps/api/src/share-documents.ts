import { FOLDER_LIMITS, OpaqueRevisionIdSchema, PortableFolderPathSchema } from '@shelf/contracts';
import {
  type createShareAccessService,
  type createShareResolutionService,
  ShareNotFoundError,
  ShelfCoreError,
} from '@shelf/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { Type } from 'typebox';

import { deliverContent } from './content-delivery.js';
import { requestCancellationSignal } from './request-cancellation.js';

export interface ShareDocumentReader {
  resolve: ReturnType<typeof createShareResolutionService>;
  access: ReturnType<typeof createShareAccessService>;
}

type Format = 'html' | 'json' | 'markdown' | 'source';
const MEDIA_TYPES = {
  html: 'text/html',
  json: 'application/json',
  markdown: 'text/markdown',
  source: 'application/octet-stream',
} as const;

// An exact range overrides a wildcard, including q=0. HTML wins equal preferences.
function acceptedFormat(accept: string | undefined): Format | undefined {
  if (accept === undefined) return 'html';
  const ranges = accept
    .toLowerCase()
    .split(',')
    .map((value) => {
      const [media = '', ...parameters] = value.trim().split(';');
      const quality = parameters
        .find((part) => part.trim().startsWith('q='))
        ?.trim()
        .slice(2);
      const q =
        quality === undefined
          ? 1
          : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(quality)
            ? Number(quality)
            : 0;
      return { media: media.trim(), q };
    });
  let selected: Format | undefined;
  let selectedQuality = 0;
  for (const format of Object.keys(MEDIA_TYPES) as Format[]) {
    const media = MEDIA_TYPES[format];
    const matching = ranges.filter(
      (range) =>
        range.media === media ||
        range.media === `${media.split('/')[0]}/*` ||
        range.media === '*/*',
    );
    matching.sort((a, b) => {
      const specificity = (value: string) => (value === '*/*' ? 0 : value.endsWith('/*') ? 1 : 2);
      return specificity(b.media) - specificity(a.media) || b.q - a.q;
    });
    const quality = matching[0]?.q ?? 0;
    if (quality > selectedQuality) {
      selected = format;
      selectedQuality = quality;
    }
  }
  return selected;
}

function queryPath(path: string, values: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) query.set(key, value);
  return query.size === 0 ? path : `${path}?${query}`;
}

function invalid(field: string, reason: string): ShelfCoreError {
  return new ShelfCoreError('INVALID_REQUEST', 'The share read request is invalid.', {
    retryable: false,
    details: [{ field, reason }],
  });
}

function markdownText(value: string): string {
  return JSON.stringify(value).replace(/[\\`*_{}[\]<>()#!|]/g, '\\$&');
}

export function registerShareDocuments(
  app: FastifyInstance,
  reader: ShareDocumentReader,
  viewerDocument: string,
  applyViewerHeaders: (reply: FastifyReply) => void,
): void {
  app.get(
    '/s/:shareId',
    {
      schema: {
        hide: true,
        querystring: Type.Object(
          {
            format: Type.Optional(
              Type.Union([Type.Literal('json'), Type.Literal('markdown'), Type.Literal('source')]),
            ),
            revision: Type.Optional(OpaqueRevisionIdSchema),
            path: Type.Optional(PortableFolderPathSchema),
            cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: FOLDER_LIMITS.treePageSize })),
          },
          { additionalProperties: false },
        ),
      },
      onRequest: async (_request, reply) => {
        reply
          .header('Cache-Control', 'no-store, no-transform')
          .header('Vary', 'Accept')
          .header('Referrer-Policy', 'no-referrer')
          .header('X-Content-Type-Options', 'nosniff')
          .header('X-Robots-Tag', 'noindex, nofollow, noarchive');
      },
    },
    async (request, reply) => {
      const { shareId: reference } = request.params as { shareId: string };
      const query = request.query as {
        format?: Format;
        revision?: string;
        path?: string;
        cursor?: string;
        limit?: number;
      };
      const format = query.format ?? acceptedFormat(request.headers.accept);
      const protectedLink = /^shr_[A-Za-z0-9_-]{22}$/.test(reference);
      const publicLink = /^[A-Za-z0-9_-]{12}$/.test(reference);
      const base = protectedLink
        ? `/api/v1/public/shares/${reference}`
        : `/api/v1/public/links/${reference}`;
      const metadata = queryPath(`/s/${reference}`, { format: 'json', revision: query.revision });
      const links = [
        '</llms.txt>; rel="describedby"; type="text/plain"',
        '</api/v1/openapi.json>; rel="service-desc"; type="application/json"',
      ];
      if (protectedLink || publicLink)
        links.push(`<${metadata}>; rel="alternate"; type="application/json"`);
      reply.header('Link', links.join(', '));
      if (format === undefined)
        return reply.code(406).send({
          error: {
            code: 'INVALID_REQUEST',
            message: 'Use text/html, application/json, text/markdown, or application/octet-stream.',
            retryable: false,
            requestId: request.id,
          },
        });
      if (format === 'html') {
        applyViewerHeaders(reply);
        // The shell performs its own authorization. No artifact lookup delays browser startup.
        const discovery = `<link rel="describedby" href="/llms.txt" type="text/plain">${
          protectedLink || publicLink
            ? `<link rel="alternate" href="${metadata.replaceAll('&', '&amp;')}" type="application/json">`
            : ''
        }`;
        const fallback =
          '<noscript><p>Read this share without JavaScript. <a href="/llms.txt">HTTP reading guide</a>.</p>' +
          (protectedLink || publicLink
            ? `<p><a href="${metadata.replaceAll('&', '&amp;')}">Share metadata and read instructions</a></p>`
            : '') +
          '</noscript>';
        return reply
          .type('text/html')
          .send(
            viewerDocument
              .replace('</head>', `${discovery}</head>`)
              .replace('</body>', `${fallback}</body>`),
          );
      }
      if (!protectedLink && !publicLink) throw new ShareNotFoundError();
      if (protectedLink) {
        // This descriptor is identical for existing and unknown IDs. It reveals no artifact data.
        if (format === 'source') throw new ShareNotFoundError();
        const instructions = {
          apiVersion: 'v1',
          accessType: 'protected',
          guide: '/llms.txt',
          authentication: {
            method: 'POST',
            path: `${base}/sessions`,
            body: {
              sessionId: 'UUID v4; reuse across retries and renewals',
              secret: 'Extract locally from the share URL fragment',
            },
            renewalBody: { sessionId: 'The same UUID v4', token: 'The returned session token' },
          },
          resolve: {
            method: 'POST',
            path: `${base}/resolve`,
            body: { token: 'The returned session token' },
          },
        };
        return format === 'json'
          ? reply.send(instructions)
          : reply
              .type('text/markdown; charset=utf-8')
              .send(
                `# Protected Shelf share\n\nRead [the HTTP guide](/llms.txt). Extract the URL fragment locally.\nPOST JSON with sessionId (UUID v4) and secret to ${base}/sessions.\nReuse sessionId across retries. Use the returned token in a JSON POST to ${base}/resolve.\nThe share URL cannot return protected bytes before this exchange.\n`,
              );
      }
      const signal = requestCancellationSignal(request, reply);
      const selection = {
        authority: { type: 'public' as const, publicCode: reference },
        ...(query.revision === undefined ? {} : { revisionId: query.revision }),
        signal,
      };
      const resolved = await reader.resolve(selection);
      const exact = { ...selection, revisionId: resolved.revision.revisionId };
      const action = queryPath(resolved.action.path, { revisionId: exact.revisionId });
      reply.header(
        'Link',
        [
          ...links,
          `<${action}>; rel="${resolved.action.type === 'tree' ? 'contents' : 'enclosure'}"`,
        ].join(', '),
      );
      if (format === 'json') return reply.send(resolved);
      if (
        format === 'source' ||
        (format === 'markdown' &&
          resolved.revision.kind === 'file' &&
          resolved.revision.mediaType.split(';')[0]?.trim().toLowerCase() === 'text/markdown')
      ) {
        const file =
          resolved.revision.kind === 'file'
            ? await reader.access.readFile(exact)
            : query.path === undefined
              ? undefined
              : await reader.access.readTreeFile({ ...exact, path: query.path });
        if (file === undefined) throw invalid('path', 'choose a file path from the folder tree');
        return deliverContent(
          reply,
          { range: request.headers.range, ifNoneMatch: request.headers['if-none-match'] },
          {
            ...file,
            originalFileName: 'originalFileName' in file ? file.originalFileName : file.path,
          },
          {
            disposition: format === 'source' ? 'attachment' : 'inline',
            fallbackFileName: 'artifact',
          },
        );
      }
      const title = resolved.revision.title ?? resolved.artifact.name;
      const lines = [
        `# Shelf artifact`,
        '',
        `Title: ${markdownText(title)}`,
        `Revision: ${exact.revisionId}`,
        `Kind: ${resolved.revision.kind}`,
        '',
        `[JSON metadata](${metadata})`,
        `[HTTP reading guide](/llms.txt)`,
        '',
      ];
      if (resolved.revision.kind === 'file') {
        lines.push(
          `Media type: ${resolved.revision.mediaType}`,
          `Bytes: ${resolved.revision.byteCount}`,
          `[Download source](${action})`,
          '',
        );
      } else {
        const page = await reader.access.readTree({
          ...exact,
          limit: query.limit ?? FOLDER_LIMITS.treePageSize,
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        });
        lines.push(
          `[Folder tree JSON](${action})`,
          '',
          'Files and directories (paths are JSON strings):',
          '',
        );
        for (const entry of page.items) {
          const path = markdownText(entry.path);
          lines.push(
            entry.kind === 'directory'
              ? `- Directory: ${path}`
              : `- File: ${path}; ${entry.byteCount} bytes; [source](${queryPath(`${base}/tree/content`, { path: entry.path, revisionId: exact.revisionId })})`,
          );
        }
        if (page.nextCursor !== null)
          lines.push(
            '',
            `[Next page](${queryPath(`/s/${reference}`, {
              format: 'markdown',
              revision: exact.revisionId,
              cursor: page.nextCursor,
              limit: String(query.limit ?? FOLDER_LIMITS.treePageSize),
            })})`,
          );
      }
      return reply.type('text/markdown; charset=utf-8').send(`${lines.join('\n')}\n`);
    },
  );
}
