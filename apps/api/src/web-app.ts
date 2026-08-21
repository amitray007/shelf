import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply } from 'fastify';

export interface WebAppOptions {
  readonly root: string;
  readonly rendererOrigin?: string;
}

function applyDocumentHeaders(reply: FastifyReply, rendererOrigin: string | undefined): void {
  const rendererSource = rendererOrigin ?? "'none'";
  void reply.header('Cache-Control', 'no-store');
  void reply.header(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      "base-uri 'none'",
      "connect-src 'self'",
      "font-src 'self'",
      `form-action 'self' ${rendererSource}`,
      `frame-src ${rendererSource}`,
      "frame-ancestors 'none'",
      "img-src 'self' https://api.dicebear.com data: blob:",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
    ].join('; '),
  );
  void reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  void reply.header('Referrer-Policy', 'no-referrer');
  void reply.header('X-Content-Type-Options', 'nosniff');
  void reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
}

export async function registerWebApp(app: FastifyInstance, options: WebAppOptions): Promise<void> {
  const root = resolve(options.root);
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('SHELF_WEB_ROOT must identify a real directory.');
  }
  const [index, assets] = await Promise.all([
    lstat(join(root, 'index.html')),
    lstat(join(root, 'assets')),
  ]);
  if (
    !index.isFile() ||
    index.isSymbolicLink() ||
    !assets.isDirectory() ||
    assets.isSymbolicLink()
  ) {
    throw new Error('SHELF_WEB_ROOT must contain a real index and asset directory.');
  }

  await app.register(fastifyStatic, {
    root: join(root, 'assets'),
    prefix: '/assets/',
    index: false,
    immutable: true,
    maxAge: '1y',
    preCompressed: true,
  });

  for (const path of ['/', '/s/:shareId', '/signin', '/app', '/app/*', '/preview/:artifactId']) {
    app.get(path, { schema: { hide: true } }, async (_request, reply) => {
      applyDocumentHeaders(reply, options.rendererOrigin);
      return reply.sendFile('index.html', root, {
        cacheControl: false,
        immutable: false,
        maxAge: 0,
      });
    });
  }
}
