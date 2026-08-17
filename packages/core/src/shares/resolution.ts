import type { PublicShareResolution } from '@shelf/contracts';
import type { StoredArtifactRevision } from '../artifacts/catalog.js';
import { boundaryFailure } from '../errors.js';
import { ShareNotFoundError } from './lifecycle.js';
import type {
  ResolvedStoredShare,
  ShareCapabilityCodec,
  ShareClock,
  ShareRepository,
} from './ports.js';

const SHARE_ID_PATTERN = /^shr_[A-Za-z0-9_-]{22}$/u;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u;

function defaultClock(): Date {
  return new Date();
}

function validScope(value: ResolvedStoredShare): boolean {
  const { share, artifact, revision: scopedRevision } = value;
  const revision = scopedRevision.revision;
  const artifactKind = artifact.kind ?? artifact.latestRevision.kind ?? 'file';
  const revisionKind = revision.kind ?? 'file';
  if (
    share.shareId.length === 0 ||
    share.artifactId !== artifact.artifactId ||
    share.installationId !== artifact.installationId ||
    share.workspaceId !== artifact.workspaceId ||
    scopedRevision.installationId !== share.installationId ||
    scopedRevision.workspaceId !== share.workspaceId ||
    scopedRevision.artifactId !== share.artifactId ||
    artifactKind !== revisionKind
  ) {
    return false;
  }
  if (share.target.mode === 'pinned') {
    return revision.revisionId === share.target.revisionId;
  }
  return revision.revisionId === artifact.latestRevision.revisionId;
}

function publicResolution(value: ResolvedStoredShare): PublicShareResolution {
  const { share, artifact, revision: scopedRevision } = value;
  const revision: StoredArtifactRevision = scopedRevision.revision;
  const target =
    share.target.mode === 'pinned'
      ? { mode: 'pinned' as const, revisionId: share.target.revisionId }
      : { mode: 'latest' as const };
  if (revision.kind === 'folder') {
    return {
      apiVersion: 'v1',
      shareId: share.shareId,
      target,
      artifact: {
        artifactId: artifact.artifactId,
        kind: 'folder',
        name: artifact.name,
      },
      revision: {
        kind: 'folder',
        revisionId: revision.revisionId,
        revisionNumber: revision.revisionNumber,
        createdAt: revision.createdAt,
        rootName: revision.rootName,
        byteCount: revision.byteCount,
        fileCount: revision.fileCount,
      },
      action: {
        type: 'tree',
        path: `/api/v1/public/shares/${share.shareId}/tree`,
      },
      expiresAt: share.expiresAt,
    };
  }
  return {
    apiVersion: 'v1',
    shareId: share.shareId,
    target,
    artifact: {
      artifactId: artifact.artifactId,
      kind: 'file',
      name: artifact.name,
    },
    revision: {
      kind: 'file',
      revisionId: revision.revisionId,
      revisionNumber: revision.revisionNumber,
      createdAt: revision.createdAt,
      originalFileName: revision.originalFileName,
      mediaType: revision.mediaType,
      byteCount: revision.byteCount,
    },
    action: {
      type: 'content',
      path: `/api/v1/public/shares/${share.shareId}/content`,
    },
    expiresAt: share.expiresAt,
  };
}

export function createShareResolutionService(dependencies: {
  shares: ShareRepository;
  capabilityCodec: ShareCapabilityCodec;
  clock?: ShareClock;
}) {
  const clock = dependencies.clock ?? defaultClock;

  return async function resolveShare(request: {
    shareId: string;
    secret: string;
    signal?: AbortSignal;
  }): Promise<PublicShareResolution> {
    if (!SHARE_ID_PATTERN.test(request.shareId) || !CAPABILITY_PATTERN.test(request.secret)) {
      throw new ShareNotFoundError();
    }
    let validSecret = false;
    try {
      validSecret = dependencies.capabilityCodec.validateSecret(request.shareId, request.secret);
    } catch {
      // Capability failures are deliberately indistinguishable from a missing share.
    }
    if (!validSecret) throw new ShareNotFoundError();

    let resolved: ResolvedStoredShare | undefined;
    try {
      request.signal?.throwIfAborted();
      resolved = await dependencies.shares.resolveShareTarget(request.shareId);
    } catch (error) {
      throw boundaryFailure('SERVICE_UNAVAILABLE', 'Share resolution failed.', error);
    }
    if (resolved === undefined || resolved.share.shareId !== request.shareId) {
      throw new ShareNotFoundError();
    }
    const { share } = resolved;
    const expiresAt = share.expiresAt === null ? null : Date.parse(share.expiresAt);
    if (
      share.revokedAt !== null ||
      (expiresAt !== null && Number.isFinite(expiresAt) && expiresAt <= clock().getTime())
    ) {
      throw new ShareNotFoundError();
    }
    if ((expiresAt !== null && !Number.isFinite(expiresAt)) || !validScope(resolved)) {
      throw boundaryFailure(
        'SERVICE_UNAVAILABLE',
        'Share resolution returned invalid state.',
        new Error('Share repository returned inconsistent target scope.'),
      );
    }
    return publicResolution(resolved);
  };
}
