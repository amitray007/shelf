import { Button, LinkButton } from '@cloudflare/kumo/components/button';
import { ClipboardText } from '@cloudflare/kumo/components/clipboard-text';
import { DropdownMenu } from '@cloudflare/kumo/components/dropdown';
import { Input } from '@cloudflare/kumo/components/input';
import { Popover } from '@cloudflare/kumo/components/popover';
import { Table } from '@cloudflare/kumo/components/table';
import { CaretDownIcon } from '@phosphor-icons/react/CaretDown';
import { CaretUpIcon } from '@phosphor-icons/react/CaretUp';
import { CaretUpDownIcon } from '@phosphor-icons/react/CaretUpDown';
import { DotsThreeIcon } from '@phosphor-icons/react/DotsThree';
import { EyeIcon } from '@phosphor-icons/react/Eye';
import { ShareNetworkIcon } from '@phosphor-icons/react/ShareNetwork';
import { TerminalWindowIcon } from '@phosphor-icons/react/TerminalWindow';
import { TrashIcon } from '@phosphor-icons/react/Trash';
import type {
  Artifact,
  ArtifactDeletionResult,
  ArtifactPage,
  CommentSummary,
} from '@shelf/contracts';
import {
  type FocusEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Link,
  useLoaderData,
  useLocation,
  useNavigate,
  useParams,
  useRevalidator,
  useSearchParams,
} from 'react-router';
import { ReviewAvatarImage, ReviewParticipantAvatar } from '../components/review/comment-card.js';
import { isReviewThreadRead } from '../components/review/persistence.js';
import {
  DashboardApiError,
  loadArtifact,
  loadArtifactCommentSummaries,
  recoverArtifact,
} from './api.js';
import { ArtifactIcon } from './artifact-icon.js';
import { ArtifactShareDialog } from './artifact-share-dialog.js';
import { DeleteArtifactDialog } from './delete-artifact-dialog.js';
import './artifact.css';
import './artifact-index.css';

const dateLabelFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

function dateLabel(value: string): string {
  return dateLabelFormatter.format(new Date(value));
}

function retentionLabel(artifact: Artifact): string {
  if (artifact.retention.mode === 'keep') return 'Kept indefinitely';
  if (artifact.retention.trashAt === null) return 'Active custom share';
  const remaining = Date.parse(artifact.retention.trashAt) - Date.now();
  if (remaining <= 0) return 'Trash pending';
  const days = Math.ceil(remaining / (24 * 60 * 60 * 1_000));
  return `Trash in ${days} ${days === 1 ? 'day' : 'days'}`;
}

const COMMENT_HOVER_OPEN_DELAY = 120;
const COMMENT_HOVER_CLOSE_DELAY = 100;

