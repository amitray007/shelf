import { type Static, Type } from 'typebox';
import { Check } from 'typebox/value';

import {
  OpaqueArtifactIdSchema,
  OpaqueRevisionIdSchema,
  PUBLISH_OPERATION,
  PUBLISHER_METADATA_LIMITS,
} from './publish.js';

const IsoInstantSchema = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
});

const CursorSchema = Type.Union([Type.String({ minLength: 1, maxLength: 2048 }), Type.Null()]);

export const ArtifactNameSchema = Type.String({
  minLength: 1,
  maxLength: 255,
  pattern: '^(?!\\s*$)[^\\u0000-\\u001F\\u007F]+$',
});

export const RESTORE_OPERATION = 'revision.restore' as const;

export const DirectPublishProvenanceSchema = Type.Object(
  {
    classification: Type.Literal('direct-publish'),
    observed: Type.Object(
      {
        actorId: Type.String({ minLength: 1, maxLength: 128 }),
        operation: Type.Literal(PUBLISH_OPERATION),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const RestoreProvenanceSchema = Type.Object(
  {
    classification: Type.Literal('restore'),
    observed: Type.Object(
      {
        actorId: Type.String({ minLength: 1, maxLength: 128 }),
        operation: Type.Literal(RESTORE_OPERATION),
      },
      { additionalProperties: false },
    ),
    source: Type.Object({ revisionId: OpaqueRevisionIdSchema }, { additionalProperties: false }),
  },
  { additionalProperties: false },
);

export const RevisionProvenanceSchema = Type.Union([
  DirectPublishProvenanceSchema,
  RestoreProvenanceSchema,
]);

export const ArtifactRevisionSchema = Type.Object(
  {
    revisionId: OpaqueRevisionIdSchema,
    revisionNumber: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    originalFileName: Type.String({ minLength: 1, maxLength: 255 }),
    mediaType: Type.String({ minLength: 1, maxLength: 255 }),
    contentHash: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
    byteCount: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    createdAt: IsoInstantSchema,
    provenance: RevisionProvenanceSchema,
    publisherMetadata: Type.Record(
      Type.String({ minLength: 1, maxLength: PUBLISHER_METADATA_LIMITS.maxKeyLength }),
      Type.String({ maxLength: PUBLISHER_METADATA_LIMITS.maxValueLength }),
      {
        maxProperties: PUBLISHER_METADATA_LIMITS.maxKeys,
      },
    ),
    paths: Type.Object(
      {
        revision: Type.String({ pattern: '^/api/v1/revisions/[^/]+$' }),
        content: Type.String({ pattern: '^/api/v1/revisions/[^/]+/content$' }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'ArtifactRevision' },
);

export const ArtifactSchema = Type.Object(
  {
    apiVersion: Type.Literal('v1'),
    workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
    artifactId: OpaqueArtifactIdSchema,
    name: ArtifactNameSchema,
    createdAt: IsoInstantSchema,
    updatedAt: IsoInstantSchema,
    latestRevision: ArtifactRevisionSchema,
    paths: Type.Object(
      {
        artifact: Type.String({ pattern: '^/api/v1/artifacts/[^/]+$' }),
        revisions: Type.String({ pattern: '^/api/v1/artifacts/[^/]+/revisions$' }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'Artifact' },
);

export const ArtifactPageSchema = Type.Object(
  {
    apiVersion: Type.Literal('v1'),
    items: Type.Array(ArtifactSchema, { maxItems: 100 }),
    nextCursor: CursorSchema,
  },
  { additionalProperties: false, $id: 'ArtifactPage' },
);

export const ArtifactRevisionPageSchema = Type.Object(
  {
    apiVersion: Type.Literal('v1'),
    artifactId: OpaqueArtifactIdSchema,
    workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
    items: Type.Array(ArtifactRevisionSchema, { maxItems: 100 }),
    nextCursor: CursorSchema,
  },
  { additionalProperties: false, $id: 'ArtifactRevisionPage' },
);

export const RestoreResultSchema = Type.Object(
  {
    apiVersion: Type.Literal('v1'),
    workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
    artifactId: OpaqueArtifactIdSchema,
    revisionId: OpaqueRevisionIdSchema,
    revisionNumber: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    sourceRevisionId: OpaqueRevisionIdSchema,
    contentHash: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
    byteCount: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    provenance: RestoreProvenanceSchema,
    requestId: Type.String({ minLength: 1, maxLength: 128 }),
    paths: Type.Object(
      {
        artifact: Type.String({ pattern: '^/api/v1/artifacts/[^/]+$' }),
        revision: Type.String({ pattern: '^/api/v1/revisions/[^/]+$' }),
        content: Type.String({ pattern: '^/api/v1/revisions/[^/]+/content$' }),
      },
      { additionalProperties: false },
    ),
    replayed: Type.Boolean(),
  },
  { additionalProperties: false, $id: 'RestoreResult' },
);

export type ArtifactRevision = Static<typeof ArtifactRevisionSchema>;
export type Artifact = Static<typeof ArtifactSchema>;
export type ArtifactPage = Static<typeof ArtifactPageSchema>;
export type ArtifactRevisionPage = Static<typeof ArtifactRevisionPageSchema>;
export type RestoreResult = Static<typeof RestoreResultSchema>;

export function isArtifact(value: unknown): value is Artifact {
  return Check(ArtifactSchema, value);
}

export function isArtifactPage(value: unknown): value is ArtifactPage {
  return Check(ArtifactPageSchema, value);
}

export function isArtifactRevisionPage(value: unknown): value is ArtifactRevisionPage {
  return Check(ArtifactRevisionPageSchema, value);
}

export function isRestoreResult(value: unknown): value is RestoreResult {
  return Check(RestoreResultSchema, value);
}
