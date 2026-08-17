import type { ContentInventory, ReferencedContentInventory } from './ports.js';

export interface ReconciliationRequest {
  installationId: string;
  minimumAgeSeconds: number;
}

export interface ReconciliationReport {
  apiVersion: 'v1';
  mode: 'dry-run';
  installationId: string;
  scannedAt: string;
  minimumAgeSeconds: number;
  summary: {
    referencedContent: number;
    sealedObjects: number;
    stagingObjects: number;
    healthyReferenced: number;
    missingReferenced: number;
    mismatchedReferenced: number;
    sealedOrphanCandidates: number;
    staleStagingCandidates: number;
    deferredRecentSealed: number;
    deferredRecentStaging: number;
    unrecognizedStorageEntries: number;
  };
  findings: {
    missingReferenced: Array<{
      contentId: string;
      expectedByteCount: number;
      revisionCount: number;
    }>;
    mismatchedReferenced: Array<{
      contentId: string;
      expectedByteCount: number;
      actualByteCount: number;
      revisionCount: number;
    }>;
    sealedOrphanCandidates: Array<{
      contentId: string;
      byteCount: number;
      modifiedAt: string;
    }>;
    staleStagingCandidates: Array<{ stageId: string; modifiedAt: string }>;
  };
}

export function createReconciliationService(options: {
  references: ReferencedContentInventory;
  content: ContentInventory;
  now?: () => Date;
}) {
  return async function reconcile(request: ReconciliationRequest): Promise<ReconciliationReport> {
    const minimumAgeMilliseconds = request.minimumAgeSeconds * 1000;
    if (
      !Number.isSafeInteger(request.minimumAgeSeconds) ||
      request.minimumAgeSeconds < 60 ||
      !Number.isSafeInteger(minimumAgeMilliseconds)
    ) {
      throw new Error('minimumAgeSeconds must be a safe integer of at least 60.');
    }
    const now = options.now?.() ?? new Date();
    const cutoff = now.getTime() - minimumAgeMilliseconds;
    const [references, inventory] = await Promise.all([
      options.references.listReferencedContent(request.installationId),
      options.content.inventory(),
    ]);
    const sealedById = new Map(inventory.sealed.map((entry) => [entry.contentId, entry]));
    const missingReferenced: ReconciliationReport['findings']['missingReferenced'] = [];
    const mismatchedReferenced: ReconciliationReport['findings']['mismatchedReferenced'] = [];
    const referencedIds = new Set<string>();
    let healthyReferenced = 0;

    for (const reference of references) {
      referencedIds.add(reference.contentId);
      const sealed = sealedById.get(reference.contentId);
      if (sealed === undefined) {
        missingReferenced.push({
          contentId: reference.contentId,
          expectedByteCount: reference.byteCount,
          revisionCount: reference.revisionCount,
        });
      } else if (sealed.byteCount !== reference.byteCount) {
        mismatchedReferenced.push({
          contentId: reference.contentId,
          expectedByteCount: reference.byteCount,
          actualByteCount: sealed.byteCount,
          revisionCount: reference.revisionCount,
        });
      } else {
        healthyReferenced += 1;
      }
    }
    missingReferenced.sort((left, right) => left.contentId.localeCompare(right.contentId));
    mismatchedReferenced.sort((left, right) => left.contentId.localeCompare(right.contentId));
    const sealedOrphanCandidates = inventory.sealed
      .filter(
        (entry) => !referencedIds.has(entry.contentId) && entry.modifiedAt.getTime() <= cutoff,
      )
      .map((entry) => ({ ...entry, modifiedAt: entry.modifiedAt.toISOString() }))
      .sort((left, right) => left.contentId.localeCompare(right.contentId));
    const staleStagingCandidates = inventory.staging
      .filter((entry) => entry.modifiedAt.getTime() <= cutoff)
      .map((entry) => ({ ...entry, modifiedAt: entry.modifiedAt.toISOString() }))
      .sort((left, right) => left.stageId.localeCompare(right.stageId));
    const unreferencedSealed = inventory.sealed.filter(
      (entry) => !referencedIds.has(entry.contentId),
    );

    return {
      apiVersion: 'v1',
      mode: 'dry-run',
      installationId: request.installationId,
      scannedAt: now.toISOString(),
      minimumAgeSeconds: request.minimumAgeSeconds,
      summary: {
        referencedContent: references.length,
        sealedObjects: inventory.sealed.length,
        stagingObjects: inventory.staging.length,
        healthyReferenced,
        missingReferenced: missingReferenced.length,
        mismatchedReferenced: mismatchedReferenced.length,
        sealedOrphanCandidates: sealedOrphanCandidates.length,
        staleStagingCandidates: staleStagingCandidates.length,
        deferredRecentSealed: unreferencedSealed.length - sealedOrphanCandidates.length,
        deferredRecentStaging: inventory.staging.length - staleStagingCandidates.length,
        unrecognizedStorageEntries: inventory.unrecognizedEntries,
      },
      findings: {
        missingReferenced,
        mismatchedReferenced,
        sealedOrphanCandidates,
        staleStagingCandidates,
      },
    };
  };
}
