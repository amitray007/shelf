import { type Static, Type } from 'typebox';
import { Check } from 'typebox/value';

import { DashboardCredentialActionSchema } from './dashboard.js';

export const WORKSPACE_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$';

export const WorkspaceIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: WORKSPACE_ID_PATTERN,
});

export const WorkspaceCreateRequestSchema = Type.Object(
  {
    workspaceId: WorkspaceIdSchema,
  },
  { additionalProperties: false },
);

export const WorkspaceCreateResultSchema = Type.Object(
  {
    apiVersion: Type.Literal('v1'),
    workspaceId: WorkspaceIdSchema,
    actions: Type.Array(DashboardCredentialActionSchema, {
      minItems: 2,
      maxItems: 2,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false, $id: 'WorkspaceCreateResult' },
);

export type WorkspaceCreateRequest = Static<typeof WorkspaceCreateRequestSchema>;
export type WorkspaceCreateResult = Static<typeof WorkspaceCreateResultSchema>;

export function isWorkspaceId(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && new RegExp(WORKSPACE_ID_PATTERN).test(value);
}

export function isWorkspaceCreateResult(value: unknown): value is WorkspaceCreateResult {
  return Check(WorkspaceCreateResultSchema, value);
}
