import { type Static, Type } from 'typebox';
import { Check } from 'typebox/value';

import { DirectPublishProvenanceSchema } from './artifacts.js';
import {
  OpaqueArtifactIdSchema,
  OpaqueRevisionIdSchema,
  PublisherMetadataSchema,
} from './publish.js';

export * from './folder-tree.js';

import {
  FOLDER_LIMITS,
  type FolderEntrySchema,
  FolderManifestInputSchema,
  FolderTreePageSchema,
} from './folder-tree.js';

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
