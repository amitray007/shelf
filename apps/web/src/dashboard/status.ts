import type { ShareCreateInput, ShareExpiryPreset, ShareLifecycleStatus } from '@shelf/contracts';
import { useEffect, useState } from 'react';

export type ManagedStatus = 'Active' | 'Session limit reached' | 'Expired' | 'Revoked';
export type ShareExpiryChoice = 'never' | ShareExpiryPreset | 'custom';

const expiryDurationMs: Record<ShareExpiryPreset, number> = {
  '5m': 5 * 60 * 1_000,
  '30m': 30 * 60 * 1_000,
  '2hr': 2 * 60 * 60 * 1_000,
  '6hr': 6 * 60 * 60 * 1_000,
  '24hr': 24 * 60 * 60 * 1_000,
  '3d': 3 * 24 * 60 * 60 * 1_000,
  '7d': 7 * 24 * 60 * 60 * 1_000,
  '15d': 15 * 24 * 60 * 60 * 1_000,
  '30d': 30 * 24 * 60 * 60 * 1_000,
};

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
  publicAcknowledged: boolean;
}

export function defaultSharePolicy(accessType: 'protected' | 'public') {
  return {
    expiryChoice: accessType === 'protected' ? ('never' as const) : ('24hr' as const),
    customExpiresAt: '',
    maxSessions: '',
    publicAcknowledged: false,
  };
}

export function resolveShareExpiry(
  accessType: 'protected' | 'public',
  choice: ShareExpiryChoice,
  customValue: string,
  now = new Date(),
): ResolvedShareExpiry {
  if (choice === 'never') {
    return accessType === 'protected'
      ? { expiresIn: 'never' }
      : { error: 'Public links must expire.' };
  }
  if (choice !== 'custom') {
    return {
      expiresIn: choice,
      previewAt: new Date(now.getTime() + expiryDurationMs[choice]).toISOString(),
    };
  }
  if (customValue === '') return { error: 'Choose an expiry.' };
  const expiresAt = new Date(customValue);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
    return { error: 'Choose a future expiry.' };
  }
  if (accessType === 'public' && expiresAt.getTime() - now.getTime() > expiryDurationMs['30d']) {
    return { error: 'Public links must expire within 30 days.' };
  }
  return { expiresAt: expiresAt.toISOString(), previewAt: expiresAt.toISOString() };
}

export function shareSessionUsage(
  share:
    | { accessType: 'public' }
    | { accessType: 'protected'; maxSessions: number | null; sessionsUsed: number },
): string | null {
  if (share.accessType === 'public') return null;
  if (share.maxSessions === null) return `Unlimited · ${share.sessionsUsed} established`;
  return `${share.sessionsUsed} of ${share.maxSessions} used · ${Math.max(0, share.maxSessions - share.sessionsUsed)} remaining`;
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
  if (draft.accessType === 'public' && !draft.publicAcknowledged) {
    return { error: 'Confirm that anyone with this URL may access the content.' };
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
    ...(maxSessions === undefined ? {} : { maxSessions }),
  } as ShareCreateInput;
  return { input };
}

export function managedStatus(status: ShareLifecycleStatus): ManagedStatus {
  switch (status) {
    case 'active':
      return 'Active';
    case 'session-limit-reached':
      return 'Session limit reached';
    case 'expired':
      return 'Expired';
    case 'revoked':
      return 'Revoked';
  }
}

export function useManagedStatus(
  revokedAt: string | null,
  expiresAt: string | null,
): 'Active' | 'Expired' | 'Revoked' {
  const [, refresh] = useState(0);
  useEffect(() => {
    if (revokedAt !== null || expiresAt === null) return;
    const remaining = new Date(expiresAt).valueOf() - Date.now();
    if (remaining <= 0) return;
    const timeout = globalThis.setTimeout(
      () => refresh((value) => value + 1),
      Math.min(remaining + 1, 2_147_483_647),
    );
    return () => globalThis.clearTimeout(timeout);
  }, [expiresAt, revokedAt]);
  if (revokedAt !== null) return 'Revoked';
  if (expiresAt !== null && new Date(expiresAt).valueOf() <= Date.now()) return 'Expired';
  return 'Active';
}
