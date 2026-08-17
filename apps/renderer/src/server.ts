import type { RendererApp } from './app.js';
import { type CreateRendererAppOptions, createRendererApp } from './app.js';

export interface CreateRendererServerOptions extends CreateRendererAppOptions {
  host: string;
  port: number;
}

export interface RendererServer {
  readonly app: RendererApp;
  start(): Promise<string>;
  close(): Promise<void>;
}

export async function createRendererServer(
  options: CreateRendererServerOptions,
): Promise<RendererServer> {
  const app = await createRendererApp(options);
  let closePromise: Promise<void> | undefined;
  return {
    app,
    start() {
      return app.listen({ host: options.host, port: options.port });
    },
    close() {
      closePromise ??= app.close();
      return closePromise;
    },
  };
}
