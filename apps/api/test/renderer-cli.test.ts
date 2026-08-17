import { describe, expect, it, vi } from 'vitest';

import { runShelfRenderer } from '../src/renderer-cli.js';

function environment(secret: string) {
  return {
    DATABASE_URL: 'postgresql://shelf@localhost/shelf',
    SHELF_STORAGE_DRIVER: 'local',
    SHELF_STORAGE_LOCAL_ROOT: '/tmp/shelf-renderer-test-content',
    SHELF_SHARE_SIGNING_KEY: secret,
    SHELF_RENDERER_APP_ORIGIN: 'http://127.0.0.1:5173',
    SHELF_RENDERER_PORT: '3001',
  };
}

describe('shelf-renderer process boundary', () => {
  it('starts, reports one document, and closes once on repeated signals', async () => {
    const close = vi.fn(async () => undefined);
    const listeners = new Map<NodeJS.Signals, () => void>();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCodes: number[] = [];
    const createRuntime = vi.fn(async () => ({
      app: {} as never,
      start: async () => 'http://127.0.0.1:3001',
      close,
    }));

    await expect(
      runShelfRenderer({
        env: environment('s'.repeat(32)),
        stdout: (chunk) => stdout.push(chunk),
        stderr: (chunk) => stderr.push(chunk),
        onSignal: (signal, listener) => listeners.set(signal, listener),
        setExitCode: (code) => exitCodes.push(code),
        createRuntime,
      }),
    ).resolves.toBe(0);

    expect(stdout.map((chunk) => JSON.parse(chunk))).toEqual([
      { status: 'started', address: 'http://127.0.0.1:3001' },
    ]);
    expect(stderr).toEqual([]);
    listeners.get('SIGTERM')?.();
    listeners.get('SIGINT')?.();
    await vi.waitFor(() => expect(exitCodes).toEqual([0]));
    expect(close).toHaveBeenCalledOnce();
  });

  it('returns one secret-free startup failure document', async () => {
    const secret = 'renderer-secret-canary-that-must-stay-private';
    const stderr: string[] = [];
    const result = await runShelfRenderer({
      env: environment(secret),
      stdout() {},
      stderr: (chunk) => stderr.push(chunk),
      onSignal() {},
      setExitCode() {},
      createRuntime: async () => {
        throw new Error(secret);
      },
    });

    expect(result).toBe(1);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).not.toContain(secret);
    expect(JSON.parse(stderr[0] ?? '')).toEqual({
      error: { code: 'STARTUP_FAILED', message: 'Shelf renderer failed to start.' },
    });
  });

  it('rejects invalid renderer configuration before opening persistence', async () => {
    const createRuntime = vi.fn();
    const result = await runShelfRenderer({
      env: { ...environment('s'.repeat(32)), SHELF_RENDERER_APP_ORIGIN: 'http://public.example' },
      stdout() {},
      stderr() {},
      onSignal() {},
      setExitCode() {},
      createRuntime,
    });

    expect(result).toBe(1);
    expect(createRuntime).not.toHaveBeenCalled();
  });
});
