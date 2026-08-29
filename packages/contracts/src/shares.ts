import { type Static, Type } from 'typebox';
import { Check } from 'typebox/value';

import { OpaqueArtifactIdSchema, OpaqueRevisionIdSchema } from './publish.js';

export const COMMENT_POLICIES = ['off', 'private', 'shared'] as const;
export const CommentPolicySchema = Type.Union(
  [Type.Literal('off'), Type.Literal('private'), Type.Literal('shared')],
  { $id: 'CommentPolicy' },
);

export const SHARE_CREATE_OPERATION = 'share.create' as const;

export const REVISION_ACCESS_MODES = ['target-only', 'shared-history'] as const;
export const RevisionAccessSchema = Type.Union(
  [Type.Literal('target-only'), Type.Literal('shared-history')],
  { $id: 'RevisionAccess' },
);

export const SHARE_EXPIRY_PRESETS = [
  '5m',
  '30m',
  '2hr',
  '6hr',
  '24hr',
  '3d',
  '7d',
  '15d',
  '30d',
] as const;

export const SHARE_EXPIRY_DURATION_MS = {
  '5m': 5 * 60 * 1_000,
  '30m': 30 * 60 * 1_000,
  '2hr': 2 * 60 * 60 * 1_000,
  '6hr': 6 * 60 * 60 * 1_000,
  '24hr': 24 * 60 * 60 * 1_000,
  '3d': 3 * 24 * 60 * 60 * 1_000,
  '7d': 7 * 24 * 60 * 60 * 1_000,
  '15d': 15 * 24 * 60 * 60 * 1_000,
  '30d': 30 * 24 * 60 * 60 * 1_000,
} as const;

export const PROTECTED_SHARE_EXPIRY_OPTIONS = ['never', ...SHARE_EXPIRY_PRESETS, 'custom'] as const;
export const PUBLIC_SHARE_EXPIRY_OPTIONS = PROTECTED_SHARE_EXPIRY_OPTIONS;

export const SHARE_SESSION_LIMITS = {
  minimum: 1,
  maximum: 1_000_000,
} as const;

export const OpaqueShareIdSchema = Type.String({
  pattern: '^shr_[A-Za-z0-9_-]{22}$',
});

const IsoInstantSchema = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
});
const NullableIsoInstantSchema = Type.Union([IsoInstantSchema, Type.Null()]);
const CursorSchema = Type.Union([Type.String({ minLength: 1, maxLength: 2048 }), Type.Null()]);
const ShareSessionLimitSchema = Type.Integer(SHARE_SESSION_LIMITS);
const SessionsUsedSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const SessionsRemainingSchema = Type.Integer({ minimum: 0, maximum: SHARE_SESSION_LIMITS.maximum });

export const ShareExpiryPresetSchema = Type.Union([
  Type.Literal('5m'),
  Type.Literal('30m'),
  Type.Literal('2hr'),
  Type.Literal('6hr'),
  Type.Literal('24hr'),
  Type.Literal('3d'),
  Type.Literal('7d'),
  Type.Literal('15d'),
  Type.Literal('30d'),
]);

export const ShareExpiryPresetWithNeverSchema = Type.Union([
  Type.Literal('never'),
  ShareExpiryPresetSchema,
]);
export const ProtectedShareExpiryPresetSchema = ShareExpiryPresetWithNeverSchema;

export const ShareLifecycleStatusSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('session-limit-reached'),
  Type.Literal('expired'),
  Type.Literal('revoked'),
]);

export const PublicShareCodeSchema = Type.String({ pattern: '^[A-Za-z0-9_-]{12}$' });

const ViewerSessionIdSchema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const ViewerSessionTokenSchema = Type.String({
  minLength: 24,
  maxLength: 4096,
  pattern: '^[A-Za-z0-9._-]+$',
});
const ShareCapabilitySecretSchema = Type.String({
  minLength: 32,
  maxLength: 128,
  pattern: '^[A-Za-z0-9_-]+$',
});

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

const ProtectedPolicyFields = {
  accessType: Type.Literal('protected'),
  maxSessions: Type.Optional(ShareSessionLimitSchema),
};
const PublicPolicyFields = { accessType: Type.Literal('public') };

export const ProtectedShareAccessPolicyInputSchema = Type.Union([
  Type.Object(ProtectedPolicyFields, { additionalProperties: false }),
  Type.Object(
    { ...ProtectedPolicyFields, expiresIn: ShareExpiryPresetWithNeverSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...ProtectedPolicyFields, expiresAt: IsoInstantSchema },
    { additionalProperties: false },
  ),
]);

