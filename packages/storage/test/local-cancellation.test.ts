import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { LocalContentStorage } from '../src/index.js';

it('owns cancellation errors before the response starts consuming storage bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shelf-cancel-'));
  try {
    const storage = new LocalContentStorage({ root });
    const bytes = Buffer.from('healthy after cancellation');
    const staged = await storage.stage(
      (async function* () {
        yield bytes;
      })(),
      {},
    );
    const sealed = await storage.seal(staged, {
      byteCount: bytes.length,
      contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    });
    const controller = new AbortController();
    const stream = await storage.read(sealed, { signal: controller.signal });
    controller.abort();
    await setImmediate();
    await setImmediate();
    await expect(
      (async () => {
        for await (const _chunk of stream) {
          /* consume */
        }
      })(),
    ).rejects.toMatchObject({ code: 'ABORT_ERR' });
    const chunks = [];
    for await (const chunk of await storage.read(sealed, {})) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
