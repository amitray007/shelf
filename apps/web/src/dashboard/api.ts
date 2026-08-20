import {
  type Artifact,
  type ArtifactDefaultShares,
  type ArtifactDeletionResult,
  type ArtifactPage,
  type ArtifactRevisionPage,
  COMMENT_SUMMARY_RECENT_THREAD_LIMIT,
  type CommentPolicy,
  type CommentPost,
  type CommentSummary,
  type CommentThread,
  type CommentThreadPage,
  type DashboardCredentialIssue,
  type DashboardCredentialIssueRequest,
  type DashboardCredentialPage,
  type DashboardCredentialRevoke,
  type DashboardSession,
  type FolderEntry,
  isArtifact,
  isArtifactDefaultShares,
  isArtifactDeletionResult,
  isArtifactPage,
  isArtifactRevisionPage,
  isCommentThread,
  isDashboardCredentialIssue,
  isDashboardCredentialPage,
  isDashboardCredentialRevoke,
  isDashboardSession,
  isErrorEnvelope,
  isFolderTreePage,
  isRestoreResult,
  isShareCreateResult,
  isSharePage,
  isWorkspaceCreateResult,
  type RestoreResult,
  type ShareCreateInput,
  type ShareCreateResult,
  type ShareManagementSummary,
  type SharePage,
  type WorkspaceCreateResult,
} from '@shelf/contracts';

export class DashboardAuthenticationError extends Error {
  constructor() {
    super('Dashboard authentication is required.');
    this.name = 'DashboardAuthenticationError';
  }
}

export class DashboardApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DashboardApiError';
    this.code = code;
  }
}

const DASHBOARD_REQUEST_TIMEOUT_MS = 30_000;

async function dashboardFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) abortFromCaller();
  else init.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DASHBOARD_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      throw new DashboardApiError('REQUEST_TIMEOUT', 'Shelf did not respond in time.');
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    init.signal?.removeEventListener('abort', abortFromCaller);
  }
}

async function responseValue(response: Response): Promise<unknown> {
  if (response.status === 401) throw new DashboardAuthenticationError();
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned an invalid response.');
  }
  if (!response.ok) {
    if (isErrorEnvelope(value)) throw new DashboardApiError(value.error.code, value.error.message);
    throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned an invalid response.');
  }
  return value;
}

function requestOptions(init: RequestInit = {}): RequestInit {
  return {
    cache: 'no-store',
    credentials: 'same-origin',
    ...init,
  };
}

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  if (!path.startsWith('/api/v1/')) {
    throw new DashboardApiError('INVALID_REQUEST', 'The dashboard API path is invalid.');
  }
  return responseValue(await dashboardFetch(path, requestOptions(init)));
}

