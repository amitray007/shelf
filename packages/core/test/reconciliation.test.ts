import { describe, expect, it } from 'vitest';

import { createReconciliationService } from '../src/index.js';

const scannedAt = new Date('2026-08-17T12:00:00.000Z');

describe('content reconciliation service', () => {
  it('distinguishes healthy and missing referenced content', async () => {
    const reconcile = createReconciliationService({
      references: {
        async listReferencedContent() {
          return [
            {
              contentId: 'cnt_11111111111111111111111111111111',
              contentHash: `sha256:${'a'.repeat(64)}`,
              byteCount: 12,
              revisionCount: 1,
            },
            {
              contentId: 'cnt_22222222222222222222222222222222',
              contentHash: `sha256:${'b'.repeat(64)}`,
              byteCount: 7,
              revisionCount: 2,
            },
          ];
        },
      },
      content: {
        async inventory() {
          return {
            sealed: [
              {
                contentId: 'cnt_11111111111111111111111111111111',
                byteCount: 12,
                modifiedAt: new Date('2026-08-16T10:00:00.000Z'),
              },
            ],
            staging: [],
            unrecognizedEntries: 0,
          };
        },
      },
      now: () => scannedAt,
    });

    await expect(
      reconcile({ installationId: 'installation-main', minimumAgeSeconds: 3600 }),
    ).resolves.toEqual({
      apiVersion: 'v1',
      mode: 'dry-run',
      installationId: 'installation-main',
      scannedAt: '2026-08-17T12:00:00.000Z',
      minimumAgeSeconds: 3600,
      summary: {
        referencedContent: 2,
        sealedObjects: 1,
        stagingObjects: 0,
        healthyReferenced: 1,
        missingReferenced: 1,
        mismatchedReferenced: 0,
        sealedOrphanCandidates: 0,
        staleStagingCandidates: 0,
        deferredRecentSealed: 0,
        deferredRecentStaging: 0,
        unrecognizedStorageEntries: 0,
      },
      findings: {
        missingReferenced: [
          {
            contentId: 'cnt_22222222222222222222222222222222',
            expectedByteCount: 7,
            revisionCount: 2,
          },
        ],
        mismatchedReferenced: [],
        sealedOrphanCandidates: [],
        staleStagingCandidates: [],
      },
    });
  });

  it('age-gates sealed orphans and stale staging without changing storage', async () => {
    const sealed = [
      {
        contentId: 'cnt_33333333333333333333333333333333',
        byteCount: 20,
        modifiedAt: new Date('2026-08-17T10:00:00.000Z'),
      },
      {
        contentId: 'cnt_44444444444444444444444444444444',
        byteCount: 21,
        modifiedAt: new Date('2026-08-17T11:30:00.000Z'),
      },
    ];
    const staging = [
      {
        stageId: 'cnt_55555555555555555555555555555555',
        modifiedAt: new Date('2026-08-17T09:00:00.000Z'),
      },
      {
        stageId: 'cnt_66666666666666666666666666666666',
        modifiedAt: new Date('2026-08-17T11:45:00.000Z'),
      },
    ];
    const reconcile = createReconciliationService({
      references: {
        async listReferencedContent() {
          return [];
        },
      },
      content: {
        async inventory() {
          return { sealed, staging, unrecognizedEntries: 2 };
        },
      },
      now: () => scannedAt,
    });

    const report = await reconcile({
      installationId: 'installation-main',
      minimumAgeSeconds: 3600,
    });

    expect(report.summary).toMatchObject({
      sealedObjects: 2,
      stagingObjects: 2,
      sealedOrphanCandidates: 1,
      staleStagingCandidates: 1,
      deferredRecentSealed: 1,
      deferredRecentStaging: 1,
      unrecognizedStorageEntries: 2,
    });
    expect(report.findings.sealedOrphanCandidates).toEqual([
      {
        contentId: 'cnt_33333333333333333333333333333333',
        byteCount: 20,
        modifiedAt: '2026-08-17T10:00:00.000Z',
      },
    ]);
    expect(report.findings.staleStagingCandidates).toEqual([
      {
        stageId: 'cnt_55555555555555555555555555555555',
        modifiedAt: '2026-08-17T09:00:00.000Z',
      },
    ]);
    expect(sealed).toHaveLength(2);
    expect(staging).toHaveLength(2);
  });

  it('reports referenced content whose stored size no longer matches metadata', async () => {
    const contentId = 'cnt_77777777777777777777777777777777';
    const reconcile = createReconciliationService({
      references: {
        async listReferencedContent() {
          return [
            {
              contentId,
              contentHash: `sha256:${'c'.repeat(64)}`,
              byteCount: 12,
              revisionCount: 3,
            },
          ];
        },
      },
      content: {
        async inventory() {
          return {
            sealed: [
              { contentId, byteCount: 13, modifiedAt: new Date('2026-08-16T10:00:00.000Z') },
            ],
            staging: [],
            unrecognizedEntries: 0,
          };
        },
      },
      now: () => scannedAt,
    });

    const report = await reconcile({
      installationId: 'installation-main',
      minimumAgeSeconds: 3600,
    });

    expect(report.summary).toMatchObject({
      healthyReferenced: 0,
      missingReferenced: 0,
      mismatchedReferenced: 1,
      sealedOrphanCandidates: 0,
    });
    expect(report.findings.mismatchedReferenced).toEqual([
      { contentId, expectedByteCount: 12, actualByteCount: 13, revisionCount: 3 },
    ]);
  });

  it('rejects a minimum age that cannot be represented safely in milliseconds', async () => {
    const reconcile = createReconciliationService({
      references: {
        async listReferencedContent() {
          return [];
        },
      },
      content: {
        async inventory() {
          return { sealed: [], staging: [], unrecognizedEntries: 0 };
        },
      },
    });

    await expect(
      reconcile({
        installationId: 'installation-main',
        minimumAgeSeconds: Number.MAX_SAFE_INTEGER,
      }),
    ).rejects.toThrow('minimumAgeSeconds');
  });
});
