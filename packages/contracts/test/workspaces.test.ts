import { describe, expect, it } from 'vitest';

import { isWorkspaceCreateResult, isWorkspaceId } from '../src/workspaces.js';

describe('workspace contracts', () => {
  it('accepts durable caller-chosen workspace identifiers', () => {
    expect(isWorkspaceId('workspace-main')).toBe(true);
    expect(isWorkspaceId('workspace.work_1')).toBe(true);
    expect(isWorkspaceId('a')).toBe(true);
    expect(isWorkspaceId(' workspace-main')).toBe(false);
    expect(isWorkspaceId('workspace/main')).toBe(false);
    expect(isWorkspaceId('-work')).toBe(false);
    expect(isWorkspaceId('')).toBe(false);
  });

  it('returns the owner grants created with a workspace', () => {
    expect(
      isWorkspaceCreateResult({
        apiVersion: 'v1',
        workspaceId: 'workspace-work',
        actions: ['file.publish', 'revision.read'],
      }),
    ).toBe(true);
    expect(
      isWorkspaceCreateResult({
        apiVersion: 'v1',
        workspaceId: 'workspace-work',
        actions: ['revision.read'],
      }),
    ).toBe(false);
  });
});
