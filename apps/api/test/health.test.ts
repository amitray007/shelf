import { describe, expect, it } from 'vitest';

import { createShelfApp } from '../src/app.js';
import { createReadinessState } from '../src/health.js';

describe('operational health', () => {
  it('keeps liveness process-only and readiness dependency-backed without OpenAPI exposure', async () => {
    const readiness = createReadinessState(async () => {});
    const app = await createShelfApp({
      stagingRoot: '/tmp/shelf-health-test',
      authenticator: {
        async authenticate() {
          return undefined;
        },
      },
      authorizer: { async authorize() {} },
      health: readiness,
    });
    try {
      expect((await app.inject('/health/live')).json()).toEqual({ status: 'ok' });
      expect(await app.inject('/health/ready')).toMatchObject({ statusCode: 503 });

      readiness.markStarted();
      expect((await app.inject('/health/ready')).json()).toEqual({ status: 'ready' });

      readiness.markStopping();
      expect((await app.inject('/health/ready')).json()).toEqual({ status: 'not_ready' });
      const openapi = app.swagger();
      expect(openapi.paths).not.toHaveProperty('/health/live');
      expect(openapi.paths).not.toHaveProperty('/health/ready');
    } finally {
      await app.close();
    }
  });

  it('returns stable 503 without dependency details', async () => {
    const readiness = createReadinessState(async () => {
      throw new Error('postgresql://secret@private-host/shelf');
    });
    readiness.markStarted();
    const app = await createShelfApp({
      stagingRoot: '/tmp/shelf-health-test-failure',
      authenticator: {
        async authenticate() {
          return undefined;
        },
      },
      authorizer: { async authorize() {} },
      health: readiness,
    });
    try {
      const response = await app.inject('/health/ready');
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: 'not_ready' });
      expect(response.body).not.toContain('private-host');
    } finally {
      await app.close();
    }
  });

  it('coalesces concurrent dependency checks', async () => {
    let release: (() => void) | undefined;
    let checks = 0;
    const readiness = createReadinessState(
      () =>
        new Promise<void>((resolve) => {
          checks += 1;
          release = resolve;
        }),
    );
    readiness.markStarted();
    const first = readiness.check();
    const second = readiness.check();
    expect(checks).toBe(1);
    release?.();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });
});