export const PublicShareAccessPolicyInputSchema = Type.Union([
  Type.Object(PublicPolicyFields, { additionalProperties: false }),
  Type.Object(
    { ...PublicPolicyFields, expiresIn: ShareExpiryPresetWithNeverSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...PublicPolicyFields, expiresAt: IsoInstantSchema },
    { additionalProperties: false },
  ),
]);

export const ShareAccessPolicyInputSchema = Type.Union([
  ProtectedShareAccessPolicyInputSchema,
  PublicShareAccessPolicyInputSchema,
]);

const CommentPolicyInputField = { commentPolicy: Type.Optional(CommentPolicySchema) };
const RevisionAccessInputField = { revisionAccess: Type.Optional(RevisionAccessSchema) };
const ProtectedCreateFields = {
  ...ProtectedPolicyFields,
  ...CommentPolicyInputField,
  ...RevisionAccessInputField,
  target: ShareTargetSchema,
};
const PublicCreateFields = {
  ...PublicPolicyFields,
  ...CommentPolicyInputField,
  ...RevisionAccessInputField,
  target: ShareTargetSchema,
};

export const ShareCreateInputSchema = Type.Union(
  [
    Type.Object(ProtectedCreateFields, { additionalProperties: false }),
    Type.Object(
      { ...ProtectedCreateFields, expiresIn: ShareExpiryPresetWithNeverSchema },
      { additionalProperties: false },
    ),
    Type.Object(
      { ...ProtectedCreateFields, expiresAt: IsoInstantSchema },
      { additionalProperties: false },
    ),
    Type.Object(PublicCreateFields, { additionalProperties: false }),
    Type.Object(
      { ...PublicCreateFields, expiresIn: ShareExpiryPresetWithNeverSchema },
      { additionalProperties: false },
    ),
    Type.Object(
      { ...PublicCreateFields, expiresAt: IsoInstantSchema },
      { additionalProperties: false },
    ),
  ],
  { $id: 'ShareCreateInput' },
);

const ShareManagementFields = {
  apiVersion: Type.Literal('v1'),
  workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
  shareId: OpaqueShareIdSchema,
  artifactId: OpaqueArtifactIdSchema,
  visibility: Type.Literal('unlisted'),
  createdAt: IsoInstantSchema,
  revokedAt: NullableIsoInstantSchema,
  status: ShareLifecycleStatusSchema,
  commentPolicy: Type.Optional(CommentPolicySchema),
  revisionAccess: Type.Optional(RevisionAccessSchema),
};

export const ProtectedShareUrlSchema = Type.String({
  pattern: '^/s/shr_[A-Za-z0-9_-]{22}#[A-Za-z0-9_-]{32,128}$',
});
export const PublicShareUrlSchema = Type.String({ pattern: '^/s/[A-Za-z0-9_-]{12}$' });

const ShareManagementTargetSchema = Type.Union([
  LatestShareTargetSchema,
  Type.Object(
    {
      mode: Type.Literal('pinned'),
      revisionId: OpaqueRevisionIdSchema,
      revisionNumber: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    },
    { additionalProperties: false },
  ),
]);

const ProtectedLimitedUsageFields = {
  accessType: Type.Literal('protected'),
  maxSessions: ShareSessionLimitSchema,
  sessionsUsed: SessionsUsedSchema,
  sessionsRemaining: SessionsRemainingSchema,
};
const ProtectedUnlimitedUsageFields = {
  accessType: Type.Literal('protected'),
  maxSessions: Type.Null(),
  sessionsUsed: SessionsUsedSchema,
  sessionsRemaining: Type.Null(),
};
const PublicAccessFields = {
  accessType: Type.Literal('public'),
  publicCode: PublicShareCodeSchema,
};

const publicManagementFields = {
  ...ShareManagementFields,
  ...PublicAccessFields,
  target: ShareManagementTargetSchema,
  expiresAt: NullableIsoInstantSchema,
  url: PublicShareUrlSchema,
};

export const ProtectedShareManagementSummarySchema = Type.Union([
  Type.Object(
    {
      ...ShareManagementFields,
      ...ProtectedLimitedUsageFields,
      target: ShareManagementTargetSchema,
      expiresAt: NullableIsoInstantSchema,
      url: ProtectedShareUrlSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ShareManagementFields,
      ...ProtectedUnlimitedUsageFields,
      target: ShareManagementTargetSchema,
      expiresAt: NullableIsoInstantSchema,
      url: ProtectedShareUrlSchema,
    },
    { additionalProperties: false },
  ),
]);
export const PublicShareManagementSummarySchema = Type.Object(publicManagementFields, {
  additionalProperties: false,
});
export const ShareManagementSummarySchema = Type.Union(
  [ProtectedShareManagementSummarySchema, PublicShareManagementSummarySchema],
  { $id: 'ShareManagementSummary' },
);

