import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/api.js', async (original) => ({
  ...(await original<typeof import('../src/api.js')>()),
  resolveViewerShare: vi.fn(),
  prepareViewerRendererConfig: vi.fn(() => async () => ({})),
}));
vi.mock('../src/rendering.js', async (original) => ({
  ...(await original<typeof import('../src/rendering.js')>()),
  prefetchRendererModules: vi.fn(),
}));

import { resolveViewerShare } from '../src/api.js';
import { consumeShareBoot, startShareBoot } from '../src/share-boot.js';
import { viewerLoader } from '../src/viewer-loader.js';

const url = new URL('https://shelf.test/s/AbCdEf0123_-');
const resolution = {
  apiVersion: 'v1',
  shareId: `shr_${'a'.repeat(22)}`,
  accessType: 'public',
  publicCode: 'AbCdEf0123_-',
  target: { mode: 'latest' },
  expiresAt: null,
  artifact: { artifactId: `art_${'b'.repeat(22)}`, kind: 'file', name: 'file' },
  revision: {
    revisionId: `rev_${'c'.repeat(22)}`,
    revisionNumber: 1,
    createdAt: '2026-08-18T12:00:00.000Z',
    kind: 'file',
    mediaType: 'application/octet-stream',
    originalFileName: 'file.bin',
    byteCount: 100,
    contentHash: `sha256:${'a'.repeat(64)}`,
  },
  action: { type: 'content', path: '/api/v1/public/links/AbCdEf0123_-/content' },
} as const;
const resolve = vi.mocked(resolveViewerShare);
function load() {
  return viewerLoader({
    params: { shareRef: 'AbCdEf0123_-' },
    request: new Request(url),
    context: {},
  } as never);
}
afterEach(async () => {
  await consumeShareBoot(url, new AbortController().signal);
  vi.clearAllMocks();
});
describe('share boot adoption', () => {
  it('joins the in-flight resolution once without a duplicate request', async () => {
    let complete!: (value: typeof resolution) => void;
    resolve.mockImplementationOnce(
      () =>
        new Promise((done) => {
          complete = done;
        }),
    );
    startShareBoot(url);
    const payload = load();
    expect(resolve).toHaveBeenCalledTimes(1);
    complete(resolution);
    expect((await payload).resolution).toEqual(resolution);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(await consumeShareBoot(url, new AbortController().signal)).toBeUndefined();
  });
  it('uses the normal path without boot work', async () => {
    resolve.mockResolvedValueOnce(resolution);
    expect((await load()).resolution).toEqual(resolution);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  it('falls back through the normal loader when boot fails', async () => {
    resolve.mockRejectedValueOnce(new Error('boot failed')).mockResolvedValueOnce(resolution);
    startShareBoot(url);
    expect((await load()).resolution).toEqual(resolution);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
  it('does not adopt a different revision', async () => {
    resolve.mockResolvedValueOnce(resolution);
    startShareBoot(url);
    expect(
      await consumeShareBoot(new URL(`${url}?revision=rev_other`), new AbortController().signal),
    ).toBeUndefined();
  });
});