function jsonRequest(method: string, body?: unknown, headers?: HeadersInit): RequestInit {
  return requestOptions({
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function signIn(email: string, password: string): Promise<void> {
  const response = await dashboardFetch(
    '/api/auth/sign-in/email',
    jsonRequest('POST', { email, password }),
  );
  if (!response.ok) {
    throw new DashboardApiError('SIGN_IN_FAILED', 'The email or password is incorrect.');
  }
}

export async function signOut(): Promise<void> {
  const response = await dashboardFetch('/api/auth/sign-out', requestOptions({ method: 'POST' }));
  if (!response.ok) throw new DashboardApiError('SIGN_OUT_FAILED', 'Sign out failed.');
}

export async function createWorkspace(workspaceId: string): Promise<WorkspaceCreateResult> {
  const value = await requestJson('/api/v1/workspaces', jsonRequest('POST', { workspaceId }));
  if (!isWorkspaceCreateResult(value)) {
    throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned an invalid response.');
  }
  return value;
}

export async function loadDashboardSession(signal?: AbortSignal): Promise<DashboardSession> {
  const value = await requestJson(
    '/api/v1/dashboard/session',
    signal === undefined ? undefined : { signal },
  );
  if (!isDashboardSession(value)) {
    throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned an invalid response.');
  }
  return value;
}

export async function loadArtifacts(
  workspaceId: string,
  cursor?: string,
  signal?: AbortSignal,
  sort: 'created' | 'updated' = 'updated',
  order: 'asc' | 'desc' = 'desc',
  search?: string,
): Promise<ArtifactPage> {
  const query = new URLSearchParams({ limit: '10', sort, order });
  if (cursor !== undefined) query.set('cursor', cursor);
  if (search !== undefined && search.length > 0) query.set('search', search);
  const value = await requestJson(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts?${query}`,
    signal === undefined ? undefined : { signal },
  );
  if (!isArtifactPage(value)) {
    throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned an invalid response.');
  }
  return value;
}

export async function loadArtifact(artifactId: string, signal?: AbortSignal): Promise<Artifact> {
  const value = await requestJson(
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}`,
    signal === undefined ? undefined : { signal },
  );
  if (!isArtifact(value)) {
    throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned an invalid response.');
  }
  return value;
}

export async function loadArtifactHistory(
  artifactId: string,
  order: 'newest' | 'oldest',
  cursor?: string,
  signal?: AbortSignal,
): Promise<ArtifactRevisionPage> {
  const query = new URLSearchParams({ limit: '100', order });
  if (cursor !== undefined) query.set('cursor', cursor);
  const value = await requestJson(
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/revisions?${query}`,
    signal === undefined ? undefined : { signal },
  );
  if (!isArtifactRevisionPage(value)) {
    throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned an invalid response.');
  }
  return value;
}

export async function loadWorkspaceShares(
  workspaceId: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<SharePage> {
  const query = new URLSearchParams({ limit: '100' });
  if (cursor !== undefined) query.set('cursor', cursor);
  const value = await requestJson(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/shares?${query}`,
    signal === undefined ? undefined : { signal },
  );
  if (!isSharePage(value)) {
    throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned an invalid response.');
  }
  return value;
}

function isCommentPost(value: unknown): value is CommentPost {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.postId === 'string' &&
    typeof candidate.threadId === 'string' &&
    typeof candidate.body === 'string' &&
    typeof candidate.author === 'object' &&
    candidate.author !== null &&
    typeof candidate.permissions === 'object' &&
    candidate.permissions !== null &&
    typeof candidate.createdAt === 'string' &&
    (candidate.editedAt === null || typeof candidate.editedAt === 'string') &&
    (candidate.deletedAt === null || typeof candidate.deletedAt === 'string') &&
    (candidate.hiddenAt === null || typeof candidate.hiddenAt === 'string')
  );
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isCommentSummary(value: unknown): value is CommentSummary {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(candidate, [
      'artifactId',
      'participantCount',
      'participants',
      'openThreadCount',
      'openReplyCount',
      'latestActivityAt',
      'latestThreadId',
    ]) ||
    typeof candidate.artifactId !== 'string' ||
    candidate.artifactId.length === 0 ||
    !Number.isSafeInteger(candidate.participantCount) ||
    (candidate.participantCount as number) < 0 ||
    !Array.isArray(candidate.participants) ||
    !Number.isSafeInteger(candidate.openThreadCount) ||
    (candidate.openThreadCount as number) < 0 ||
    !Number.isSafeInteger(candidate.openReplyCount) ||
    (candidate.openReplyCount as number) < 0 ||
    (candidate.latestActivityAt !== null && !isIsoDate(candidate.latestActivityAt)) ||
    (candidate.latestThreadId !== null &&
      (typeof candidate.latestThreadId !== 'string' || candidate.latestThreadId.length === 0))
  ) {
    return false;
  }
  if (candidate.participants.length > 20) return false;
  return candidate.participants.every((participant) => {
    if (typeof participant !== 'object' || participant === null) return false;
    const item = participant as Record<string, unknown>;
    return (
      hasOnlyKeys(item, [
        'participantId',
        'displayName',
        'threadCount',
        'replyCount',
        'latestThreadId',
        'latestActivityAt',
        'recentThreads',
      ]) &&
      typeof item.participantId === 'string' &&
      item.participantId.length > 0 &&
      typeof item.displayName === 'string' &&
      item.displayName.length > 0 &&
      Number.isSafeInteger(item.threadCount) &&
      (item.threadCount as number) >= 0 &&
      Number.isSafeInteger(item.replyCount) &&
      (item.replyCount as number) >= 0 &&
      (item.latestThreadId === null ||
        (typeof item.latestThreadId === 'string' && item.latestThreadId.length > 0)) &&
      (item.latestActivityAt === null || isIsoDate(item.latestActivityAt)) &&
      Array.isArray(item.recentThreads) &&
      item.recentThreads.length <= COMMENT_SUMMARY_RECENT_THREAD_LIMIT &&
      item.recentThreads.every((recentThread) => {
        if (typeof recentThread !== 'object' || recentThread === null) return false;
        const thread = recentThread as Record<string, unknown>;
        return (
          hasOnlyKeys(thread, ['threadId', 'latestActivityAt']) &&
          typeof thread.threadId === 'string' &&
          thread.threadId.length > 0 &&
          isIsoDate(thread.latestActivityAt)
        );
      })
    );
  });
}

export async function loadArtifactCommentSummaries(
  workspaceId: string,
  artifactIds: readonly string[],
  signal?: AbortSignal,
): Promise<readonly CommentSummary[]> {
  const value = await requestJson(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/comments/summaries`,
    {
      ...jsonRequest('POST', { artifactIds }),
      ...(signal === undefined ? {} : { signal }),
    },
  );
  if (
    typeof value !== 'object' ||
    value === null ||
    !hasOnlyKeys(value as Record<string, unknown>, ['items']) ||
    !('items' in value) ||
    !Array.isArray(value.items) ||
    !value.items.every((item) => isCommentSummary(item))
  ) {
    throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned invalid comment summaries.');
  }
  const requested = new Set(artifactIds);
  const seen = new Set<string>();
  if (
    value.items.some(
      (item) =>
        !requested.has(item.artifactId) || seen.has(item.artifactId) || !seen.add(item.artifactId),
    )
  ) {
    throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned invalid comment summaries.');
  }
  return value.items;
}

function isShareManagementSummary(value: unknown): value is ShareManagementSummary {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.shareId === 'string' &&
    (candidate.accessType === 'protected' || candidate.accessType === 'public') &&
    typeof candidate.workspaceId === 'string' &&
    typeof candidate.artifactId === 'string'
  );
}

export async function loadArtifactComments(
  workspaceId: string,
  artifactId: string,
  currentRevisionId: string,
  signal?: AbortSignal,
  cursor?: string,
  limit?: number,
): Promise<CommentThreadPage> {
  const query = new URLSearchParams({ currentRevisionId });
  if (cursor !== undefined) query.set('cursor', cursor);
  if (limit !== undefined) query.set('limit', String(limit));
  const value = await requestJson(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}/comments?${query}`,
    signal === undefined ? undefined : { signal },
  );
  if (
    typeof value !== 'object' ||
    value === null ||
    !('items' in value) ||
    !Array.isArray(value.items) ||
    !value.items.every((item) => isCommentThread(item))
  ) {
    throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned invalid discussions.');
  }
  const nextCursor = 'nextCursor' in value ? value.nextCursor : undefined;
  if (typeof nextCursor !== 'string' && nextCursor !== null) {
    throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned an invalid discussion cursor.');
  }
  return { items: value.items as CommentThread[], nextCursor };
}

export async function createArtifactCommentReply(
  workspaceId: string,
  artifactId: string,
  threadId: string,
  body: string,
  displayName?: string,
): Promise<CommentPost> {
  const value = await requestJson(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}/comments/threads/${encodeURIComponent(threadId)}/replies`,
    jsonRequest('POST', {
      body,
      ...(displayName === undefined ? {} : { displayName }),
    }),
  );
  if (!isCommentPost(value)) {
    throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned an invalid discussion reply.');
  }
  return value;
}

export async function updateArtifactCommentThread(
  workspaceId: string,
  artifactId: string,
  threadId: string,
  status: 'resolve' | 'reopen',
): Promise<CommentThread> {
  const value = await requestJson(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}/comments/threads/${encodeURIComponent(threadId)}`,
    jsonRequest('PATCH', { status }),
  );
  if (!isCommentThread(value)) {
    throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned an invalid discussion.');
  }
  return value;
}

export type ArtifactCommentPostMutation =
  | { readonly moderation: 'hide' | 'unhide' }
  | { readonly action: 'edit'; readonly body: string }
  | { readonly action: 'delete' };

export async function updateArtifactCommentPost(
  workspaceId: string,
  artifactId: string,
  postId: string,
  mutation: ArtifactCommentPostMutation,
): Promise<CommentPost> {
  const value = await requestJson(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}/comments/posts/${encodeURIComponent(postId)}`,
    jsonRequest('PATCH', mutation),
  );
  if (!isCommentPost(value)) {
    throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned an invalid updated post.');
  }
  return value;
}

export async function setShareCommentPolicy(
  workspaceId: string,
  shareId: string,
  commentPolicy: CommentPolicy,
): Promise<ShareManagementSummary> {
  const value = await requestJson(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/shares/${encodeURIComponent(shareId)}/comment-policy`,
    jsonRequest('PATCH', { commentPolicy }),
  );
  if (!isShareManagementSummary(value)) {
    throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned an invalid share link.');
  }
  return value;
}

