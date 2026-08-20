import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerErrorHandler } from '../src/plugins/errors.js';

describe('API error handler', () => {
  it('serializes ordinary errors without requiring a Fastify error code', async () => {
    const app = Fastify();
    registerErrorHandler(app);
    app.get('/boom', async () => {
      throw new Error('database query failed');
    });

    const response = await app.inject({ method: 'GET', url: '/boom' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred.',
        retryable: false,
      },
    });
    await app.close();
  });
});
