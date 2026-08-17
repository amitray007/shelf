import { mkdir, writeFile } from 'node:fs/promises';

import { createShelfApp } from './app.js';

const target = new URL('../openapi/v1.json', import.meta.url);
const app = await createShelfApp({
  stagingRoot: '/tmp/shelf-openapi-generation',
  authenticator: { async authenticate() {} },
  authorizer: { async authorize() {} },
  dashboardAccess: {
    async session() {
      return { actorId: 'actor-openapi', workspaces: [] };
    },
    async list() {
      return { items: [] };
    },
    async issue() {
      throw new Error('OpenAPI fixture does not issue credentials.');
    },
    async revoke() {
      throw new Error('OpenAPI fixture does not revoke credentials.');
    },
  },
});

try {
  await mkdir(new URL('.', target), { recursive: true });
  await writeFile(target, `${JSON.stringify(app.swagger(), null, 2)}\n`, 'utf8');
} finally {
  await app.close();
}