export async function ensureArtifactDefaultShares(
  workspaceId: string,
  artifactId: string,
  signal?: AbortSignal,
): Promise<ArtifactDefaultShares> {
  const value = await requestJson(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}/shares/defaults`,
    { method: 'POST', ...(signal === undefined ? {} : { signal }) },
  );
  if (
    !isArtifactDefaultShares(value) ||
    value.workspaceId !== workspaceId ||
    value.artifactId !== artifactId
  ) {
    throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned invalid default links.');
  }
  return value;
}

export async function loadFolderEntries(
  revisionId: string,
  signal?: AbortSignal,
): Promise<readonly FolderEntry[]> {
  const entries: FolderEntry[] = [];
  let cursor: string | undefined;
  const visited = new Set<string>();
  do {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor !== undefined) query.set('cursor', cursor);
    const value = await requestJson(
      `/api/v1/revisions/${encodeURIComponent(revisionId)}/tree?${query}`,
      signal === undefined ? undefined : { signal },
    );
    if (!isFolderTreePage(value) || value.revisionId !== revisionId) {
      throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned an invalid response.');
    }
    entries.push(...value.items);
    cursor = value.nextCursor ?? undefined;
    if (entries.length > 2_000 || (cursor !== undefined && visited.has(cursor))) {
      throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned an invalid response.');
    }
    if (cursor !== undefined) visited.add(cursor);
  } while (cursor !== undefined);
  return entries;
}

export async function loadFolderEntryBytes(
  revisionId: string,
  path: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const query = new URLSearchParams({ path });
  const response = await dashboardFetch(
    `/api/v1/revisions/${encodeURIComponent(revisionId)}/tree/content?${query}`,
    requestOptions(signal === undefined ? undefined : { signal }),
  );
  if (response.status === 401) throw new DashboardAuthenticationError();
  if (!response.ok) {
    throw new DashboardApiError('CONTENT_UNAVAILABLE', 'The folder file is unavailable.');
  }
  return response.arrayBuffer();
}

export async function loadRevisionBytes(
  revisionId: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await dashboardFetch(
    `/api/v1/revisions/${encodeURIComponent(revisionId)}/content`,
    requestOptions(signal === undefined ? undefined : { signal }),
  );
  if (response.status === 401) throw new DashboardAuthenticationError();
  if (!response.ok) {
    throw new DashboardApiError('CONTENT_UNAVAILABLE', 'The revision content is unavailable.');
  }
  return response.arrayBuffer();
}

export async function renameArtifact(artifactId: string, name: string): Promise<Artifact> {
  const value = await requestJson(
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}`,
    jsonRequest('PATCH', { name }),
  );
  if (!isArtifact(value)) {
    throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned an invalid response.');
  }
  return value;
}

