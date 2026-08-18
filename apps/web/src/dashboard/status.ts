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
  return managedStatus(revokedAt, expiresAt);
}
