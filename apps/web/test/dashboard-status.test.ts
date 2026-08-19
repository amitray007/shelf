import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildShareCreateInput,
  defaultSharePolicy,
  managedStatus,
  resolveShareExpiry,
  shareSessionUsage,
} from '../src/dashboard/status.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('managed dashboard status', () => {
  it('distinguishes active, expired, and revoked records', () => {
    expect(managedStatus('active')).toBe('Active');
    expect(managedStatus('expired')).toBe('Expired');
    expect(managedStatus('session-limit-reached')).toBe('Session limit reached');
    expect(managedStatus('revoked')).toBe('Revoked');
  });

  it('moves live and session-limited links to Expired at their deadline', () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-19T12:00:00.000Z');
    const expiresAt = '2026-08-19T12:00:01.000Z';

    expect(managedStatus('active', expiresAt)).toBe('Active');
    expect(managedStatus('session-limit-reached', expiresAt)).toBe('Session limit reached');
    vi.advanceTimersByTime(1_001);
    expect(managedStatus('active', expiresAt)).toBe('Expired');
    expect(managedStatus('session-limit-reached', expiresAt)).toBe('Expired');
    expect(managedStatus('revoked', expiresAt)).toBe('Revoked');
    expect(managedStatus('expired', '2026-08-20T12:00:00.000Z')).toBe('Expired');
  });

  it('resolves every preset and validates custom Protected and Public expiry', () => {
    const now = new Date('2026-08-18T12:00:00.000Z');
    expect(resolveShareExpiry('protected', 'never', '', now)).toEqual({ expiresIn: 'never' });
    expect(resolveShareExpiry('public', 'never', '', now)).toEqual({ expiresIn: 'never' });
    expect(resolveShareExpiry('public', '24hr', '', now)).toEqual({
      expiresIn: '24hr',
      previewAt: '2026-08-19T12:00:00.000Z',
    });
    expect(resolveShareExpiry('protected', '5m', '', now)).toMatchObject({
      previewAt: '2026-08-18T12:05:00.000Z',
    });
    expect(resolveShareExpiry('protected', '30m', '', now)).toMatchObject({
      previewAt: '2026-08-18T12:30:00.000Z',
    });
    expect(resolveShareExpiry('protected', '2hr', '', now)).toMatchObject({
      previewAt: '2026-08-18T14:00:00.000Z',
    });
    expect(resolveShareExpiry('protected', '6hr', '', now)).toMatchObject({
      previewAt: '2026-08-18T18:00:00.000Z',
    });
    expect(resolveShareExpiry('protected', '3d', '', now)).toMatchObject({
      previewAt: '2026-08-21T12:00:00.000Z',
    });
    expect(resolveShareExpiry('protected', '7d', '', now)).toMatchObject({
      previewAt: '2026-08-25T12:00:00.000Z',
    });
    expect(resolveShareExpiry('protected', '15d', '', now)).toMatchObject({
      previewAt: '2026-09-02T12:00:00.000Z',
    });
    expect(resolveShareExpiry('public', '30d', '', now)).toMatchObject({
      previewAt: '2026-09-17T12:00:00.000Z',
    });
    expect(resolveShareExpiry('protected', 'custom', '2026-08-18T11:59', now)).toMatchObject({
      error: 'Choose a future expiry.',
    });
    expect(resolveShareExpiry('public', 'custom', '2026-09-18T12:01', now)).toMatchObject({
      error: 'A finite Public link cannot exceed 30 days.',
    });
  });

  it('formats Protected session use without implying Public viewer tracking', () => {
    expect(
      shareSessionUsage({
        accessType: 'protected',
        maxSessions: null,
        sessionsUsed: 4,
        sessionsRemaining: null,
      }),
    ).toBe('Unlimited · 4 established');
    expect(
      shareSessionUsage({
        accessType: 'protected',
        maxSessions: 5,
        sessionsUsed: 2,
        sessionsRemaining: 3,
      }),
    ).toBe('2 of 5 used · 3 remaining');
    expect(shareSessionUsage({ accessType: 'public' })).toBeNull();
  });

  it('applies mode defaults and validates semantic share creation drafts', () => {
    const now = new Date('2026-08-18T12:00:00.000Z');
    expect(defaultSharePolicy()).toEqual({
      expiryChoice: 'never',
      customExpiresAt: '',
      maxSessions: '',
    });
    expect(defaultSharePolicy()).toEqual({
      expiryChoice: 'never',
      customExpiresAt: '',
      maxSessions: '',
    });
    expect(
      buildShareCreateInput(
        {
          accessType: 'public',
          targetMode: 'latest',
          revisionId: '',
          expiryChoice: 'never',
          customExpiresAt: '',
          maxSessions: '',
        },
        now,
      ),
    ).toEqual({
      input: {
        accessType: 'public',
        target: { mode: 'latest' },
        expiresIn: 'never',
      },
    });
    expect(
      buildShareCreateInput(
        {
          accessType: 'protected',
          targetMode: 'pinned',
          revisionId: `rev_${'a'.repeat(22)}`,
          expiryChoice: '7d',
          customExpiresAt: '',
          maxSessions: '5',
        },
        now,
      ),
    ).toEqual({
      input: {
        accessType: 'protected',
        target: { mode: 'pinned', revisionId: `rev_${'a'.repeat(22)}` },
        expiresIn: '7d',
        maxSessions: 5,
      },
    });
  });
});
