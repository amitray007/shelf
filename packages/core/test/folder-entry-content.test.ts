import { describe, expect, it, vi } from 'vitest';

import {
  type Authorizer,
  type ContentReader,
  createFolderEntryContentService,
  type FolderRevisionRepository,
  type StoredFolderEntry,
  type StoredFolderRevision,
} from '../src/index.js';

const revision: StoredFolderRevision = {
  apiVersion: 'v1',
  kind: 'folder',
  installationId: 'installation-main',
  workspaceId: 'workspace-main',
  artifactId: 'art_AAAAAAAAAAAAAAAAAAAAAA',
  revisionId: 'rev_AAAAAAAAAAAAAAAAAAAAAA',
  manifest: { contentId: 'manifest', contentHash: `sha256:${'a'.repeat(64)}`, byteCount: 100 },
  rootName: 'project',
  totalByteCount: 5,
  fileCount: 1,
  provenance: {
    classification: 'direct-publish',
    observed: { actorId: 'actor-publisher', operation: 'file.publish' },
  },
  publisherMetadata: {},
};

const file: StoredFolderEntry = {
  path: 'docs/readme.txt',
  kind: 'file',
  mediaType: 'text/plain',
  content: { contentId: 'readme', contentHash: `sha256:${'b'.repeat(64)}`, byteCount: 5 },
};

const request = {
  installationId: revision.installationId,
  actorId: 'actor-reader',
  revisionId: revision.revisionId,
  path: file.path,
};

function fixture(entry: StoredFolderEntry | undefined = file) {
  const authorize = vi.fn<Authorizer['authorize']>(async () => {});
  const findFolderRevision = vi.fn(async (): Promise<StoredFolderRevision | undefined> => revision);
  const findFolderEntry = vi.fn<FolderRevisionRepository['findFolderEntry']>(async () => entry);
  const listFolderEntries = vi.fn(async () => {
    throw new Error('A single file must not enumerate the folder');
  });
  const read = vi.fn<ContentReader['read']>(async () =>
    (async function* () {
      yield new TextEncoder().encode('hello');
    })(),
  );
  return {
    authorize,
    findFolderRevision,
    findFolderEntry,
    listFolderEntries,
    read,
    service: createFolderEntryContentService({
      authorizer: { authorize },
      folders: { findFolderRevision, findFolderEntry, listFolderEntries },
      contentReader: { read },
    }),
  };
}

describe('folder entry content lookup', () => {
  it('authorizes the requested revision before looking up only the exact scoped path', async () => {
    const context = fixture();
    context.findFolderEntry.mockImplementationOnce(async () => {
      expect(context.authorize).toHaveBeenCalledWith(
        {
          installationId: request.installationId,
          workspaceId: revision.workspaceId,
          actorId: request.actorId,
          action: 'revision.read',
        },
        undefined,
      );
      return file;
    });

    const result = await context.service(request);

    expect(result).toMatchObject({ path: file.path, mediaType: 'text/plain', byteCount: 5 });
    expect(context.findFolderEntry).toHaveBeenCalledExactlyOnceWith({
      installationId: request.installationId,
      revisionId: request.revisionId,
      path: request.path,
    });
    expect(context.listFolderEntries).not.toHaveBeenCalled();
    expect(context.read).not.toHaveBeenCalled();
  });

  it('does not query entries when authorization fails', async () => {
    const context = fixture();
    const denied = new Error('denied');
    context.authorize.mockRejectedValueOnce(denied);
    await expect(context.service(request)).rejects.toBe(denied);
    expect(context.findFolderEntry).not.toHaveBeenCalled();
    expect(context.read).not.toHaveBeenCalled();
  });

  it('propagates an entry lookup failure without reading content', async () => {
    const context = fixture();
    const failure = new Error('repository unavailable');
    context.findFolderEntry.mockRejectedValueOnce(failure);
    await expect(context.service(request)).rejects.toBe(failure);
    expect(context.read).not.toHaveBeenCalled();
    expect(context.listFolderEntries).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { ...revision, installationId: 'other-installation' },
    { ...revision, revisionId: 'rev_BBBBBBBBBBBBBBBBBBBBBB' },
  ])('rejects a missing or out-of-scope revision before entry lookup (%#)', async (value) => {
    const context = fixture();
    context.findFolderRevision.mockResolvedValueOnce(value);
    await expect(context.service(request)).rejects.toMatchObject({ code: 'REVISION_NOT_FOUND' });
    expect(context.authorize).not.toHaveBeenCalled();
    expect(context.findFolderEntry).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { path: file.path, kind: 'directory' as const },
    { ...file, path: 'other.txt' },
  ])('rejects a missing, directory, or mismatched entry (%#)', async (entry) => {
    const context = fixture();
    context.findFolderEntry.mockResolvedValueOnce(entry);
    await expect(context.service(request)).rejects.toMatchObject({ code: 'REVISION_NOT_FOUND' });
    expect(context.read).not.toHaveBeenCalled();
  });

  it('keeps content lazy and forwards range and cancellation to the content reader', async () => {
    const context = fixture();
    const controller = new AbortController();
    const result = await context.service({ ...request, signal: controller.signal });
    const range = { start: 1, end: 3 };

    expect(context.read).not.toHaveBeenCalled();
    const stream = await result.read(range);
    expect(context.read).toHaveBeenCalledExactlyOnceWith(file.content, {
      range,
      signal: controller.signal,
    });
    expect(context.authorize.mock.calls[0]?.[1]).toBe(controller.signal);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('hello');
  });
});
