import type {
  Artifact,
  ArtifactPage,
  ArtifactRevision,
  ArtifactRevisionPage,
  CommentThread,
  DashboardCredentialPage,
  DashboardSession,
  FolderEntry,
  SharePage,
  TrashPage,
} from '@shelf/contracts';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { redirect } from 'react-router';

import { prefetchRendererModules, selectRenderer, supportsSourceView } from '../rendering.js';
import {
  DashboardApiError,
  DashboardAuthenticationError,
  loadArtifact,
  loadArtifactComments,
  loadArtifactHistory,
  loadArtifacts,
  loadDashboardCredentials,
  loadDashboardSession,
  loadFolderEntries,
  loadRevisionBytes,
  loadTrash,
  loadWorkspaceShares,
  signIn,
} from './api.js';

export interface ArtifactDetailPayload {
  artifact: Artifact;
  revision: ArtifactRevision;
  history: ArtifactRevisionPage;
  shares: SharePage;
  bytes: ArrayBuffer | null;
  entries: readonly FolderEntry[];
  comments: readonly CommentThread[];
  commentsNextCursor: string | null;
}

export interface ArtifactPreviewPayload {
  artifact: Artifact;
  revision: ArtifactRevision;
  bytes: ArrayBuffer | null;
  entries: readonly FolderEntry[];
}

export function safeReturnPath(value: string | null): string {
  if (
    value === null ||
    (!value.startsWith('/app') && !value.startsWith('/preview/')) ||
    value.startsWith('//')
  ) {
    return '/app';
  }
  return value;
}

function signInRedirect(request: Request): Response {
  const url = new URL(request.url);
  const returnTo = `${url.pathname}${url.search}`;
  return redirect(`/signin?returnTo=${encodeURIComponent(returnTo)}`);
}

async function withSessionRedirect<T>(request: Request, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DashboardAuthenticationError) throw signInRedirect(request);
    throw error;
  }
}

export async function signInLoader({ request }: LoaderFunctionArgs): Promise<null> {
  try {
    await loadDashboardSession(request.signal);
    const returnTo = safeReturnPath(new URL(request.url).searchParams.get('returnTo'));
    throw redirect(returnTo);
  } catch (error) {
    if (error instanceof DashboardAuthenticationError) return null;
    throw error;
  }
}

export async function signInAction({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const email = form.get('email');
  const password = form.get('password');
  const returnTo = safeReturnPath(new URL(request.url).searchParams.get('returnTo'));
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return { error: 'Enter the owner email and password.' };
  }
  try {
    await signIn(email, password);
    throw redirect(returnTo);
  } catch (error) {
    if (error instanceof DashboardApiError) return { error: error.message };
    throw error;
  }
}

export function dashboardLoader({ request }: LoaderFunctionArgs): Promise<DashboardSession> {
  return withSessionRedirect(request, () => loadDashboardSession(request.signal));
}

export async function dashboardIndexLoader({ request }: LoaderFunctionArgs) {
  const session = await withSessionRedirect(request, () => loadDashboardSession(request.signal));
  const workspace = session.workspaces.find((candidate) =>
    candidate.actions.includes('revision.read'),
  );
  throw redirect(
    workspace === undefined
      ? '/app/access'
      : `/app/w/${encodeURIComponent(workspace.workspaceId)}/artifacts`,
  );
}

export function artifactsLoader({ params, request }: LoaderFunctionArgs): Promise<ArtifactPage> {
  const workspaceId = params.workspaceId ?? '';
  const query = new URL(request.url).searchParams;
  const cursor = query.get('cursor') ?? undefined;
  const sort = query.get('sort') === 'created' ? 'created' : 'updated';
  const order = query.get('order') === 'asc' ? 'asc' : 'desc';
  const search = query.get('search')?.trim() || undefined;
  return withSessionRedirect(request, () =>
    loadArtifacts(workspaceId, cursor, request.signal, sort, order, search),
  );
}

export function trashLoader({ params, request }: LoaderFunctionArgs): Promise<TrashPage> {
  const workspaceId = params.workspaceId ?? '';
  const query = new URL(request.url).searchParams;
  const cursor = query.get('cursor') ?? undefined;
  const search = query.get('search')?.trim() || undefined;
  return withSessionRedirect(request, () => loadTrash(workspaceId, cursor, request.signal, search));
}

export function accessLoader({
  params,
  request,
}: LoaderFunctionArgs): Promise<DashboardCredentialPage> {
  const workspaceId = params.workspaceId;
  const cursor = new URL(request.url).searchParams.get('cursor') ?? undefined;
  if (workspaceId === undefined) {
    return Promise.resolve({ apiVersion: 'v1', items: [], nextCursor: null });
  }
  return withSessionRedirect(request, () =>
    loadDashboardCredentials(workspaceId, cursor, request.signal),
  );
}

