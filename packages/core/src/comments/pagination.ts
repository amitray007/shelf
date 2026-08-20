const CURSOR_VERSION = 1;
const DEFAULT_COMMENT_PAGE_LIMIT = 25;
const MAX_COMMENT_PAGE_LIMIT = 50;

export type CommentThreadListScope =
  | {
      readonly kind: 'share';
      readonly installationId: string;
      readonly workspaceId: string;
      readonly shareId: string;
    }
  | {
      readonly kind: 'artifact';
      readonly installationId: string;
      readonly workspaceId: string;
      readonly artifactId: string;
    };

export interface CommentThreadCursor {
  readonly scope: CommentThreadListScope;
  readonly updatedAt: string;
  readonly threadId: string;
}

export const COMMENT_PAGE_DEFAULT_LIMIT = DEFAULT_COMMENT_PAGE_LIMIT;
export const COMMENT_PAGE_MAX_LIMIT = MAX_COMMENT_PAGE_LIMIT;

function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeBase64Url(value: string): string | undefined {
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    return decoded.length === 0 ? undefined : decoded;
  } catch {
    return undefined;
  }
}

export function encodeCommentThreadCursor(cursor: CommentThreadCursor): string {
  return encodeBase64Url(JSON.stringify({ v: CURSOR_VERSION, ...cursor }));
}

export function decodeCommentThreadCursor(value: string): CommentThreadCursor | undefined {
  if (value.length === 0 || value.length > 4096) return undefined;
  const raw = decodeBase64Url(value);
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as {
      v?: unknown;
      scope?: unknown;
      updatedAt?: unknown;
      threadId?: unknown;
    };
    if (parsed.v !== CURSOR_VERSION || typeof parsed.scope !== 'object' || parsed.scope === null)
      return undefined;
    const scope = parsed.scope as Record<string, unknown>;
    const kind = scope.kind;
    const installationId = scope.installationId;
    const workspaceId = scope.workspaceId;
    if (
      (kind !== 'share' && kind !== 'artifact') ||
      typeof installationId !== 'string' ||
      typeof workspaceId !== 'string' ||
      (kind === 'share' && typeof scope.shareId !== 'string') ||
      (kind === 'artifact' && typeof scope.artifactId !== 'string') ||
      typeof parsed.updatedAt !== 'string' ||
      Number.isNaN(Date.parse(parsed.updatedAt)) ||
      typeof parsed.threadId !== 'string' ||
      parsed.threadId.length === 0
    )
      return undefined;
    return kind === 'share'
      ? {
          scope: { kind, installationId, workspaceId, shareId: scope.shareId as string },
          updatedAt: parsed.updatedAt,
          threadId: parsed.threadId,
        }
      : {
          scope: { kind, installationId, workspaceId, artifactId: scope.artifactId as string },
          updatedAt: parsed.updatedAt,
          threadId: parsed.threadId,
        };
  } catch {
    return undefined;
  }
}

export function normalizeCommentPageLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_COMMENT_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_COMMENT_PAGE_LIMIT) {
    throw new Error(`Comment page limit must be between 1 and ${MAX_COMMENT_PAGE_LIMIT}.`);
  }
  return limit;
}

export function commentCursorMatchesScope(
  cursor: CommentThreadCursor,
  scope: CommentThreadListScope,
): boolean {
  if (
    cursor.scope.kind !== scope.kind ||
    cursor.scope.installationId !== scope.installationId ||
    cursor.scope.workspaceId !== scope.workspaceId
  )
    return false;
  return cursor.scope.kind === 'share' && scope.kind === 'share'
    ? cursor.scope.shareId === scope.shareId
    : cursor.scope.kind === 'artifact' && scope.kind === 'artifact'
      ? cursor.scope.artifactId === scope.artifactId
      : false;
}
