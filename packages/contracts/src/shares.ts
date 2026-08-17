import { type Static, Type } from 'typebox';
import { Check } from 'typebox/value';

import { OpaqueArtifactIdSchema, OpaqueRevisionIdSchema } from './publish.js';

export const SHARE_CREATE_OPERATION = 'share.create' as const;

export const OpaqueShareIdSchema = Type.String({
  pattern: '^shr_[A-Za-z0-9_-]{22}$',
});

const IsoInstantSchema = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
});
const NullableIsoInstantSchema = Type.Union([IsoInstantSchema, Type.Null()]);
const CursorSchema = Type.Union([Type.String({ minLength: 1, maxLength: 2048 }), Type.Null()]);

export const LatestShareTargetSchema = Type.Object(
  { mode: Type.Literal('latest') },
  { additionalProperties: false },
);

export const PinnedShareTargetSchema = Type.Object(
  {
    mode: Type.Literal('pinned'),
    revisionId: OpaqueRevisionIdSchema,
  },
  { additionalProperties: false },
);

export const ShareTargetSchema = Type.Union([LatestShareTargetSchema, PinnedShareTargetSchema], {
  $id: 'ShareTarget',
});

const ShareManagementFields = {
  apiVersion: Type.Literal('v1'),
  workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
  shareId: OpaqueShareIdSchema,
  artifactId: OpaqueArtifactIdSchema,
  visibility: Type.Literal('unlisted'),
  target: ShareTargetSchema,
  createdAt: IsoInstantSchema,
  expiresAt: NullableIsoInstantSchema,
  revokedAt: NullableIsoInstantSchema,
};

export const ShareManagementSummarySchema = Type.Object(ShareManagementFields, {
  additionalProperties: false,
  $id: 'ShareManagementSummary',
});

export const ShareCreateResultSchema = Type.Object(
  {
    ...ShareManagementFields,
    requestId: Type.String({ minLength: 1, maxLength: 128 }),
    url: Type.String({
      pattern: '^/s/shr_[A-Za-z0-9_-]{22}#[A-Za-z0-9_-]{32,128}$',
    }),
    replayed: Type.Boolean(),
  },
  { additionalProperties: false, $id: 'ShareCreateResult' },
);

export const SharePageSchema = Type.Object(
  {
    apiVersion: Type.Literal('v1'),
    workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
    items: Type.Array(ShareManagementSummarySchema, { maxItems: 100 }),
    nextCursor: CursorSchema,
  },
  { additionalProperties: false, $id: 'SharePage' },
);

const PublicArtifactFields = {
  artifactId: OpaqueArtifactIdSchema,
  name: Type.String({ minLength: 1, maxLength: 255 }),
};

const PublicRevisionFields = {
  revisionId: OpaqueRevisionIdSchema,
  revisionNumber: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  createdAt: IsoInstantSchema,
};

const PublicShareFields = {
  apiVersion: Type.Literal('v1'),
  shareId: OpaqueShareIdSchema,
  target: ShareTargetSchema,
  expiresAt: NullableIsoInstantSchema,
};

export const PublicFileShareResolutionSchema = Type.Object(
  {
    ...PublicShareFields,
    artifact: Type.Object(
      { ...PublicArtifactFields, kind: Type.Literal('file') },
      { additionalProperties: false },
    ),
    revision: Type.Object(
      {
        ...PublicRevisionFields,
        kind: Type.Literal('file'),
        originalFileName: Type.String({ minLength: 1, maxLength: 255 }),
        mediaType: Type.String({ minLength: 1, maxLength: 255 }),
        byteCount: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      },
      { additionalProperties: false },
    ),
    action: Type.Object(
      {
        type: Type.Literal('content'),
        path: Type.String({ pattern: '^/api/v1/public/shares/shr_[A-Za-z0-9_-]{22}/content$' }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const PublicFolderShareResolutionSchema = Type.Object(
  {
    ...PublicShareFields,
    artifact: Type.Object(
      { ...PublicArtifactFields, kind: Type.Literal('folder') },
      { additionalProperties: false },
    ),
    revision: Type.Object(
      {
        ...PublicRevisionFields,
        kind: Type.Literal('folder'),
        rootName: Type.String({ minLength: 1, maxLength: 255 }),
        byteCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        fileCount: Type.Integer({ minimum: 0, maximum: 1_000 }),
      },
      { additionalProperties: false },
    ),
    action: Type.Object(
      {
        type: Type.Literal('tree'),
        path: Type.String({ pattern: '^/api/v1/public/shares/shr_[A-Za-z0-9_-]{22}/tree$' }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const PublicShareResolutionSchema = Type.Union(
  [PublicFileShareResolutionSchema, PublicFolderShareResolutionSchema],
  { $id: 'PublicShareResolution' },
);

export type ShareTarget = Static<typeof ShareTargetSchema>;
export type ShareManagementSummary = Static<typeof ShareManagementSummarySchema>;
export type ShareCreateResult = Static<typeof ShareCreateResultSchema>;
export type SharePage = Static<typeof SharePageSchema>;
export type PublicShareResolution = Static<typeof PublicShareResolutionSchema>;

export function isShareCreateResult(value: unknown): value is ShareCreateResult {
  return Check(ShareCreateResultSchema, value);
}

export function isSharePage(value: unknown): value is SharePage {
  return Check(SharePageSchema, value);
}

export function isPublicShareResolution(value: unknown): value is PublicShareResolution {
  return Check(PublicShareResolutionSchema, value);
}
