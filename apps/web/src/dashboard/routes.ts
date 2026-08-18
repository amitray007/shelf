import type {
  Artifact,
  ArtifactPage,
  ArtifactRevision,
  ArtifactRevisionPage,
  DashboardCredentialPage,
  DashboardSession,
  FolderEntry,
  SharePage,
} from '@shelf/contracts';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { redirect } from 'react-router';

import { selectRenderer } from '../rendering.js';
import {
  DashboardApiError,
  DashboardAuthenticationError,
  loadArtifact,
  loadArtifactHistory,
  loadArtifacts,
  loadDashboardCredentials,
  loadDashboardSession,
  loadFolderEntries,
  loadRevisionBytes,
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
}

export function safeReturnPath(value: string | null): string {
  if (value === null || !value.startsWith('/app') || value.startsWith('//')) return '/app';
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
  return withSessionRedirect(request, () =>
    loadArtifacts(workspaceId, cursor, request.signal, sort, order),
  );
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
    let bytes: ArrayBuffer | null = null;
    let entries: readonly FolderEntry[] = [];
    if (revision.kind === 'folder') {
      entries = await loadFolderEntries(revision.revisionId, request.signal);
    } else {
      const renderer = selectRenderer(revision.mediaType, undefined);
      if (['text', 'json', 'markdown', 'image'].includes(renderer.kind)) {
        bytes = await loadRevisionBytes(revision.revisionId, request.signal);
      }
    }
    return { artifact, revision, history, shares, bytes, entries };
  });
}
