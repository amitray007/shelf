import { type Static, Type } from 'typebox';
import { Check } from 'typebox/value';

export const PUBLISH_CONTRACT_VERSION = 'v1' as const;
export const PUBLISH_OPERATION = 'file.publish' as const;

export const PUBLISHER_METADATA_LIMITS = {
  maxKeys: 32,
  maxKeyLength: 64,
  maxValueLength: 2048,
} as const;

export const PUBLISHER_METADATA_KEYS = {
  title: 'title',
  description: 'description',
} as const;

export const RESERVED_PROVENANCE_KEYS = [
  'actorId',
  'classification',
  'contentHash',
  'observedAt',
  'operation',
  'requestId',
  'workspaceId',
] as const;

export const OpaqueArtifactIdSchema = Type.String({
  pattern: '^art_[A-Za-z0-9_-]{22}$',
  description: 'Opaque artifact identifier containing 128 bits of entropy.',
});

export const OpaqueRevisionIdSchema = Type.String({
  pattern: '^rev_[A-Za-z0-9_-]{22}$',
  description: 'Opaque revision identifier containing 128 bits of entropy.',
});

export const PublisherMetadataSchema = Type.Record(
  Type.String({ minLength: 1, maxLength: PUBLISHER_METADATA_LIMITS.maxKeyLength }),
  Type.String({ maxLength: PUBLISHER_METADATA_LIMITS.maxValueLength }),
  {
    maxProperties: PUBLISHER_METADATA_LIMITS.maxKeys,
    description: 'Untrusted publisher-supplied string metadata.',
  },
);

export const PublishResultSchema = Type.Object(
  {
    apiVersion: Type.Literal(PUBLISH_CONTRACT_VERSION),
    kind: Type.Literal('file'),
    workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
    artifactId: OpaqueArtifactIdSchema,
    revisionId: OpaqueRevisionIdSchema,
    contentHash: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
    byteCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    fileCount: Type.Literal(1),
    provenance: Type.Object(
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
    ),
    publisherMetadata: PublisherMetadataSchema,
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
  { additionalProperties: false, $id: 'PublishResult' },
);

export type PublisherMetadata = Static<typeof PublisherMetadataSchema>;
export type PublishResult = Static<typeof PublishResultSchema>;

export function isPublishResult(value: unknown): value is PublishResult {
  return Check(PublishResultSchema, value);
}
