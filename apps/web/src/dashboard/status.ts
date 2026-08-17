import { useEffect, useState } from 'react';

export type ManagedStatus = 'Active' | 'Expired' | 'Revoked';

export function managedStatus(
  revokedAt: string | null,
  expiresAt: string | null,
  now = Date.now(),
): ManagedStatus {
  if (revokedAt !== null) return 'Revoked';
  if (expiresAt !== null && new Date(expiresAt).valueOf() <= now) return 'Expired';
  return 'Active';
}

export function useManagedStatus(
  revokedAt: string | null,
  expiresAt: string | null,
): ManagedStatus {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (revokedAt !== null || expiresAt === null) return;
    const remaining = new Date(expiresAt).valueOf() - now;
    if (remaining <= 0) return;
    const timeout = globalThis.setTimeout(
      () => setNow(Date.now()),
      Math.min(remaining + 1, 2_147_483_647),
    );
    return () => globalThis.clearTimeout(timeout);
  }, [expiresAt, now, revokedAt]);
  return managedStatus(revokedAt, expiresAt, now);
}
