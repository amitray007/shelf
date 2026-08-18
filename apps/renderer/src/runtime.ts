import type {
  ContentReader,
  FolderRevisionRepository,
  RevisionRepository,
  ShareClock,
  ShareRepository,
} from '@shelf/core';

import type { RendererConfig } from './config.js';
import type { ViewerSessionTokenVerifier } from './resolver.js';
import { createCoreHtmlResolver } from './resolver.js';
import { createRendererServer, type RendererServer } from './server.js';

export interface RendererDataPlane {
  shares: ShareRepository;
  viewerSessionTokenCodec: ViewerSessionTokenVerifier;
  revisions: RevisionRepository;
  folders: FolderRevisionRepository;
  contentReader: ContentReader;
  clock?: ShareClock;
  ready(): Promise<void>;
  close(): Promise<void>;
}

export interface RendererRuntime extends RendererServer {}

export async function createRendererRuntime(
  config: RendererConfig,
  dataPlane: RendererDataPlane,
): Promise<RendererRuntime> {
  let server: RendererServer | undefined;
  try {
    server = await createRendererServer({
      host: config.host,
      port: config.port,
      appOrigin: config.appOrigin,
      resolver: createCoreHtmlResolver({
        shares: dataPlane.shares,
        viewerSessionTokenCodec: dataPlane.viewerSessionTokenCodec,
        revisions: dataPlane.revisions,
        folders: dataPlane.folders,
        contentReader: dataPlane.contentReader,
        maxHtmlBytes: config.maxHtmlBytes,
        ...(dataPlane.clock === undefined ? {} : { clock: dataPlane.clock }),
      }),
    });
  } catch (error) {
    await dataPlane.close().catch(() => undefined);
    throw error;
  }

  let startPromise: Promise<string> | undefined;
  let closePromise: Promise<void> | undefined;
  let closing = false;
  return {
    app: server.app,
    start() {
      startPromise ??= (async () => {
        if (closing) throw new Error('Shelf renderer is closed.');
        await dataPlane.ready();
        if (closing) throw new Error('Shelf renderer is closed.');
        return server.start();
      })();
      return startPromise;
    },
    close() {
      closing = true;
      closePromise ??= (async () => {
        await startPromise?.catch(() => undefined);
        await closeRuntime(server, dataPlane);
      })();
      return closePromise;
    },
  };
}

async function closeRuntime(server: RendererServer, dataPlane: RendererDataPlane): Promise<void> {
  const failures: unknown[] = [];
  await server.close().catch((error: unknown) => failures.push(error));
  await dataPlane.close().catch((error: unknown) => failures.push(error));
  if (failures.length > 0) throw new AggregateError(failures, 'Shelf renderer shutdown failed.');
}
