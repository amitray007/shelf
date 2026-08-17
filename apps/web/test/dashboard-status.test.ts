import { describe, expect, it } from 'vitest';

import { managedStatus } from '../src/dashboard/status.js';

describe('managed dashboard status', () => {
  it('distinguishes active, expired, and revoked records', () => {
    const now = new Date('2026-08-18T12:00:00.000Z').valueOf();
    expect(managedStatus(null, null, now)).toBe('Active');
    expect(managedStatus(null, '2026-08-18T11:59:59.999Z', now)).toBe('Expired');
    expect(managedStatus('2026-08-18T11:00:00.000Z', '2026-08-18T13:00:00.000Z', now)).toBe(
      'Revoked',
    );
  });
});