export const ArtifactDefaultSharesSchema = Type.Object(
  {
    apiVersion: Type.Literal('v1'),
    workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
    artifactId: OpaqueArtifactIdSchema,
    protected: ProtectedShareManagementSummarySchema,
    public: PublicShareManagementSummarySchema,
  },
  { additionalProperties: false, $id: 'ArtifactDefaultShares' },
);

const ShareCreateResultFields = {
  requestId: Type.String({ minLength: 1, maxLength: 128 }),
  replayed: Type.Boolean(),
};

export const ProtectedShareCreateResultSchema = Type.Union([
  Type.Object(
    {
      ...ShareManagementFields,
      ...ProtectedLimitedUsageFields,
      ...ShareCreateResultFields,
      target: ShareTargetSchema,
      expiresAt: NullableIsoInstantSchema,
      url: ProtectedShareUrlSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ShareManagementFields,
      ...ProtectedUnlimitedUsageFields,
      ...ShareCreateResultFields,
      target: ShareTargetSchema,
      expiresAt: NullableIsoInstantSchema,
      url: ProtectedShareUrlSchema,
    },
    { additionalProperties: false },
  ),
]);
export const PublicShareCreateResultSchema = Type.Object(
  {
    ...ShareManagementFields,
    ...PublicAccessFields,
    ...ShareCreateResultFields,
    target: ShareTargetSchema,
    expiresAt: NullableIsoInstantSchema,
    url: PublicShareUrlSchema,
  },
  { additionalProperties: false },
);
export const ShareCreateResultSchema = Type.Union(
  [ProtectedShareCreateResultSchema, PublicShareCreateResultSchema],
  { $id: 'ShareCreateResult' },
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

const PublicRevisionPointerSchema = Type.Object(PublicRevisionFields, {
  additionalProperties: false,
});

const PublicRevisionNavigationSchema = Type.Object(
  {
    revisions: Type.Array(PublicRevisionPointerSchema, { minItems: 1, maxItems: 100 }),
    previous: Type.Union([PublicRevisionPointerSchema, Type.Null()]),
    next: Type.Union([PublicRevisionPointerSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

const PublicShareFields = {
  apiVersion: Type.Literal('v1'),
  shareId: OpaqueShareIdSchema,
  target: ShareTargetSchema,
  expiresAt: NullableIsoInstantSchema,
  revisionAccess: Type.Optional(RevisionAccessSchema),
  latestRevision: Type.Optional(PublicRevisionPointerSchema),
  navigation: Type.Optional(PublicRevisionNavigationSchema),
};

const ProtectedResolutionFields = {
  ...PublicShareFields,
  accessType: Type.Literal('protected'),
  commentPolicy: Type.Optional(CommentPolicySchema),
};

const PublicResolutionFields = {
  ...PublicShareFields,
  accessType: Type.Literal('public'),
  publicCode: PublicShareCodeSchema,
  expiresAt: NullableIsoInstantSchema,
  commentPolicy: Type.Optional(CommentPolicySchema),
};

const FileArtifactSchema = Type.Object(
  { ...PublicArtifactFields, kind: Type.Literal('file') },
  { additionalProperties: false },
);
const FileRevisionSchema = Type.Object(
  {
    ...PublicRevisionFields,
    kind: Type.Literal('file'),
    originalFileName: Type.String({ minLength: 1, maxLength: 255 }),
    mediaType: Type.String({ minLength: 1, maxLength: 255 }),
    byteCount: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);
const FolderArtifactSchema = Type.Object(
  { ...PublicArtifactFields, kind: Type.Literal('folder') },
  { additionalProperties: false },
);
const FolderRevisionSchema = Type.Object(
  {
    ...PublicRevisionFields,
    kind: Type.Literal('folder'),
    rootName: Type.String({ minLength: 1, maxLength: 255 }),
    byteCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    fileCount: Type.Integer({ minimum: 0, maximum: 1_000 }),
  },
  { additionalProperties: false },
);

function resolutionAction(type: 'content' | 'tree', pathPattern: string) {
  return Type.Object(
    { type: Type.Literal(type), path: Type.String({ pattern: pathPattern }) },
    { additionalProperties: false },
  );
}

export const PublicFileShareResolutionSchema = Type.Union([
  Type.Object(
    {
      ...ProtectedResolutionFields,
      artifact: FileArtifactSchema,
      revision: FileRevisionSchema,
      action: resolutionAction('content', '^/api/v1/public/shares/shr_[A-Za-z0-9_-]{22}/content$'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...PublicResolutionFields,
      artifact: FileArtifactSchema,
      revision: FileRevisionSchema,
      action: resolutionAction('content', '^/api/v1/public/links/[A-Za-z0-9_-]{12}/content$'),
    },
    { additionalProperties: false },
  ),
]);

export const PublicFolderShareResolutionSchema = Type.Union([
  Type.Object(
    {
      ...ProtectedResolutionFields,
      artifact: FolderArtifactSchema,
      revision: FolderRevisionSchema,
      action: resolutionAction('tree', '^/api/v1/public/shares/shr_[A-Za-z0-9_-]{22}/tree$'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...PublicResolutionFields,
      artifact: FolderArtifactSchema,
      revision: FolderRevisionSchema,
      action: resolutionAction('tree', '^/api/v1/public/links/[A-Za-z0-9_-]{12}/tree$'),
    },
    { additionalProperties: false },
  ),
]);

export const PublicShareResolutionSchema = Type.Union(
  [PublicFileShareResolutionSchema, PublicFolderShareResolutionSchema],
  { $id: 'PublicShareResolution' },
);

export const ProtectedSessionEstablishInputSchema = Type.Union(
  [
    Type.Object(
      { sessionId: ViewerSessionIdSchema, secret: ShareCapabilitySecretSchema },
      { additionalProperties: false },
    ),
    Type.Object(
      { sessionId: ViewerSessionIdSchema, token: ViewerSessionTokenSchema },
      { additionalProperties: false },
    ),
  ],
  { $id: 'ProtectedSessionEstablishInput' },
);

export const ProtectedSessionAuthoritySchema = Type.Object(
  {
    apiVersion: Type.Literal('v1'),
    shareId: OpaqueShareIdSchema,
    sessionId: ViewerSessionIdSchema,
    token: ViewerSessionTokenSchema,
    issuedAt: IsoInstantSchema,
    expiresAt: IsoInstantSchema,
  },
  { additionalProperties: false, $id: 'ProtectedSessionAuthority' },
);

export type ShareTarget = Static<typeof ShareTargetSchema>;
export type CommentPolicy = Static<typeof CommentPolicySchema>;
export type RevisionAccess = Static<typeof RevisionAccessSchema>;
export type ShareExpiryPreset = Static<typeof ShareExpiryPresetSchema>;
export type ShareExpiryPresetWithNever = Static<typeof ShareExpiryPresetWithNeverSchema>;
export type ProtectedShareExpiryPreset = ShareExpiryPresetWithNever;
export type ShareLifecycleStatus = Static<typeof ShareLifecycleStatusSchema>;
export type ShareAccessPolicyInput = Static<typeof ShareAccessPolicyInputSchema>;
export type ShareCreateInput = Static<typeof ShareCreateInputSchema>;
export type ShareManagementSummary = Static<typeof ShareManagementSummarySchema>;
export type ArtifactDefaultShares = Static<typeof ArtifactDefaultSharesSchema>;
export type ShareCreateResult = Static<typeof ShareCreateResultSchema>;
export type SharePage = Static<typeof SharePageSchema>;
export type PublicShareResolution = Static<typeof PublicShareResolutionSchema>;
export type ProtectedSessionEstablishInput = Static<typeof ProtectedSessionEstablishInputSchema>;
export type ProtectedSessionAuthority = Static<typeof ProtectedSessionAuthoritySchema>;

export function isShareCreateInput(value: unknown): value is ShareCreateInput {
  return Check(ShareCreateInputSchema, value);
}

export function isShareCreateResult(value: unknown): value is ShareCreateResult {
  return Check(ShareCreateResultSchema, value);
}

export function isArtifactDefaultShares(value: unknown): value is ArtifactDefaultShares {
  return Check(ArtifactDefaultSharesSchema, value);
}

export function isSharePage(value: unknown): value is SharePage {
  return Check(SharePageSchema, value);
}

export function isPublicShareResolution(value: unknown): value is PublicShareResolution {
  return Check(PublicShareResolutionSchema, value);
}

export function isProtectedSessionAuthority(value: unknown): value is ProtectedSessionAuthority {
  return Check(ProtectedSessionAuthoritySchema, value);
}
