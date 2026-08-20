import type { PublicShareResolution } from '@shelf/contracts';
import type { StoredArtifactRevision } from '../artifacts/catalog.js';
import { boundaryFailure } from '../errors.js';
import { ShareNotFoundError, shareLifecycleStatus } from './lifecycle.js';
import type {
  EstablishProtectedSessionOutcome,
  ResolvedStoredShare,
  ShareCapabilityCodec,
  ShareClock,
  ShareRepository,
} from './ports.js';

const SHARE_ID_PATTERN = /^shr_[A-Za-z0-9_-]{22}$/u;
const PUBLIC_CODE_PATTERN = /^[A-Za-z0-9_-]{12}$/u;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const AUTHORIZATION_LIFETIME_MS = 24 * 60 * 60 * 1000;

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
  if (share.target.mode === 'pinned') return revision.revisionId === share.target.revisionId;
  return revision.revisionId === artifact.latestRevision.revisionId;
}

function publicResolution(value: ResolvedStoredShare): PublicShareResolution {
  const { share, artifact, revision: scopedRevision } = value;
  const revision: StoredArtifactRevision = scopedRevision.revision;
  const target =
    share.target.mode === 'pinned'
      ? { mode: 'pinned' as const, revisionId: share.target.revisionId }
      : { mode: 'latest' as const };
  const access =
    share.accessType === 'public'
      ? {
          accessType: 'public' as const,
          publicCode: share.publicCode as string,
          expiresAt: share.expiresAt,
          basePath: `/api/v1/public/links/${share.publicCode}`,
        }
      : {
          accessType: 'protected' as const,
          expiresAt: share.expiresAt,
          basePath: `/api/v1/public/shares/${share.shareId}`,
        };
  const common = {
    apiVersion: 'v1' as const,
    shareId: share.shareId,
    accessType: access.accessType,
    commentPolicy: share.commentPolicy ?? 'off',
    target,
    artifact: {
      artifactId: artifact.artifactId,
      kind: revision.kind,
      name: artifact.name,
    },
    expiresAt: access.expiresAt,
  };
  if (revision.kind === 'folder') {
    return {
      ...common,
      ...(share.accessType === 'public' ? { publicCode: access.publicCode } : {}),
      artifact: { ...common.artifact, kind: 'folder' },
      revision: {
        kind: 'folder',
        revisionId: revision.revisionId,
        revisionNumber: revision.revisionNumber,
        createdAt: revision.createdAt,
        rootName: revision.rootName,
        byteCount: revision.byteCount,
        fileCount: revision.fileCount,
      },
      action: { type: 'tree', path: `${access.basePath}/tree` },
    } as PublicShareResolution;
  }
  return {
    ...common,
    ...(share.accessType === 'public' ? { publicCode: access.publicCode } : {}),
    artifact: { ...common.artifact, kind: 'file' },
    revision: {
      kind: 'file',
      revisionId: revision.revisionId,
      revisionNumber: revision.revisionNumber,
      createdAt: revision.createdAt,
      originalFileName: revision.originalFileName,
      mediaType: revision.mediaType,
      byteCount: revision.byteCount,
    },
    action: { type: 'content', path: `${access.basePath}/content` },
  } as PublicShareResolution;
}

export type ShareResolutionAuthority =
  | { type: 'protected-session'; shareId: string; sessionId: string }
  | { type: 'public'; publicCode: string };

export interface ProtectedSessionAuthorization {
  shareId: string;
  sessionId: string;
  issuedAt: string;
  expiresAt: string;
  reused: boolean;
}

async function loadResolution(
  shares: ShareRepository,
  authority: ShareResolutionAuthority,
  signal?: AbortSignal,
): Promise<ResolvedStoredShare | undefined> {
  try {
    signal?.throwIfAborted();
    return authority.type === 'public'
      ? await shares.resolvePublicShareTarget(authority.publicCode)
      : await shares.resolveShareTarget(authority.shareId);
  } catch (error) {
    throw boundaryFailure('SERVICE_UNAVAILABLE', 'Share resolution failed.', error);
  }
}

