#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { createRendererRuntime, loadRendererConfig, type RendererRuntime } from '@shelf/renderer';

import { createShelfPersistence } from './persistence.js';
import { shelfPersistenceConfigFromEnv } from './persistence-env.js';
import { loadShareSigningKey, type ShelfServerEnvironment } from './server-config.js';
import { createHmacShareSecurityCodecs } from './share-capability.js';

export interface RendererCliRuntime {
  env: ShelfServerEnvironment;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  onSignal: (signal: NodeJS.Signals, listener: () => void) => void;
  setExitCode: (code: number) => void;
  createRuntime?: typeof createRendererRuntime;
}

export async function runShelfRenderer(
  runtime: RendererCliRuntime = {
    env: process.env,
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
    onSignal: (signal, listener) => process.once(signal, listener),
    setExitCode: (code) => {
      process.exitCode = code;
    },
  },
): Promise<number> {
  let renderer: RendererRuntime | undefined;
  let closePersistence: (() => Promise<void>) | undefined;
  try {
    const rendererConfig = loadRendererConfig(runtime.env);
    const persistenceConfig = shelfPersistenceConfigFromEnv(runtime.env);
    const securityCodecs = createHmacShareSecurityCodecs(await loadShareSigningKey(runtime.env));
    const persistence = createShelfPersistence(persistenceConfig);
    let closePromise: Promise<void> | undefined;
    closePersistence = () => {
      closePromise ??= persistence.close();
      return closePromise;
    };
    const createRuntime = runtime.createRuntime ?? createRendererRuntime;
    renderer = await createRuntime(rendererConfig, {
      shares: persistence.shareRepository,
      viewerSessionTokenCodec: securityCodecs.viewerSession,
      revisions: persistence.revisionRepository,
      folders: persistence.revisionRepository,
      contentReader: persistence.contentReader,
      ready: () => persistence.ready(),
      close: closePersistence,
    });
    const address = await renderer.start();
    const activeRenderer = renderer;
    runtime.stdout(`${JSON.stringify({ status: 'started', address })}\n`);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void activeRenderer.close().then(
        () => runtime.setExitCode(0),
        () => {
          runtime.stderr(
            `${JSON.stringify({ error: { code: 'SHUTDOWN_FAILED', message: 'Shelf renderer shutdown failed.' } })}\n`,
          );
          runtime.setExitCode(1);
        },
      );
    };
    runtime.onSignal('SIGINT', stop);
    runtime.onSignal('SIGTERM', stop);
    return 0;
  } catch {
    await renderer?.close().catch(() => undefined);
    if (renderer === undefined) await closePersistence?.().catch(() => undefined);
    runtime.stderr(
      `${JSON.stringify({ error: { code: 'STARTUP_FAILED', message: 'Shelf renderer failed to start.' } })}\n`,
    );
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runShelfRenderer();
}
