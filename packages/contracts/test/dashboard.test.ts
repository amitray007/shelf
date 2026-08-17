import {
  isDashboardCredentialIssue,
  isDashboardCredentialPage,
  isDashboardSession,
} from '@shelf/contracts';
import { describe, expect, it } from 'vitest';

const grant = { workspaceId: 'workspace-main', action: 'revision.read' } as const;

describe('dashboard contracts', () => {
  it('accepts a human dashboard session with grouped workspace grants', () => {
    expect(
      isDashboardSession({
        apiVersion: 'v1',
        actorId: 'act_owner',
        workspaces: [{ workspaceId: 'workspace-main', actions: ['file.publish', 'revision.read'] }],
      }),
    ).toBe(true);
    expect(
      isDashboardSession({
        apiVersion: 'v1',
        actorId: 'act_owner',
        workspaces: [{ workspaceId: 'workspace-main', actions: ['workspace.admin'] }],
      }),
    ).toBe(false);
  });

  it('keeps credential listings free of raw token material', () => {
    const summary = {
      credentialId: 'crd_1234567890123456789012',
      actorId: 'act_1234567890123456789012',
      actorName: 'release-agent',
      createdAt: '2026-08-18T00:00:00.000Z',
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      grants: [grant],
    };
    expect(
      isDashboardCredentialPage({
        apiVersion: 'v1',
        items: [summary],
        nextCursor: null,
      }),
    ).toBe(true);
    expect(
      isDashboardCredentialPage({
        apiVersion: 'v1',
        items: [{ ...summary, token: 'shf_v1.secret' }],
        nextCursor: null,
      }),
    ).toBe(false);
  });

  it('reveals an issued token only in the issuance result', () => {
    expect(
      isDashboardCredentialIssue({
        apiVersion: 'v1',
        credentialId: 'crd_1234567890123456789012',
        actorId: 'act_1234567890123456789012',
        actorName: 'release-agent',
        token: `shf_v1.${'a'.repeat(22)}.${'b'.repeat(43)}`,
        expiresAt: null,
        grants: [grant],
      }),
    ).toBe(true);
    expect(
      isDashboardCredentialIssue({
        apiVersion: 'v1',
        credentialId: 'crd_1234567890123456789012',
        actorId: 'act_1234567890123456789012',
        actorName: 'release-agent',
        token: 'plaintext',
        expiresAt: null,
        grants: [grant],
      }),
    ).toBe(false);
  });
});
