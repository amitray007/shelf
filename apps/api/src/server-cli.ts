#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import type { ShelfServer } from './server.js';
import { createShelfServer } from './server.js';
import { loadShelfServerConfig, type ShelfServerEnvironment } from './server-config.js';

export interface ServerCliRuntime {
  env: ShelfServerEnvironment;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  onSignal: (signal: NodeJS.Signals, listener: () => void) => void;
  setExitCode: (code: number) => void;
}

export async function runShelfServer(
  runtime: ServerCliRuntime = {
    env: process.env,
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
    onSignal: (signal, listener) => process.once(signal, listener),
    setExitCode: (code) => {
      process.exitCode = code;
    },
  },
): Promise<number> {
  let server: ShelfServer | undefined;
  try {
    server = await createShelfServer(await loadShelfServerConfig(runtime.env));
    const address = await server.start();
    const activeServer = server;
    runtime.stdout(`${JSON.stringify({ status: 'started', address })}\n`);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void activeServer.close().then(
        () => {
          runtime.setExitCode(0);
        },
        () => {
          runtime.stderr(
            `${JSON.stringify({ error: { code: 'SHUTDOWN_FAILED', message: 'Shelf shutdown failed.' } })}\n`,
          );
          runtime.setExitCode(1);
        },
      );
    };
    runtime.onSignal('SIGINT', stop);
    runtime.onSignal('SIGTERM', stop);
    return 0;
  } catch {
    await server?.close().catch(() => undefined);
    runtime.stderr(
      `${JSON.stringify({ error: { code: 'STARTUP_FAILED', message: 'Shelf failed to start.' } })}\n`,
    );
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runShelfServer();
}
