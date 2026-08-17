import { describe, expect, it } from 'vitest';

import { runShelfServer } from '../src/server-cli.js';

describe('shelf-server process boundary', () => {
  it('returns one secret-free startup failure document', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const secret = 'database-and-auth-secret-canary';
    await expect(
      runShelfServer({
        env: { DATABASE_URL: secret, SHELF_AUTH_SECRET: secret },
        stdout: (chunk) => stdout.push(chunk),
        stderr: (chunk) => stderr.push(chunk),
        onSignal() {},
        setExitCode() {},
      }),
    ).resolves.toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).not.toContain(secret);
    expect(JSON.parse(stderr[0] ?? '')).toEqual({
      error: { code: 'STARTUP_FAILED', message: 'Shelf failed to start.' },
    });
  });
});