export async function artifactLoader({
  params,
  request,
}: LoaderFunctionArgs): Promise<ArtifactDetailPayload> {
  const workspaceId = params.workspaceId ?? '';
  const artifactId = params.artifactId ?? '';
  return withSessionRedirect(request, async () => {
    const query = new URL(request.url).searchParams;
    const historyCursor = query.get('historyCursor') ?? undefined;
    const historyOrder = query.get('historyOrder') === 'oldest' ? 'oldest' : 'newest';
    const shareCursor = query.get('shareCursor') ?? undefined;
    const artifact = await loadArtifact(artifactId, request.signal);
    if (artifact.workspaceId !== workspaceId) {
      throw new DashboardApiError('ARTIFACT_NOT_FOUND', 'The artifact was not found.');
    }
    const [history, shares] = await Promise.all([
      loadArtifactHistory(artifactId, historyOrder, historyCursor, request.signal),
      loadWorkspaceShares(workspaceId, shareCursor, request.signal),
    ]);
    const requestedRevisionId = query.get('revision');
    const revision =
      requestedRevisionId === null
        ? artifact.latestRevision
        : (history.items.find((candidate) => candidate.revisionId === requestedRevisionId) ??
          artifact.latestRevision);
    const commentsPromise = loadArtifactComments(
      workspaceId,
      artifactId,
      revision.revisionId,
      request.signal,
    );
    prefetchRendererModules(revision);
    const contentPromise =
      revision.kind === 'folder'
        ? loadFolderEntries(revision.revisionId, request.signal).then((entries) => ({
            bytes: null,
            entries,
          }))
        : (() => {
            const renderer = selectRenderer(revision.mediaType, undefined);
            if (
              ['text', 'json', 'markdown', 'image'].includes(renderer.kind) ||
              supportsSourceView(revision.mediaType)
            ) {
              return loadRevisionBytes(revision.revisionId, request.signal).then((bytes) => ({
                bytes,
                entries: [] as readonly FolderEntry[],
              }));
            }
            return Promise.resolve({ bytes: null, entries: [] as readonly FolderEntry[] });
          })();
    const [comments, content] = await Promise.all([commentsPromise, contentPromise]);
    return {
      artifact,
      revision,
      history,
      shares,
      ...content,
      comments: comments.items,
      commentsNextCursor: comments.nextCursor,
    };
  });
}

export async function artifactPreviewLoader({
  params,
  request,
}: LoaderFunctionArgs): Promise<ArtifactPreviewPayload> {
  const artifactId = params.artifactId ?? '';
  return withSessionRedirect(request, async () => {
    const artifact = await loadArtifact(artifactId, request.signal);
    const requestedRevisionId = new URL(request.url).searchParams.get('revision');
    let revision = artifact.latestRevision;
    if (
      requestedRevisionId !== null &&
      requestedRevisionId !== artifact.latestRevision.revisionId
    ) {
      let cursor: string | undefined;
      const visited = new Set<string>();
      let requestedRevision: ArtifactRevision | undefined;
      do {
        const page = await loadArtifactHistory(artifactId, 'newest', cursor, request.signal);
        if (page.artifactId !== artifactId || page.workspaceId !== artifact.workspaceId) {
          throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned an invalid response.');
        }
        requestedRevision = page.items.find(
          (candidate) => candidate.revisionId === requestedRevisionId,
        );
        cursor = requestedRevision === undefined ? (page.nextCursor ?? undefined) : undefined;
        if (cursor !== undefined && visited.has(cursor)) {
          throw new DashboardApiError('INVALID_RESPONSE', 'Shelf returned a repeated cursor.');
        }
        if (cursor !== undefined) visited.add(cursor);
      } while (cursor !== undefined);
      if (requestedRevision === undefined) {
        throw new DashboardApiError('REVISION_NOT_FOUND', 'The revision was not found.');
      }
      revision = requestedRevision;
    }
    let bytes: ArrayBuffer | null = null;
    let entries: readonly FolderEntry[] = [];
    prefetchRendererModules(revision);
    if (revision.kind === 'folder') {
      entries = await loadFolderEntries(revision.revisionId, request.signal);
    } else {
      const renderer = selectRenderer(revision.mediaType, undefined);
      if (
        ['text', 'json', 'markdown', 'image'].includes(renderer.kind) ||
        supportsSourceView(revision.mediaType)
      ) {
        bytes = await loadRevisionBytes(revision.revisionId, request.signal);
      }
    }
    return { artifact, revision, bytes, entries };
  });
}