export async function deleteArtifact(artifactId: string): Promise<ArtifactDeletionResult> {
  const value = await requestJson(
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}`,
    requestOptions({ method: 'DELETE' }),
  );
  if (!isArtifactDeletionResult(value)) {
    throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned an invalid response.');
  }
  return value;
}

export async function recoverArtifact(
  artifactId: string,
  idempotencyKey: string,
): Promise<Artifact> {
  const value = await requestJson(
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/recovery`,
    requestOptions({ method: 'POST', headers: { 'Idempotency-Key': idempotencyKey } }),
  );
  if (!isArtifact(value)) {
    throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned an invalid response.');
  }
  return value;
}

export async function restoreArtifact(
  workspaceId: string,
  artifactId: string,
  sourceRevisionId: string,
  idempotencyKey: string,
): Promise<RestoreResult> {
  const value = await requestJson(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}/restores`,
    jsonRequest('POST', { sourceRevisionId }, { 'idempotency-key': idempotencyKey }),
  );
  if (!isRestoreResult(value)) {
    throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned an invalid response.');
  }
  return value;
}

export async function createArtifactShare(
  workspaceId: string,
  artifactId: string,
  input: ShareCreateInput,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<ShareCreateResult> {
  const value = await requestJson(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}/shares`,
    {
      ...jsonRequest('POST', input, { 'idempotency-key': idempotencyKey }),
      ...(signal === undefined ? {} : { signal }),
    },
  );
  if (!isShareCreateResult(value)) {
    throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned an invalid response.');
  }
  return value;
}