function ArtifactCommentsPopover({
  artifactName,
  children,
  summary,
}: {
  readonly artifactName: string;
  readonly children: (descriptionId: string | undefined) => ReactNode;
  readonly summary: CommentSummary;
}) {
  const anchorRef = useRef<HTMLFieldSetElement>(null);
  const openTimerRef = useRef<number | undefined>(undefined);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const descriptionId = useId();
  const clearTimers = () => {
    if (openTimerRef.current !== undefined) window.clearTimeout(openTimerRef.current);
    if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current);
    openTimerRef.current = undefined;
    closeTimerRef.current = undefined;
  };
  const openImmediately = () => {
    clearTimers();
    setOpen(true);
  };
  const openOnHover = () => {
    if (open || openTimerRef.current !== undefined) return;
    if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = undefined;
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = undefined;
      setOpen(true);
    }, COMMENT_HOVER_OPEN_DELAY);
  };
  const closeSoon = () => {
    if (openTimerRef.current !== undefined) window.clearTimeout(openTimerRef.current);
    openTimerRef.current = undefined;
    if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = undefined;
      setOpen(false);
    }, COMMENT_HOVER_CLOSE_DELAY);
  };
  useEffect(
    () => () => {
      if (openTimerRef.current !== undefined) window.clearTimeout(openTimerRef.current);
      if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current);
    },
    [],
  );
  const handleAnchorBlur = (event: FocusEvent<HTMLFieldSetElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    closeSoon();
  };
  const visibleParticipants = summary.participants.slice(0, 6);
  const additionalParticipantCount = Math.max(
    0,
    summary.participantCount - visibleParticipants.length,
  );
  const participantLabel = summary.participantCount === 1 ? 'participant' : 'participants';
  const discussionLabel = summary.openThreadCount === 1 ? 'open discussion' : 'open discussions';
  const replyLabel = summary.openReplyCount === 1 ? 'open reply' : 'open replies';

  return (
    <Popover
      onOpenChange={(nextOpen) => {
        clearTimers();
        setOpen(nextOpen);
      }}
      open={open}
    >
      <fieldset
        aria-label="Comment activity"
        className="artifact-comments-anchor"
        onBlur={handleAnchorBlur}
        onFocus={openImmediately}
        onPointerEnter={openOnHover}
        onPointerLeave={closeSoon}
        ref={anchorRef}
      >
        {children(open ? descriptionId : undefined)}
      </fieldset>
      <Popover.Content
        align="start"
        anchor={anchorRef}
        className="artifact-comments-popover"
        side="bottom"
        sideOffset={6}
      >
        <div
          className="artifact-comments-popover-body"
          id={descriptionId}
          onPointerEnter={() => {
            if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current);
            closeTimerRef.current = undefined;
          }}
          onPointerLeave={closeSoon}
        >
          <Popover.Title className="artifact-comments-popover-title">
            Comment activity
          </Popover.Title>
          <Popover.Description className="artifact-comments-popover-artifact">
            {artifactName}
          </Popover.Description>
          <div className="artifact-comments-popover-stats">
            <span>
              <strong>{summary.participantCount}</strong> {participantLabel}
            </span>
            <span>
              <strong>{summary.openThreadCount}</strong> {discussionLabel}
            </span>
            {summary.openReplyCount > 0 ? (
              <span>
                <strong>{summary.openReplyCount}</strong> {replyLabel}
              </span>
            ) : null}
          </div>
          <ul className="artifact-comments-popover-participants">
            {visibleParticipants.map((participant) => (
              <li key={participant.participantId}>
                <ReviewAvatarImage alt="" participantId={participant.participantId} size={20} />
                <span className="artifact-comments-popover-participant-name">
                  {participant.displayName}
                </span>
                <span className="artifact-comments-popover-participant-meta">
                  {participant.threadCount}{' '}
                  {participant.threadCount === 1 ? 'discussion' : 'discussions'}
                  {participant.replyCount > 0
                    ? ` · ${participant.replyCount} ${participant.replyCount === 1 ? 'reply' : 'replies'}`
                    : ''}
                </span>
              </li>
            ))}
          </ul>
          {additionalParticipantCount > 0 ? (
            <span className="artifact-comments-popover-more">
              +{additionalParticipantCount} more{' '}
              {additionalParticipantCount === 1 ? 'participant' : 'participants'}
            </span>
          ) : null}
        </div>
      </Popover.Content>
    </Popover>
  );
}

