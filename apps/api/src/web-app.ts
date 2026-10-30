import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { registerShareDocuments, type ShareDocumentReader } from './share-documents.js';

export interface WebAppOptions {
  readonly root: string;
  readonly rendererOrigin?: string;
  /**
   * Origins permitted to frame the document, for deployments that embed Shelf
   * in a dashboard. Empty keeps the default refusal.
   */
  readonly allowedFrameOrigins?: readonly string[];
  readonly shareReader?: ShareDocumentReader;
}

function applyDocumentHeaders(
  reply: FastifyReply,
  rendererOrigin: string | undefined,
  allowedFrameOrigins: readonly string[] | undefined,
): void {
  const rendererSource = rendererOrigin ?? "'none'";
  const frameAncestors =
    allowedFrameOrigins !== undefined && allowedFrameOrigins.length > 0
      ? allowedFrameOrigins.join(' ')
      : "'none'";
  void reply.header('Cache-Control', 'no-store, no-transform');
  void reply.header(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      "base-uri 'none'",
      "connect-src 'self'",
      "font-src 'self'",
      `form-action 'self' ${rendererSource}`,
      `frame-src ${rendererSource}`,
      `frame-ancestors ${frameAncestors}`,
      "img-src 'self' https://api.dicebear.com data: blob:",
      "media-src 'self'",
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

export function addSharePreloads(document: string, manifest: unknown): string {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return document;
  const entries = manifest as Record<string, { file?: unknown; imports?: unknown; css?: unknown }>;
  const files = new Set<string>();
  const styles = new Set<string>();
  const entry = entries['index.html'];
  const alreadyLoaded = new Set<unknown>([entry?.file]);
  if (Array.isArray(entry?.imports)) {
    for (const key of entry.imports)
      if (typeof key === 'string') alreadyLoaded.add(entries[key]?.file);
  }
  for (const key of ['src/viewer-loader.ts', 'src/viewer-page.tsx']) {
    const chunk = entries[key];
    if (!chunk || typeof chunk !== 'object') continue;
    const direct = [chunk.file];
    if (Array.isArray(chunk.imports)) {
      for (const dependency of chunk.imports)
        if (typeof dependency === 'string') direct.push(entries[dependency]?.file);
    }
    for (const file of direct)
      if (
        typeof file === 'string' &&
        /^assets\/[\w.-]+\.js$/.test(file) &&
        !alreadyLoaded.has(file)
      )
        files.add(file);
    if (key === 'src/viewer-page.tsx' && Array.isArray(chunk.css))
      for (const css of chunk.css)
        if (typeof css === 'string' && /^assets\/[\w.-]+\.css$/.test(css)) styles.add(css);
  }
  const hints = [...files]
    .map((file) => `<link rel="modulepreload" href="/${file}">`)
    .concat([...styles].map((file) => `<link rel="preload" as="style" href="/${file}">`));
  return document.replace('</head>', `${hints.join('')}</head>`);
}

export async function registerWebApp(app: FastifyInstance, options: WebAppOptions): Promise<void> {
  const root = resolve(options.root);
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('SHELF_WEB_ROOT must identify a real directory.');
  }
  const [index, favicon, assets] = await Promise.all([
    lstat(join(root, 'index.html')),
    lstat(join(root, 'favicon.svg')),
    lstat(join(root, 'assets')),
  ]);
  if (
    !index.isFile() ||
    index.isSymbolicLink() ||
    !favicon.isFile() ||
    favicon.isSymbolicLink() ||
    !assets.isDirectory() ||
    assets.isSymbolicLink()
  ) {
    throw new Error('SHELF_WEB_ROOT must contain a real index, favicon, and asset directory.');
  }

  await app.register(fastifyStatic, {
    root: join(root, 'assets'),
    prefix: '/assets/',
    index: false,
    immutable: true,
    maxAge: '1y',
    preCompressed: true,
  });

  for (const favicon of ['favicon.svg', 'favicon.ico']) {
    app.get(`/${favicon}`, { schema: { hide: true } }, async (_request, reply) => {
      void reply.header('Cache-Control', 'public, max-age=86400');
      void reply.header('X-Content-Type-Options', 'nosniff');
      return reply.sendFile(favicon, root, {
        cacheControl: false,
        immutable: false,
        maxAge: 0,
      });
    });
  }

  const indexDocument = await readFile(join(root, 'index.html'), 'utf8');
  let shareDocument = indexDocument;
  try {
    const manifest: unknown = JSON.parse(await readFile(join(root, '.vite/manifest.json'), 'utf8'));
    if (
      typeof manifest !== 'object' ||
      manifest === null ||
      Array.isArray(manifest) ||
      !Object.values(manifest).every(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          'file' in entry &&
          typeof entry.file === 'string' &&
          (!('imports' in entry) ||
            (Array.isArray(entry.imports) &&
              entry.imports.every((key: unknown) => typeof key === 'string'))) &&
          (!('css' in entry) ||
            (Array.isArray(entry.css) &&
              entry.css.every((file: unknown) => typeof file === 'string'))),
      )
    )
      throw new Error('Invalid Vite manifest.');
    shareDocument = addSharePreloads(indexDocument, manifest);
  } catch (error) {
    app.log.warn(
      { err: error },
      'Vite manifest unavailable or invalid; serving share shell without preloads.',
    );
  }
  if (options.shareReader !== undefined) {
    registerShareDocuments(app, options.shareReader, shareDocument, (reply) =>
      applyDocumentHeaders(reply, options.rendererOrigin, options.allowedFrameOrigins),
    );
  }
  const paths = ['/', '/signin', '/app', '/app/*', '/preview/:artifactId'];
  if (options.shareReader === undefined) paths.push('/s/:shareId');
  for (const path of paths) {
    app.get(path, { schema: { hide: true } }, async (_request, reply) => {
      applyDocumentHeaders(reply, options.rendererOrigin, options.allowedFrameOrigins);
      if (path === '/s/:shareId') return reply.type('text/html').send(shareDocument);
      return reply.sendFile('index.html', root, {
        cacheControl: false,
        immutable: false,
        maxAge: 0,
      });
    });
  }
}