export async function revokeShare(workspaceId: string, shareId: string): Promise<void> {
  const value = await requestJson(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/shares/${encodeURIComponent(shareId)}`,
    requestOptions({ method: 'DELETE' }),
  );
  if (
    typeof value !== 'object' ||
    value === null ||
    !('shareId' in value) ||
    value.shareId !== shareId ||
    !('revokedAt' in value) ||
    typeof value.revokedAt !== 'string'
  ) {
    throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned an invalid response.');
  }
}

export async function loadDashboardCredentials(
  workspaceId: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<DashboardCredentialPage> {
  const query = new URLSearchParams({ limit: '50', workspaceId });
  if (cursor !== undefined) query.set('cursor', cursor);
  const value = await requestJson(
    `/api/v1/access-credentials?${query}`,
    signal === undefined ? undefined : { signal },
  );
  if (!isDashboardCredentialPage(value)) {
    throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned an invalid response.');
  }
  return value;
}

export async function createDashboardCredential(
  request: DashboardCredentialIssueRequest,
): Promise<DashboardCredentialIssue> {
  const value = await requestJson('/api/v1/access-credentials', jsonRequest('POST', request));
  if (!isDashboardCredentialIssue(value)) {
    throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned an invalid response.');
  }
  return value;
}

export async function revokeDashboardCredential(
  credentialId: string,
): Promise<DashboardCredentialRevoke> {
  const value = await requestJson(
    `/api/v1/access-credentials/${encodeURIComponent(credentialId)}`,
    requestOptions({ method: 'DELETE' }),
  );
  if (!isDashboardCredentialRevoke(value)) {
    throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned an invalid response.');
  }
  return value;
}
