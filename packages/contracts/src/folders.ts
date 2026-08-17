import { type Static, Type } from 'typebox';
import { Check } from 'typebox/value';

import { DirectPublishProvenanceSchema } from './artifacts.js';
import {
  OpaqueArtifactIdSchema,
  OpaqueRevisionIdSchema,
  PublisherMetadataSchema,
} from './publish.js';

export const FOLDER_MANIFEST_VERSION = 'shelf-folder-manifest/v1' as const;

export const FOLDER_LIMITS = Object.freeze({
  maxFiles: 1_000,
  maxEntries: 2_000,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxManifestBytes: 2 * 1024 * 1024,
  maxPathBytes: 1_024,
  maxSegmentBytes: 255,
  maxDepth: 64,
  treePageSize: 100,
});

export const PortableFolderPathSchema = Type.String({
  minLength: 1,
  maxLength: FOLDER_LIMITS.maxPathBytes,
  pattern:
    '^(?!/)(?!.*\\\\)(?!.*(?:^|/)(?:\\.|\\.\\.)(?:/|$))(?!.*//)(?!.*[\\u0000-\\u001F\\u007F])[^/]+(?:/[^/]+)*$',
});

export const FolderManifestDirectoryInputSchema = Type.Object(
  {
    path: PortableFolderPathSchema,
    kind: Type.Literal('directory'),
  },
  { additionalProperties: false },
);

export const FolderManifestFileInputSchema = Type.Object(
  {
    path: PortableFolderPathSchema,
    kind: Type.Literal('file'),
    mediaType: Type.String({ minLength: 1, maxLength: 255 }),
  },
  { additionalProperties: false },
);

export const FolderManifestInputSchema = Type.Object(
  {
    version: Type.Literal(FOLDER_MANIFEST_VERSION),
    rootName: Type.String({ minLength: 1, maxLength: 255 }),
    entries: Type.Array(
      Type.Union([FolderManifestDirectoryInputSchema, FolderManifestFileInputSchema]),
      { maxItems: FOLDER_LIMITS.maxEntries },
    ),
  },
  { additionalProperties: false },
);

export const FolderDirectoryEntrySchema = Type.Object(
  {
    path: PortableFolderPathSchema,
    kind: Type.Literal('directory'),
  },
  { additionalProperties: false },
);

export const FolderFileEntrySchema = Type.Object(
  {
    path: PortableFolderPathSchema,
    kind: Type.Literal('file'),
    mediaType: Type.String({ minLength: 1, maxLength: 255 }),
    contentHash: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
    byteCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);

export const FolderEntrySchema = Type.Union([FolderDirectoryEntrySchema, FolderFileEntrySchema]);

export const FolderPublishResultSchema = Type.Object(
  {
    apiVersion: Type.Literal('v1'),
    kind: Type.Literal('folder'),
    workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
    artifactId: OpaqueArtifactIdSchema,
    revisionId: OpaqueRevisionIdSchema,
    contentHash: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
    byteCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    fileCount: Type.Integer({ minimum: 0, maximum: FOLDER_LIMITS.maxFiles }),
    provenance: DirectPublishProvenanceSchema,
    publisherMetadata: PublisherMetadataSchema,
    requestId: Type.String({ minLength: 1, maxLength: 128 }),
    paths: Type.Object(
      {
        artifact: Type.String({ pattern: '^/api/v1/artifacts/[^/]+$' }),
        revision: Type.String({ pattern: '^/api/v1/revisions/[^/]+$' }),
        tree: Type.String({ pattern: '^/api/v1/revisions/[^/]+/tree$' }),
      },
      { additionalProperties: false },
    ),
    replayed: Type.Boolean(),
  },
  { additionalProperties: false, $id: 'FolderPublishResult' },
);

const CursorSchema = Type.Union([Type.String({ minLength: 1, maxLength: 2048 }), Type.Null()]);

export const FolderTreePageSchema = Type.Object(
  {
    apiVersion: Type.Literal('v1'),
    revisionId: OpaqueRevisionIdSchema,
    contentHash: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
    byteCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    fileCount: Type.Integer({ minimum: 0, maximum: FOLDER_LIMITS.maxFiles }),
    items: Type.Array(FolderEntrySchema, { maxItems: FOLDER_LIMITS.treePageSize }),
    nextCursor: CursorSchema,
  },
  { additionalProperties: false, $id: 'FolderTreePage' },
);

export type FolderManifestInput = Static<typeof FolderManifestInputSchema>;
export type FolderEntry = Static<typeof FolderEntrySchema>;
export type FolderPublishResult = Static<typeof FolderPublishResultSchema>;
export type FolderTreePage = Static<typeof FolderTreePageSchema>;

export function isFolderManifestInput(value: unknown): value is FolderManifestInput {
  return Check(FolderManifestInputSchema, value);
}

export function isFolderPublishResult(value: unknown): value is FolderPublishResult {
  return Check(FolderPublishResultSchema, value);
}

export function isFolderTreePage(value: unknown): value is FolderTreePage {
  return Check(FolderTreePageSchema, value);
}
