import { type Static, Type } from 'typebox';
import { Check } from 'typebox/value';

import { PUBLISH_OPERATION } from './publish.js';
import { READ_REVISION_OPERATION } from './revisions.js';

const IsoInstantSchema = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
});
const NullableIsoInstantSchema = Type.Union([IsoInstantSchema, Type.Null()]);
const CursorSchema = Type.Union([Type.String({ minLength: 1, maxLength: 2048 }), Type.Null()]);

export const DashboardCredentialActionSchema = Type.Union([
  Type.Literal(PUBLISH_OPERATION),
  Type.Literal(READ_REVISION_OPERATION),
]);

export const DashboardWorkspaceSchema = Type.Object(
  {
    workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
    actions: Type.Array(DashboardCredentialActionSchema, {
      minItems: 1,
      maxItems: 2,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);

export const DashboardSessionSchema = Type.Object(
  {
    apiVersion: Type.Literal('v1'),
    actorId: Type.String({ minLength: 1, maxLength: 128 }),
    workspaces: Type.Array(DashboardWorkspaceSchema, { maxItems: 100 }),
  },
  { additionalProperties: false, $id: 'DashboardSession' },
);

export const DashboardCredentialGrantSchema = Type.Object(
  {
    workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
    action: DashboardCredentialActionSchema,
  },
  { additionalProperties: false },
);

export const DashboardCredentialSummarySchema = Type.Object(
  {
    credentialId: Type.String({ pattern: '^crd_[A-Za-z0-9_-]{22}$' }),
    actorId: Type.String({ minLength: 1, maxLength: 128 }),
    actorName: Type.String({ minLength: 1, maxLength: 128 }),
    createdAt: IsoInstantSchema,
    expiresAt: NullableIsoInstantSchema,
    revokedAt: NullableIsoInstantSchema,
    lastUsedAt: NullableIsoInstantSchema,
    grants: Type.Array(DashboardCredentialGrantSchema, { minItems: 1, maxItems: 200 }),
  },
  { additionalProperties: false, $id: 'DashboardCredentialSummary' },
);

export const DashboardCredentialPageSchema = Type.Object(
  {
    apiVersion: Type.Literal('v1'),
    items: Type.Array(DashboardCredentialSummarySchema, { maxItems: 100 }),
    nextCursor: CursorSchema,
  },
  { additionalProperties: false, $id: 'DashboardCredentialPage' },
);

export const DashboardCredentialIssueRequestSchema = Type.Object(
  {
    actorName: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: '^(?!\\s*$)[^\\u0000-\\u001F\\u007F]+$',
    }),
    grants: Type.Array(DashboardCredentialGrantSchema, {
      minItems: 1,
      maxItems: 200,
      uniqueItems: true,
    }),
    expiresAt: Type.Optional(NullableIsoInstantSchema),
  },
  { additionalProperties: false },
);

export const DashboardCredentialIssueSchema = Type.Object(
  {
    apiVersion: Type.Literal('v1'),
    credentialId: Type.String({ pattern: '^crd_[A-Za-z0-9_-]{22}$' }),
    actorId: Type.String({ minLength: 1, maxLength: 128 }),
    actorName: Type.String({ minLength: 1, maxLength: 128 }),
    token: Type.String({ pattern: '^shf_v1\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}$' }),
    expiresAt: NullableIsoInstantSchema,
    grants: Type.Array(DashboardCredentialGrantSchema, { minItems: 1, maxItems: 200 }),
  },
  { additionalProperties: false, $id: 'DashboardCredentialIssue' },
);

export const DashboardCredentialRevokeSchema = Type.Object(
  {
    apiVersion: Type.Literal('v1'),
    credentialId: Type.String({ pattern: '^crd_[A-Za-z0-9_-]{22}$' }),
    revoked: Type.Literal(true),
    alreadyRevoked: Type.Boolean(),
  },
  { additionalProperties: false, $id: 'DashboardCredentialRevoke' },
);

export type DashboardCredentialAction = Static<typeof DashboardCredentialActionSchema>;
export type DashboardWorkspace = Static<typeof DashboardWorkspaceSchema>;
export type DashboardSession = Static<typeof DashboardSessionSchema>;
export type DashboardCredentialGrant = Static<typeof DashboardCredentialGrantSchema>;
export type DashboardCredentialSummary = Static<typeof DashboardCredentialSummarySchema>;
export type DashboardCredentialPage = Static<typeof DashboardCredentialPageSchema>;
export type DashboardCredentialIssueRequest = Static<typeof DashboardCredentialIssueRequestSchema>;
export type DashboardCredentialIssue = Static<typeof DashboardCredentialIssueSchema>;
export type DashboardCredentialRevoke = Static<typeof DashboardCredentialRevokeSchema>;

export function isDashboardSession(value: unknown): value is DashboardSession {
  return Check(DashboardSessionSchema, value);
}

export function isDashboardCredentialPage(value: unknown): value is DashboardCredentialPage {
  return Check(DashboardCredentialPageSchema, value);
}

export function isDashboardCredentialIssue(value: unknown): value is DashboardCredentialIssue {
  return Check(DashboardCredentialIssueSchema, value);
}

export function isDashboardCredentialRevoke(value: unknown): value is DashboardCredentialRevoke {
  return Check(DashboardCredentialRevokeSchema, value);
}
