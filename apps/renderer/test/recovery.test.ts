import { describe, expect, it } from 'vitest';
import { createRendererApp } from '../src/app.js';

describe('renderer recovery signals', () => {
  for (const transient of [false, true]) {
    it(`keeps ${transient ? 'transient' : 'terminal'} failures distinct and uncached`, async () => {
      const app = await createRendererApp({
        appOrigin: 'https://shelf.example',
        resolver: {
          async resolveHtml() {
            if (transient) throw new Error('storage unavailable');
            return { status: 'unavailable' };
          },
        },
      });
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/render',
          headers: { origin: 'null', 'content-type': 'application/x-www-form-urlencoded' },
          payload: new URLSearchParams({
            publicCode: 'Public123456',
            nonce: 'n'.repeat(22),
          }).toString(),
        });
        expect(response.statusCode).toBe(transient ? 503 : 404);
        expect(response.body).toContain('shelf:renderer-unavailable');
        expect(response.body.includes('{retryable:true}')).toBe(transient);
        expect(response.body).toContain('shelf:renderer-armed');
        expect(response.headers['cache-control']).toContain('no-store');
        expect(response.headers['content-security-policy']).toContain('sandbox allow-scripts');
      } finally {
        await app.close();
      }
    });
  }
});
