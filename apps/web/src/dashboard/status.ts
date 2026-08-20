import {
  type CommentPolicy,
  SHARE_EXPIRY_DURATION_MS,
  type ShareCreateInput,
  type ShareExpiryPreset,
  type ShareLifecycleStatus,
} from '@shelf/contracts';
import { useEffect, useState } from 'react';

export type ManagedStatus = 'Active' | 'Session limit reached' | 'Expired' | 'Revoked';
export type ShareExpiryChoice = 'never' | ShareExpiryPreset | 'custom';

export type ResolvedShareExpiry =
  | { expiresIn: 'never' }
  | { expiresIn: ShareExpiryPreset; previewAt: string }
  | { expiresAt: string; previewAt: string }
  | { error: string };

export interface SharePolicyDraft {
  accessType: 'protected' | 'public';
  targetMode: 'latest' | 'pinned';
  revisionId: string;
  expiryChoice: ShareExpiryChoice;
  customExpiresAt: string;
  maxSessions: string;
  readonly commentPolicy?: CommentPolicy;
}

export function defaultSharePolicy() {
  return {
    expiryChoice: 'never' as const,
    customExpiresAt: '',
    maxSessions: '',
  };
}

export function resolveShareExpiry(
  accessType: 'protected' | 'public',
  choice: ShareExpiryChoice,
  customValue: string,
  now = new Date(),
): ResolvedShareExpiry {
  if (choice === 'never') {
    return { expiresIn: 'never' };
  }
  if (choice !== 'custom') {
    return {
      expiresIn: choice,
      previewAt: new Date(now.getTime() + SHARE_EXPIRY_DURATION_MS[choice]).toISOString(),
    };
  }
  if (customValue === '') return { error: 'Choose an expiry.' };
  const expiresAt = new Date(customValue);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
    return { error: 'Choose a future expiry.' };
  }
  if (
    accessType === 'public' &&
    expiresAt.getTime() - now.getTime() > SHARE_EXPIRY_DURATION_MS['30d']
  ) {
    return { error: 'A finite Public link cannot exceed 30 days.' };
  }
  return { expiresAt: expiresAt.toISOString(), previewAt: expiresAt.toISOString() };
}

export function shareSessionUsage(
  share:
    | { accessType: 'public' }
    | {
        accessType: 'protected';
        maxSessions: number | null;
        sessionsUsed: number;
        sessionsRemaining: number | null;
      },
): string | null {
  if (share.accessType === 'public') return null;
  if (share.maxSessions === null) return `Unlimited · ${share.sessionsUsed} established`;
  return `${share.sessionsUsed} of ${share.maxSessions} used · ${share.sessionsRemaining ?? 0} remaining`;
}

export function buildShareCreateInput(
  draft: SharePolicyDraft,
  now = new Date(),
): { input: ShareCreateInput } | { error: string } {
  const expiry = resolveShareExpiry(
    draft.accessType,
    draft.expiryChoice,
    draft.customExpiresAt,
    now,
  );
  if ('error' in expiry) return expiry;
  if (draft.targetMode === 'pinned' && draft.revisionId === '') {
    return { error: 'Choose a revision to pin.' };
  }
  let maxSessions: number | undefined;
  if (draft.accessType === 'protected' && draft.maxSessions !== '') {
    maxSessions = Number(draft.maxSessions);
    if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 1_000_000) {
      return { error: 'Session limit must be an integer from 1 through 1,000,000.' };
    }
  }
  const target =
    draft.targetMode === 'latest'
      ? ({ mode: 'latest' } as const)
      : ({ mode: 'pinned', revisionId: draft.revisionId } as const);
  const expiryInput =
    'expiresAt' in expiry ? { expiresAt: expiry.expiresAt } : { expiresIn: expiry.expiresIn };
  const input = {
    accessType: draft.accessType,
    target,
    ...expiryInput,
    commentPolicy: draft.commentPolicy ?? 'off',
    ...(maxSessions === undefined ? {} : { maxSessions }),
  } as ShareCreateInput;
  return { input };
}

export function managedStatus(
  status: ShareLifecycleStatus,
  expiresAt: string | null = null,
  now = Date.now(),
): ManagedStatus {
  if (status === 'revoked') return 'Revoked';
  if (status === 'expired') return 'Expired';
  if (expiresAt !== null && new Date(expiresAt).valueOf() <= now) return 'Expired';
  switch (status) {
    case 'active':
      return 'Active';
    case 'session-limit-reached':
      return 'Session limit reached';
    default:
      return 'Active';
  }
}

function useTimedManagedStatus(
  status: ShareLifecycleStatus,
  expiresAt: string | null,
): ManagedStatus {
  const [, refresh] = useState(0);
  useEffect(() => {
    if (status === 'revoked' || status === 'expired' || expiresAt === null) return;
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    const refreshAtDeadline = () => {
      const remaining = new Date(expiresAt).valueOf() - Date.now();
      if (remaining <= 0) {
        refresh((value) => value + 1);
        return;
      }
      timeout = globalThis.setTimeout(refreshAtDeadline, Math.min(remaining + 1, 2_147_483_647));
    };
    refreshAtDeadline();
    return () => {
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
    };
  }, [expiresAt, status]);
  return managedStatus(status, expiresAt);
}

export function useShareManagedStatus(
  status: ShareLifecycleStatus,
  expiresAt: string | null,
): ManagedStatus {
  return useTimedManagedStatus(status, expiresAt);
}

export function useManagedStatus(
  revokedAt: string | null,
  expiresAt: string | null,
): 'Active' | 'Expired' | 'Revoked' {
  const status = useTimedManagedStatus(revokedAt === null ? 'active' : 'revoked', expiresAt);
  return status === 'Session limit reached' ? 'Active' : status;
}
