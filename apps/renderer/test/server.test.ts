import { describe, expect, it } from 'vitest';

import { createRendererServer } from '../src/server.js';

describe('renderer process', () => {
  it('listens independently from the authenticated application process', async () => {
    const server = await createRendererServer({
      host: '127.0.0.1',
      port: 0,
      appOrigin: 'https://shelf.example',
      resolver: {
        async resolveHtml() {
          return { status: 'unavailable' };
        },
      },
    });
    try {
      const address = await server.start();
      const response = await fetch(address);

      expect(new URL(address).origin).not.toBe('https://shelf.example');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'");
      expect(response.headers.get('set-cookie')).toBeNull();
    } finally {
      await server.close();
    }
  });
});