export function ArtifactsPage() {
  const page = useLoaderData() as ArtifactPage;
  const workspaceId = useParams().workspaceId;
  if (workspaceId === undefined) throw new Error('Artifact workspace is unavailable.');
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const searchQuery = searchParams.get('search')?.trim() ?? '';
  const [searchInput, setSearchInput] = useState(searchQuery);
  const revalidator = useRevalidator();
  const [shareArtifact, setShareArtifact] = useState<Artifact>();
  const [deletingArtifact, setDeletingArtifact] = useState<Artifact>();
  const [hiddenArtifactIds, setHiddenArtifactIds] = useState<ReadonlySet<string>>(new Set());
  const [recentDeletion, setRecentDeletion] = useState<{
    artifact: Artifact;
    result: ArtifactDeletionResult;
    recoveryKey: string;
  }>();
  const [recoveredArtifacts, setRecoveredArtifacts] = useState<ReadonlyMap<string, Artifact>>(
    new Map(),
  );
  const [recovering, setRecovering] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string>();
  useEffect(() => {
    if (recentDeletion === undefined) return;
    const timeout = window.setTimeout(() => {
      setRecentDeletion(undefined);
      setRecoveryError(undefined);
    }, 6000);
    return () => window.clearTimeout(timeout);
  }, [recentDeletion]);
  const sort = searchParams.get('sort') === 'created' ? 'created' : 'updated';
  const order = searchParams.get('order') === 'asc' ? 'asc' : 'desc';
  useEffect(() => {
    setSearchInput(searchQuery);
  }, [searchQuery]);
  useEffect(() => {
    const value = searchInput.trim();
    if (value === searchQuery) return;
    const timeout = window.setTimeout(() => {
      const next = new URLSearchParams(location.search);
      next.delete('cursor');
      if (value.length === 0) next.delete('search');
      else next.set('search', value);
      void navigate(`${location.pathname}?${next}`, { replace: true, state: null });
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [location.pathname, location.search, navigate, searchInput, searchQuery]);
  const paginationState = location.state as { artifactCursorTrail?: unknown } | null;
  const cursorTrail = Array.isArray(paginationState?.artifactCursorTrail)
    ? paginationState.artifactCursorTrail.filter(
        (candidate): candidate is string => typeof candidate === 'string',
      )
    : [];
  const normalizedSearch = searchQuery.toLocaleLowerCase();
  const matchesSearch = (artifact: Artifact) => {
    if (normalizedSearch.length === 0) return true;
    const sourceName =
      artifact.latestRevision.kind === 'file'
        ? artifact.latestRevision.originalFileName
        : artifact.latestRevision.rootName;
    return [
      artifact.name,
      artifact.latestRevision.publisherMetadata.title,
      artifact.latestRevision.publisherMetadata.description,
      sourceName,
    ].some((value) => value?.toLocaleLowerCase().includes(normalizedSearch) === true);
  };
  const loadedArtifactIds = new Set(page.items.map((artifact) => artifact.artifactId));
  const visibleArtifacts = [
    ...[...recoveredArtifacts.values()].filter(
      (artifact) => !loadedArtifactIds.has(artifact.artifactId) && matchesSearch(artifact),
    ),
    ...page.items.filter(matchesSearch),
  ]
    .filter((artifact) => !hiddenArtifactIds.has(artifact.artifactId))
    .sort((left, right) => {
      const leftTimestamp = sort === 'created' ? left.createdAt : left.updatedAt;
      const rightTimestamp = sort === 'created' ? right.createdAt : right.updatedAt;
      return (
        (order === 'asc' ? 1 : -1) * leftTimestamp.localeCompare(rightTimestamp) ||
        left.artifactId.localeCompare(right.artifactId)
      );
    })
    .slice(0, 10);
  const visibleArtifactKey = visibleArtifacts.map((artifact) => artifact.artifactId).join('\u0000');
  const visibleArtifactIds = useMemo(
    () => (visibleArtifactKey.length === 0 ? [] : visibleArtifactKey.split('\u0000')),
    [visibleArtifactKey],
  );
  const [commentSummaries, setCommentSummaries] = useState<ReadonlyMap<string, CommentSummary>>(
    new Map(),
  );
  useEffect(() => {
    const controller = new AbortController();
    if (visibleArtifactIds.length === 0) {
      setCommentSummaries(new Map());
      return () => controller.abort();
    }
    void loadArtifactCommentSummaries(workspaceId, visibleArtifactIds, controller.signal)
      .then((summaries) => {
        if (controller.signal.aborted) return;
        setCommentSummaries(new Map(summaries.map((summary) => [summary.artifactId, summary])));
      })
      .catch(() => {
        if (!controller.signal.aborted) setCommentSummaries(new Map());
      });
    return () => controller.abort();
  }, [visibleArtifactIds, workspaceId]);
  const sortPath = (field: 'created' | 'updated') => {
    const next = new URLSearchParams(searchParams);
    next.delete('cursor');
    next.set('sort', field);
    next.set('order', sort === field && order === 'desc' ? 'asc' : 'desc');
    return `?${next}`;
  };
  const sortIcon = (field: 'created' | 'updated') =>
    sort !== field ? CaretUpDownIcon : order === 'asc' ? CaretUpIcon : CaretDownIcon;
  const nextPagePath = () => {
    if (page.nextCursor === null) return undefined;
    const next = new URLSearchParams(searchParams);
    next.set('cursor', page.nextCursor);
    return `?${next}`;
  };
  const CreatedSortIcon = sortIcon('created');
  const UpdatedSortIcon = sortIcon('updated');
  const nextPath = nextPagePath();
  const currentPath = `${location.pathname}${location.search}`;
  const previousPath = cursorTrail.at(-1);
  const showRecoveredArtifact = (artifact: Artifact) => {
    setRecoveredArtifacts((current) => new Map(current).set(artifact.artifactId, artifact));
    setHiddenArtifactIds((current) => {
      const next = new Set(current);
      next.delete(artifact.artifactId);
      return next;
    });
    setRecentDeletion(undefined);
    void revalidator.revalidate();
  };
  const undoDeletion = async () => {
    if (recentDeletion === undefined) return;
    setRecovering(true);
    setRecoveryError(undefined);
    try {
      const recovered = await recoverArtifact(
        recentDeletion.artifact.artifactId,
        recentDeletion.recoveryKey,
      );
      showRecoveredArtifact(recovered.artifact);
    } catch (caught) {
      if (caught instanceof DashboardApiError && caught.code === 'ARTIFACT_NOT_FOUND') {
        try {
          showRecoveredArtifact(await loadArtifact(recentDeletion.artifact.artifactId));
          return;
        } catch {
          // Preserve the original recovery failure when the artifact is still unavailable.
        }
      }
      setRecoveryError(caught instanceof DashboardApiError ? caught.message : 'Recovery failed.');
    } finally {
      setRecovering(false);
    }
  };

  return (
    <div className="dashboard-page artifact-index">
      <header className="page-heading">
        <div>
          <h1>Artifacts</h1>
          <p>Published files and folders.</p>
        </div>
        <div className="cli-publish-hint">
          <div className="cli-publish-label">
            <TerminalWindowIcon aria-hidden="true" size={15} />
            <span>Publish from a terminal</span>
          </div>
          <ClipboardText
            className="cli-clipboard"
            labels={{ copyAction: 'Copy publish command' }}
            size="sm"
            text="shelf publish ./path --share"
            tooltip={{ copiedText: 'Command copied', text: 'Copy command' }}
          />
        </div>
      </header>

      {recentDeletion === undefined ? null : (
        <div aria-live="polite" className="artifact-deletion-toast" role="status">
          <div>
            <strong>{recentDeletion.artifact.name} deleted</strong>
            <span>
              Recoverable until {dateLabel(recentDeletion.result.recoverableUntil)}. Share links
              were revoked.
            </span>
            {recoveryError === undefined ? null : <span role="alert">{recoveryError}</span>}
          </div>
          <Button
            disabled={recovering}
            loading={recovering}
            onClick={undoDeletion}
            size="sm"
            type="button"
            variant="secondary"
          >
            {recovering ? 'Recovering…' : 'Undo deletion'}
          </Button>
        </div>
      )}

      {visibleArtifacts.length === 0 ? (
        <section className="artifact-index-empty">
          <p className="empty-kicker">Nothing here yet</p>
          <h2>Publish your first artifact from the CLI.</h2>
          <ClipboardText
            className="cli-clipboard"
            labels={{ copyAction: 'Copy first publish command' }}
            size="sm"
            text="shelf publish ./idea.html --share"
          />
        </section>
      ) : (
        <>
          <search className="artifact-search">
            <div className="artifact-search-form">
              <Input
                aria-label="Search artifacts"
                onChange={(event) => setSearchInput(event.currentTarget.value)}
                placeholder="Title, description, or filename"
                value={searchInput}
              />
            </div>
          </search>
          <div className="artifact-table-wrap">
            <Table aria-label="Artifacts" className="artifact-table" layout="fixed">
              <colgroup>
                <col className="artifact-name-column" />
                <col className="artifact-comments-column" />
                <col className="artifact-created-column" />
                <col className="artifact-updated-column" />
                <col className="artifact-actions-column" />
              </colgroup>
              <Table.Header variant="compact">
                <Table.Row>
                  <Table.Head>Artifact</Table.Head>
                  <Table.Head className="artifact-comments-cell">Comments</Table.Head>
                  <Table.Head
                    aria-sort={
                      sort === 'created'
                        ? order === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : undefined
                    }
                    className="artifact-created-cell"
                  >
                    <Link className="artifact-sort-link" to={sortPath('created')}>
                      Created on
                      <CreatedSortIcon aria-hidden="true" size={12} />
                    </Link>
                  </Table.Head>
                  <Table.Head
                    aria-sort={
                      sort === 'updated'
                        ? order === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : undefined
                    }
                    className="artifact-updated-cell"
                  >
                    <Link className="artifact-sort-link" to={sortPath('updated')}>
                      Last Updated
                      <UpdatedSortIcon aria-hidden="true" size={12} />
                    </Link>
                  </Table.Head>
                  <Table.Head className="artifact-actions-cell">
                    <span className="visually-hidden">Actions</span>
                  </Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {visibleArtifacts.map((artifact) => {
                  const artifactPath = `/app/w/${encodeURIComponent(artifact.workspaceId)}/artifacts/${encodeURIComponent(artifact.artifactId)}`;
                  const metadataTitle = artifact.latestRevision.publisherMetadata.title?.trim();
                  const displayTitle =
                    metadataTitle === undefined || metadataTitle.length === 0
                      ? artifact.name
                      : metadataTitle;
                  const sourceName =
                    artifact.latestRevision.kind === 'file'
                      ? artifact.latestRevision.originalFileName
                      : artifact.latestRevision.rootName;
                  return (
                    <Table.Row
                      className="artifact-ledger-row"
                      key={artifact.artifactId}
                      onClick={(event) => {
                        const target = event.target;
                        if (
                          target instanceof Element &&
                          target.closest(
                            'a, button, input, select, textarea, [role="menuitem"]',
                          ) !== null
                        ) {
                          return;
                        }
                        void navigate(artifactPath);
                      }}
                    >
                      <Table.Cell>
                        <div className="artifact-ledger-name">
                          <ArtifactIcon kind={artifact.kind} name={sourceName} />
                          <span>
                            <Link title={displayTitle} to={artifactPath}>
                              {displayTitle}
                            </Link>
                            <span className="artifact-ledger-secondary">
                              <span title={sourceName}>{sourceName}</span>
                              <span aria-hidden="true">·</span>
                              <code title={artifact.artifactId}>{artifact.artifactId}</code>
                              <span aria-hidden="true">·</span>
                              <span title={artifact.retention.trashAt ?? undefined}>
                                {retentionLabel(artifact)}
                              </span>
                            </span>
                          </span>
                        </div>
                      </Table.Cell>
                      <Table.Cell className="artifact-comments-cell">
                        {(() => {
                          const summary = commentSummaries.get(artifact.artifactId);
                          if (summary === undefined || summary.participantCount === 0) {
                            return (
                              <span className="artifact-comments-empty" title="No comments">
                                —
                              </span>
                            );
                          }
                          // With exactly four participants the fourth avatar costs the same
                          // width as a "+1" chip, so show the person instead.
                          const participants = summary.participants.slice(
                            0,
                            summary.participantCount === 4 ? 4 : 3,
                          );
                          const overflowCount = Math.max(
                            0,
                            summary.participantCount - participants.length,
                          );
                          const artifactCommentPath = `${artifactPath}?discussion=1`;
                          const openParticipant = (participant: (typeof participants)[number]) => {
                            const unreadThread = participant.recentThreads.find(
                              (thread) =>
                                !isReviewThreadRead(
                                  artifact.artifactId,
                                  thread.threadId,
                                  thread.latestActivityAt,
                                ),
                            );
                            const threadId = unreadThread?.threadId ?? participant.latestThreadId;
                            if (threadId === null) return;
                            void navigate(
                              `${artifactPath}?discussion=1&thread=${encodeURIComponent(threadId)}`,
                            );
                          };
                          return (
                            <ArtifactCommentsPopover artifactName={artifact.name} summary={summary}>
                              {(descriptionId) => (
                                <div className="artifact-comments">
                                  {participants.map((participant) => (
                                    <ReviewParticipantAvatar
                                      ariaDescribedBy={descriptionId}
                                      key={participant.participantId}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        openParticipant(participant);
                                      }}
                                      participant={participant}
                                    />
                                  ))}
                                  {overflowCount > 0 ? (
                                    <button
                                      aria-describedby={descriptionId}
                                      aria-label={`Open all comments for ${artifact.name}`}
                                      className="artifact-comments-overflow"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        void navigate(artifactCommentPath);
                                      }}
                                      type="button"
                                    >
                                      <span aria-hidden="true">+</span>
                                      {overflowCount}
                                    </button>
                                  ) : null}
                                </div>
                              )}
                            </ArtifactCommentsPopover>
                          );
                        })()}
                      </Table.Cell>
                      <Table.Cell className="artifact-created-cell">
                        <time dateTime={artifact.createdAt}>{dateLabel(artifact.createdAt)}</time>
                      </Table.Cell>
                      <Table.Cell className="artifact-updated-cell">
                        <time dateTime={artifact.updatedAt}>{dateLabel(artifact.updatedAt)}</time>
                      </Table.Cell>
                      <Table.Cell className="artifact-actions-cell">
                        <div className="artifact-row-actions">
                          <LinkButton
                            aria-label={`Preview artifact ${displayTitle}`}
                            href={`/preview/${encodeURIComponent(artifact.artifactId)}`}
                            icon={EyeIcon}
                            rel="noopener noreferrer"
                            shape="square"
                            size="sm"
                            target="_blank"
                            variant="ghost"
                          />
                          <Button
                            aria-label={`Share artifact ${displayTitle}`}
                            icon={ShareNetworkIcon}
                            onClick={() => setShareArtifact(artifact)}
                            shape="square"
                            size="sm"
                            variant="ghost"
                          />
                          <DropdownMenu>
                            <DropdownMenu.Trigger
                              render={
                                <Button
                                  aria-label={`More actions for ${displayTitle}`}
                                  icon={DotsThreeIcon}
                                  shape="square"
                                  size="sm"
                                  variant="ghost"
                                />
                              }
                            />
                            <DropdownMenu.Content align="end">
                              <DropdownMenu.Item
                                icon={TrashIcon}
                                onClick={() => setDeletingArtifact(artifact)}
                                variant="danger"
                              >
                                Delete artifact
                              </DropdownMenu.Item>
                            </DropdownMenu.Content>
                          </DropdownMenu>
                        </div>
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          </div>
        </>
      )}

      {previousPath === undefined && page.nextCursor === null ? null : (
        <footer className="pagination">
          <span>Page {cursorTrail.length + 1}</span>
          <div>
            {previousPath === undefined ? null : (
              <Link
                className="control"
                state={{ artifactCursorTrail: cursorTrail.slice(0, -1) }}
                to={previousPath}
              >
                Previous
              </Link>
            )}
            {nextPath === undefined ? null : (
              <Link
                className="control"
                state={{ artifactCursorTrail: [...cursorTrail, currentPath] }}
                to={nextPath}
              >
                Next
              </Link>
            )}
          </div>
        </footer>
      )}
      {shareArtifact === undefined ? null : (
        <ArtifactShareDialog
          artifact={shareArtifact}
          onOpenChange={(open) => {
            if (!open) setShareArtifact(undefined);
          }}
          open
        />
      )}
      <DeleteArtifactDialog
        artifact={deletingArtifact}
        onDeleted={(artifact, result) => {
          setDeletingArtifact(undefined);
          setHiddenArtifactIds((current) => new Set(current).add(artifact.artifactId));
          setRecentDeletion({ artifact, result, recoveryKey: crypto.randomUUID() });
          void revalidator.revalidate();
        }}
        onOpenChange={(open) => {
          if (!open) setDeletingArtifact(undefined);
        }}
      />
    </div>
  );
}