export function createShareResolutionService(dependencies: {
  shares: ShareRepository;
  clock?: ShareClock;
}) {
  const clock = dependencies.clock ?? defaultClock;

  return async function resolveShare(request: {
    authority: ShareResolutionAuthority;
    signal?: AbortSignal;
  }): Promise<PublicShareResolution> {
    const { authority } = request;
    if (
      (authority.type === 'public' && !PUBLIC_CODE_PATTERN.test(authority.publicCode)) ||
      (authority.type === 'protected-session' &&
        (!SHARE_ID_PATTERN.test(authority.shareId) ||
          !SESSION_ID_PATTERN.test(authority.sessionId)))
    ) {
      throw new ShareNotFoundError();
    }
    const resolved = await loadResolution(dependencies.shares, authority, request.signal);
    if (resolved === undefined || !validScope(resolved)) {
      throw new ShareNotFoundError();
    }
    const { share } = resolved;
    const wrongMode =
      (authority.type === 'public' &&
        (share.accessType !== 'public' || share.publicCode !== authority.publicCode)) ||
      (authority.type === 'protected-session' &&
        (share.accessType !== 'protected' || share.shareId !== authority.shareId));
    if (wrongMode) throw new ShareNotFoundError();
    const status = shareLifecycleStatus(share, clock());
    if (status === 'revoked' || status === 'expired') throw new ShareNotFoundError();
    if (authority.type === 'public' && status !== 'active') throw new ShareNotFoundError();
    if (
      share.accessType === 'public' &&
      (share.publicCode === null || share.maxSessions !== null)
    ) {
      throw new ShareNotFoundError();
    }
    return publicResolution(resolved);
  };
}

export function createProtectedSessionEstablishmentService(dependencies: {
  shares: ShareRepository;
  capabilityCodec: ShareCapabilityCodec;
  clock?: ShareClock;
}) {
  const clock = dependencies.clock ?? defaultClock;
  return async function establishProtectedSession(request: {
    shareId: string;
    secret: string;
    sessionId: string;
    signal?: AbortSignal;
  }): Promise<ProtectedSessionAuthorization> {
    if (
      !SHARE_ID_PATTERN.test(request.shareId) ||
      !CAPABILITY_PATTERN.test(request.secret) ||
      !SESSION_ID_PATTERN.test(request.sessionId)
    ) {
      throw new ShareNotFoundError();
    }
    let validSecret = false;
    try {
      validSecret = dependencies.capabilityCodec.validateSecret(request.shareId, request.secret);
    } catch {
      // Sensitive capability failures intentionally collapse to the unavailable response.
    }
    if (!validSecret) throw new ShareNotFoundError();
    const now = clock();
    let outcome: EstablishProtectedSessionOutcome;
    try {
      request.signal?.throwIfAborted();
      outcome = await dependencies.shares.establishProtectedSession({
        shareId: request.shareId,
        sessionId: request.sessionId,
        now: now.toISOString(),
        receiptExpiresAt: new Date(now.getTime() + AUTHORIZATION_LIFETIME_MS).toISOString(),
      });
    } catch (error) {
      throw boundaryFailure(
        'SERVICE_UNAVAILABLE',
        'Protected session establishment failed.',
        error,
      );
    }
    if (
      outcome.status === 'unavailable' ||
      outcome.result.share.shareId !== request.shareId ||
      outcome.result.share.accessType !== 'protected' ||
      outcome.result.sessionId !== request.sessionId
    ) {
      throw new ShareNotFoundError();
    }
    const status = shareLifecycleStatus(outcome.result.share, now);
    if (status === 'revoked' || status === 'expired') throw new ShareNotFoundError();
    const policyExpiry =
      outcome.result.share.expiresAt === null
        ? Number.POSITIVE_INFINITY
        : Date.parse(outcome.result.share.expiresAt);
    const expiresAt = new Date(
      Math.min(now.getTime() + AUTHORIZATION_LIFETIME_MS, policyExpiry),
    ).toISOString();
    return {
      shareId: request.shareId,
      sessionId: request.sessionId,
      issuedAt: now.toISOString(),
      expiresAt,
      reused: outcome.status === 'reused',
    };
  };
}
