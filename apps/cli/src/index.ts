#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { CLI_EXIT_CODES } from '@shelf/contracts';
import { Command, CommanderError } from 'commander';
import {
  type ArtifactHistoryCommandOptions,
  type DeleteArtifactCommandOptions,
  executeArtifactHistory,
  executeDeleteArtifact,
  executeListArtifacts,
  executeRecoverArtifact,
  executeRenameArtifact,
  executeRestoreArtifact,
  executeShowArtifact,
  type ListArtifactsCommandOptions,
  type RecoverArtifactCommandOptions,
  type RenameArtifactCommandOptions,
  type RestoreArtifactCommandOptions,
  type ShowArtifactCommandOptions,
} from './commands/artifacts.js';
import {
  type CommentSummariesCommandOptions,
  executeCommentSummaries,
  executeHideComment,
  executeListComments,
  executeReopenComment,
  executeReplyComment,
  executeResolveComment,
  executeUnhideComment,
  type ListCommentsCommandOptions,
  type PostModerationCommandOptions,
  type ReplyCommentCommandOptions,
  type ThreadStatusCommandOptions,
} from './commands/comments.js';
import {
  executeFolderDownload,
  executeFolderTree,
  executePublishFolder,
  type FolderDownloadCommandOptions,
  type FolderTreeCommandOptions,
  type PublishFolderCommandOptions,
} from './commands/folders.js';
import { executePublish, type PublishCommandOptions } from './commands/publish.js';
import {
  executePublishWorkflow,
  type PublishWorkflowOptions,
} from './commands/publish-workflow.js';
import {
  type CompareRevisionsCommandOptions,
  type DownloadRevisionCommandOptions,
  executeCompareRevisions,
  executeDownloadRevision,
} from './commands/revisions.js';
import {
  type CreateShareCommandOptions,
  type DefaultSharesCommandOptions,
  executeCreateShare,
  executeDefaultShares,
  executeListShares,
  executeRevokeShare,
  executeSetShareCommentPolicy,
  type ListSharesCommandOptions,
  type RevokeShareCommandOptions,
  type ShareCommentsCommandOptions,
} from './commands/shares.js';
import {
  CliFailure,
  CliPartialFailure,
  failure,
  jsonLine,
  redactEnvelope,
  redactValue,
  usageFailure,
} from './output.js';
import {
  executeListProfiles,
  executeRemoveProfile,
  executeSetProfile,
  executeShowProfile,
  type SetProfileOptions,
} from './profiles.js';
import type { CliRuntime } from './runtime.js';

export type { CliRuntime } from './runtime.js';

type PublishCliOptions = Partial<PublishCommandOptions> & Omit<PublishWorkflowOptions, 'path'>;

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export async function runCli(
  argv: readonly string[],
  runtime: CliRuntime = {
    env: process.env,
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
  },
): Promise<number> {
  const program = new Command()
    .name('shelf')
    .description('Publish, version, inspect, and share Shelf artifacts')
    .showHelpAfterError(false)
    .showSuggestionAfterError(false)
    .exitOverride()
    .configureOutput({ writeOut: runtime.stdout, writeErr() {} })
    .allowExcessArguments(false);

  program.addHelpText(
    'after',
    `
Agent workflow:
  1. Configure a profile: shelf profiles set default --url <url> --workspace <id> --credential-env SHELF_TOKEN
  2. Publish with context: shelf publish ./report.md --title "Report" --description "What this artifact contains"
  3. Inspect JSON output or use: shelf artifacts list --profile default

Context and authentication:
  Every remote command accepts --profile <name> to resolve the installation URL, workspace, and
  credential from a configured profile. Without --profile, pass --url (and --workspace where the
  command is workspace-scoped) and export SHELF_TOKEN. Mixing --profile with --url, --workspace,
  or --allow-insecure-loopback is a usage error. Never pass tokens as arguments.

Output:
  Success writes one JSON document to stdout. Errors write one redacted JSON document to stderr.
  Run "shelf <command> --help" for command-specific flags and examples.

Review comments:
  Authenticated artifact review is available through "shelf comments". It lists threads, batches
  activity rollups with "summaries", and supports moderator replies, resolve/reopen, and
  hide/unhide. Visitor identity and public-link capability secrets are intentionally not accepted
  by the CLI.
`,
  );

  let result: unknown;
  let finalizeResult: (() => Promise<void>) | undefined;

  program
    .command('publish')
    .description('Publish one immutable file or folder revision')
    .argument('[path]', 'file or directory to publish through a configured profile')
    .option('--profile <name>', 'use one configured profile')
    .option('--url <url>')
    .option('--workspace <workspace>')
    .option('--file <path>')
    .option('--idempotency-key <key>')
    .option('--artifact <artifact-id>', 'publish another revision to this artifact')
    .option('--metadata <key=value>', 'publisher metadata; repeatable', collect, [])
    .option('--title <title>', 'human-readable artifact title stored as metadata')
    .option('--description <description>', 'artifact description stored as metadata')
    .option(
      '--user-bypass',
      'allow an intentional human publish without title and description metadata',
    )
    .option('--share', 'return a prepared default or create the requested custom share')
    .option('--access <protected|public>', 'share access policy; defaults to protected')
    .option('--comments <off|private|shared>', 'comment policy; defaults to off')
    .option(
      '--expires-in <preset>',
      'share duration: never, 5m, 30m, 2hr, 6hr, 24hr, 3d, 7d, 15d, or 30d',
    )
    .option(
      '--expires-at <instant>',
      'share expiry as an ISO UTC instant; conflicts with --expires-in',
    )
    .option('--max-sessions <count>', 'protected share session budget, from 1 to 1000000')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText(
      'after',
      `
Metadata:
  Agent publishes require --title and --description. Add arbitrary strings with repeatable
  --metadata key=value. Humans may intentionally omit title/description with --user-bypass.

Sharing:
  Every new file receives permanent Latest Protected and Public defaults. With --share and no
  finite/session policy, Shelf returns the prepared default for --access (Protected by default).
  New links default to comments Off. Use --comments private or --comments shared to enable
  comments; omission leaves a prepared link unchanged, while explicit --comments off disables it.
  Add --expires-in, --expires-at, or --max-sessions to create and return a custom link instead.

Examples:
  shelf publish ./notes.md --title "Release notes" --description "Changes in this build"
  shelf publish ./site --title "Preview" --description "Static site review" --share --access public --expires-in 24hr
  shelf publish ./draft.txt --user-bypass
`,
    )
    .action(async (path: string | undefined, options: PublishCliOptions) => {
      if (path !== undefined) {
        if (
          options.file !== undefined ||
          options.url !== undefined ||
          options.workspace !== undefined ||
          options.allowInsecureLoopback !== undefined
        ) {
          throw usageFailure('Profile-backed publishing cannot mix legacy context flags.');
        }
        if (
          !options.share &&
          (options.access !== undefined ||
            options.comments !== undefined ||
            options.expiresIn !== undefined ||
            options.expiresAt !== undefined ||
            options.maxSessions !== undefined)
        ) {
          throw usageFailure('Share policy options require --share.');
        }
        const execution = await executePublishWorkflow({ ...options, path }, runtime);
        result = execution.output;
        finalizeResult = execution.finalize;
        return;
      }
      if (
        options.url === undefined ||
        options.workspace === undefined ||
        options.file === undefined ||
        options.idempotencyKey === undefined
      ) {
        throw usageFailure('A publish path or complete legacy publish context is required.');
      }
      if (options.profile !== undefined || options.share) {
        throw usageFailure('Legacy publishing cannot mix profile or share options.');
      }
      if (
        options.access !== undefined ||
        options.comments !== undefined ||
        options.expiresIn !== undefined ||
        options.expiresAt !== undefined ||
        options.maxSessions !== undefined
      ) {
        throw usageFailure('Share policy options require profile-backed publishing with --share.');
      }
      result = await executePublish(
        options as PublishCommandOptions,
        runtime.env,
        runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
      );
    });

  const folders = program.command('folders').description('Publish and inspect folder snapshots');
  folders
    .command('publish')
    .description('Publish one complete immutable folder snapshot')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>')
    .option('--workspace <workspace>')
    .requiredOption('--directory <path>')
    .requiredOption('--idempotency-key <key>')
    .option('--artifact <artifact-id>', 'publish another snapshot to this folder artifact')
    .option('--metadata <key=value>', 'publisher metadata; repeatable', collect, [])
    .option('--title <title>', 'human-readable artifact title stored as metadata')
    .option('--description <description>', 'artifact description stored as metadata')
    .option(
      '--user-bypass',
      'allow an intentional human publish without title and description metadata',
    )
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText(
      'after',
      `
Metadata:
  Agent publishes require --title and --description. Add arbitrary strings with repeatable
  --metadata key=value. Humans may intentionally omit title/description with --user-bypass.
`,
    )
    .action(async (options: PublishFolderCommandOptions) => {
      result = await executePublishFolder(options, runtime);
    });
  folders
    .command('tree')
    .description('Read one immutable folder revision tree')
    .option('--profile <name>', 'use one configured profile instead of --url')
    .option('--url <url>')
    .requiredOption('--revision <revision-id>')
    .option('--limit <count>')
    .option('--cursor <cursor>')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (options: FolderTreeCommandOptions) => {
      result = await executeFolderTree(options, runtime);
    });
  folders
    .command('download')
    .description('Download one file from inside an immutable folder revision')
    .option('--profile <name>', 'use one configured profile instead of --url')
    .option('--url <url>')
    .requiredOption('--revision <revision-id>')
    .requiredOption('--path <entry-path>', 'portable folder entry path to download')
    .requiredOption('--output <path>', 'explicit local file path to write')
    .option('--overwrite', 'atomically replace an existing file; default refuses to replace')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText(
      'after',
      `
Safety and output:
  The command streams one authenticated folder entry to a temporary file and publishes it
  atomically at --output. It refuses to replace an existing path unless --overwrite is supplied.
  Success writes one JSON document to stdout. Authentication uses --profile or SHELF_TOKEN.

Examples:
  shelf folders download --url https://shelf.example --revision rev_<id> --path src/index.ts --output ./index.ts
  shelf folders download --profile default --revision rev_<id> --path README.md --output ./README.md --overwrite
`,
    )
    .action(async (options: FolderDownloadCommandOptions) => {
      result = await executeFolderDownload(options, runtime);
    });

  const revisions = program.command('revisions').description('Inspect immutable revisions');
  revisions
    .command('compare')
    .description('Compare two revisions of one artifact')
    .option('--profile <name>', 'use one configured profile instead of --url')
    .option('--url <url>')
    .requiredOption('--base <revision-id>')
    .requiredOption('--target <revision-id>')
    .option('--limit <count>')
    .option('--cursor <cursor>')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (options: CompareRevisionsCommandOptions) => {
      result = await executeCompareRevisions(options, runtime);
    });
  revisions
    .command('download')
    .description('Download one exact immutable file revision')
    .option('--profile <name>', 'use one configured profile instead of --url')
    .option('--url <url>')
    .requiredOption('--revision <revision-id>')
    .requiredOption('--output <path>', 'explicit local file path to write')
    .option('--overwrite', 'atomically replace an existing file; default refuses to replace')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText(
      'after',
      `
Safety and output:
  The command streams authenticated exact revision bytes to a temporary file and publishes it
  atomically at --output. It refuses to replace an existing path unless --overwrite is supplied.
  Success writes one JSON document to stdout. Authentication uses --profile or SHELF_TOKEN.

Examples:
  shelf revisions download --url https://shelf.example --revision rev_<id> --output ./artifact.bin
  shelf revisions download --url https://shelf.example --revision rev_<id> --output ./artifact.bin --overwrite
  shelf revisions download --profile default --revision rev_<id> --output ./artifact.bin
`,
    )
    .action(async (options: DownloadRevisionCommandOptions) => {
      result = await executeDownloadRevision(options, runtime);
    });

  const artifacts = program.command('artifacts').description('Inspect versioned artifacts');
  artifacts
    .command('list')
    .description('List a workspace artifact page')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>')
    .option('--workspace <workspace>')
    .option('--limit <count>')
    .option('--cursor <cursor>')
    .option('--sort <created|updated>', 'sort field; defaults to updated')
    .option('--order <asc|desc>', 'sort direction; defaults to desc')
    .option('--search <text>', 'search title, description, filename, or artifact name')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (options: ListArtifactsCommandOptions) => {
      result = await executeListArtifacts(options, runtime);
    });
  artifacts
    .command('show')
    .description('Show one artifact and its latest revision')
    .option('--profile <name>', 'use one configured profile instead of --url')
    .option('--url <url>')
    .requiredOption('--artifact <artifact-id>')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (options: ShowArtifactCommandOptions) => {
      result = await executeShowArtifact(options, runtime);
    });
  artifacts
    .command('history')
    .description('List immutable revision history')
    .option('--profile <name>', 'use one configured profile instead of --url')
    .option('--url <url>')
    .requiredOption('--artifact <artifact-id>')
    .option('--limit <count>')
    .option('--order <newest|oldest>')
    .option('--cursor <cursor>')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (options: ArtifactHistoryCommandOptions) => {
      result = await executeArtifactHistory(options, runtime);
    });
  artifacts
    .command('rename')
    .description('Rename an artifact without changing revision content')
    .option('--profile <name>', 'use one configured profile instead of --url')
    .option('--url <url>')
    .requiredOption('--artifact <artifact-id>')
    .requiredOption('--name <name>')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (options: RenameArtifactCommandOptions) => {
      result = await executeRenameArtifact(options, runtime);
    });
  artifacts
    .command('restore')
    .description('Create a new revision from an earlier immutable revision')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>')
    .option('--workspace <workspace>')
    .requiredOption('--artifact <artifact-id>')
    .requiredOption('--revision <revision-id>')
    .requiredOption('--idempotency-key <key>')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (options: RestoreArtifactCommandOptions) => {
      result = await executeRestoreArtifact(options, runtime);
    });
  artifacts
    .command('delete')
    .description('Soft-delete an artifact and revoke its active shares')
    .option('--profile <name>', 'use one configured profile instead of --url')
    .option('--url <url>')
    .requiredOption('--artifact <artifact-id>')
    .requiredOption('--confirm <artifact-id>', 'confirm the exact artifact ID to delete')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (options: DeleteArtifactCommandOptions) => {
      result = await executeDeleteArtifact(options, runtime);
    });
  artifacts
    .command('recover')
    .description('Recover a soft-deleted artifact during its recovery window')
    .option('--profile <name>', 'use one configured profile instead of --url')
    .option('--url <url>')
    .requiredOption('--artifact <artifact-id>')
    .option('--idempotency-key <key>')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (options: RecoverArtifactCommandOptions) => {
      result = await executeRecoverArtifact(options, runtime);
    });

  const shares = program.command('shares').description('Create and manage share links');
  shares
    .command('create')
    .description('Create a reusable Protected or Public share link')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>')
    .option('--workspace <workspace>')
    .requiredOption('--artifact <artifact-id>')
    .requiredOption('--idempotency-key <key>')
    .option('--revision <revision-id>', 'pin the share to one immutable revision')
    .option('--access <protected|public>', 'access policy; defaults to protected')
    .option('--comments <off|private|shared>', 'comment policy; defaults to off')
    .option(
      '--expires-in <preset>',
      'duration: never, 5m, 30m, 2hr, 6hr, 24hr, 3d, 7d, 15d, or 30d',
    )
    .option('--expires-at <instant>', 'expiry as an ISO UTC instant; conflicts with --expires-in')
    .option('--max-sessions <count>', 'protected session budget, from 1 to 1000000')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText(
      'after',
      `
Access policies:
  protected  Capability URL. May never expire and may set --max-sessions.
  public     Short non-confidential URL. Omission defaults to Never.

Comments:
  --comments accepts off, private, or shared. New links default to Off; omission leaves a
  prepared link unchanged, and explicit off disables comments on that link.

Targets default to Latest. Add --revision to pin the link to one immutable revision.
Use either --expires-in or --expires-at, never both.

Examples:
  shelf shares create --url <url> --workspace <id> --artifact <artifact-id> --idempotency-key <key>
  shelf shares create --url <url> --workspace <id> --artifact <artifact-id> --access protected --max-sessions 5 --expires-in 7d --idempotency-key <key>
  shelf shares create --url <url> --workspace <id> --artifact <artifact-id> --access public --expires-in 24hr --idempotency-key <key>
`,
    )
    .action(async (options: CreateShareCommandOptions) => {
      result = await executeCreateShare(options, runtime);
    });
  shares
    .command('defaults')
    .description('Get or repair both permanent Latest defaults for one artifact')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>')
    .option('--workspace <workspace>')
    .requiredOption('--artifact <artifact-id>')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText(
      'after',
      `
Returns both prepared links. Protected URLs contain confidential capability material; Public
URLs are short and non-confidential. Missing or revoked defaults are repaired automatically.

Example:
  shelf shares defaults --url <url> --workspace <id> --artifact <artifact-id>
`,
    )
    .action(async (options: DefaultSharesCommandOptions) => {
      result = await executeDefaultShares(options, runtime);
    });
  shares
    .command('list')
    .description('List reusable share URLs, lifecycle state, and usage')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>')
    .option('--workspace <workspace>')
    .option('--limit <count>')
    .option('--cursor <cursor>')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (options: ListSharesCommandOptions) => {
      result = await executeListShares(options, runtime);
    });
  shares
    .command('revoke')
    .description('Revoke one share immediately')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>')
    .option('--workspace <workspace>')
    .requiredOption('--share <share-id>')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (options: RevokeShareCommandOptions) => {
      result = await executeRevokeShare(options, runtime);
    });
  shares
    .command('comments')
    .description('Set the comment policy on an existing share')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>')
    .option('--workspace <workspace>')
    .requiredOption('--share <share-id>')
    .requiredOption('--comments <off|private|shared>')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText(
      'after',
      `
Updates one existing share. This requires workspace-scoped authentication and returns the
canonical share management summary, including its current comment policy. It does not print or
accept protected capability secrets.

Examples:
  shelf shares comments --url https://shelf.example --workspace <id> --share shr_<id> --comments shared
  shelf shares comments --url https://shelf.example --workspace <id> --share shr_<id> --comments off
`,
    )
    .action(async (options: ShareCommentsCommandOptions) => {
      result = await executeSetShareCommentPolicy(options, runtime);
    });

  const comments = program
    .command('comments')
    .description('Review authenticated artifact comment threads');
  comments
    .command('list')
    .description('List artifact comment threads and their posts')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>')
    .option('--workspace <workspace>')
    .requiredOption('--artifact <artifact-id>')
    .option('--revision <revision-id>', 'evaluate line anchors against this revision')
    .option('--cursor <cursor>', 'opaque cursor returned by the previous page')
    .option('--limit <count>', 'number of threads to return (1-50, default 25)')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText(
      'after',
      `
The response is structured JSON with thread, anchor, revision, visibility, status, permissions,
and post data. Without --revision, Shelf uses the artifact's latest revision. Responses include
items and nextCursor; use --cursor with the previous page's nextCursor to load older discussions.

Example:
  shelf comments list --url https://shelf.example --workspace <id> --artifact art_<id>
  shelf comments list --url https://shelf.example --workspace <id> --artifact art_<id> --revision rev_<id>
`,
    )
    .action(async (options: ListCommentsCommandOptions) => {
      result = await executeListComments(options, runtime);
    });

  comments
    .command('reply')
    .description('Reply to an artifact thread as the authenticated moderator')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>')
    .option('--workspace <workspace>')
    .requiredOption('--artifact <artifact-id>')
    .requiredOption('--thread <thread-id>')
    .requiredOption('--body <text>')
    .option('--display-name <name>', 'moderator display name shown on the reply (1-128 characters)')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText(
      'after',
      `
The reply is posted as the authenticated moderator and returned as one structured post. Bodies
are limited to 20000 characters. Add --display-name to override the recorded moderator name.

Example:
  shelf comments reply --url https://shelf.example --workspace <id> --artifact art_<id> --thread thread_<id> --body "Reviewed and fixed."
  shelf comments reply --profile default --artifact art_<id> --thread thread_<id> --body "Fixed." --display-name "Release bot"
`,
    )
    .action(async (options: ReplyCommentCommandOptions) => {
      result = await executeReplyComment(options, runtime);
    });

  comments
    .command('summaries')
    .description('Summarize comment activity for a batch of workspace artifacts')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>')
    .option('--workspace <workspace>')
    .requiredOption('--artifact <artifact-id>', 'artifact to summarize; repeatable', collect, [])
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText(
      'after',
      `
Summaries let an agent poll which artifacts have open discussions or new activity without
paging every thread. Repeat --artifact for each artifact, from 1 to 100 per request. Each item
reports participants, open thread and reply counts, and the latest activity instant.

Examples:
  shelf comments summaries --url https://shelf.example --workspace <id> --artifact art_<id>
  shelf comments summaries --profile default --artifact art_<one> --artifact art_<two>
`,
    )
    .action(async (options: CommentSummariesCommandOptions) => {
      result = await executeCommentSummaries(options, runtime);
    });

  const threadStatusHelp = `
These commands return the updated thread as structured JSON.

Example:
  shelf comments STATUS --url https://shelf.example --workspace <id> --artifact art_<id> --thread thread_<id>
`;
  comments
    .command('resolve')
    .description('Resolve an artifact comment thread')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>')
    .option('--workspace <workspace>')
    .requiredOption('--artifact <artifact-id>')
    .requiredOption('--thread <thread-id>')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText('after', threadStatusHelp.replace('STATUS', 'resolve'))
    .action(async (options: ThreadStatusCommandOptions) => {
      result = await executeResolveComment(options, runtime);
    });
  comments
    .command('reopen')
    .description('Reopen an artifact comment thread')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>')
    .option('--workspace <workspace>')
    .requiredOption('--artifact <artifact-id>')
    .requiredOption('--thread <thread-id>')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText('after', threadStatusHelp.replace('STATUS', 'reopen'))
    .action(async (options: ThreadStatusCommandOptions) => {
      result = await executeReopenComment(options, runtime);
    });

  const postModerationHelp = `
Moderation changes visibility without rewriting the visitor's post. The updated post is returned
as structured JSON.

Example:
  shelf comments ACTION --url https://shelf.example --workspace <id> --artifact art_<id> --post post_<id>
`;
  comments
    .command('hide')
    .description('Hide an artifact comment post as moderator')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>')
    .option('--workspace <workspace>')
    .requiredOption('--artifact <artifact-id>')
    .requiredOption('--post <post-id>')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText('after', postModerationHelp.replace('ACTION', 'hide'))
    .action(async (options: PostModerationCommandOptions) => {
      result = await executeHideComment(options, runtime);
    });
  comments
    .command('unhide')
    .description('Unhide an artifact comment post as moderator')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>')
    .option('--workspace <workspace>')
    .requiredOption('--artifact <artifact-id>')
    .requiredOption('--post <post-id>')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText('after', postModerationHelp.replace('ACTION', 'unhide'))
    .action(async (options: PostModerationCommandOptions) => {
      result = await executeUnhideComment(options, runtime);
    });

  const profiles = program.command('profiles').description('Configure isolated CLI contexts');
  profiles
    .command('set')
    .description('Create or update an isolated CLI context')
    .argument('<name>')
    .requiredOption('--url <url>')
    .requiredOption('--workspace <workspace>')
    .option('--credential-env <variable>')
    .option('--store-token-from-env <variable>')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (name: string, options: Omit<SetProfileOptions, 'name'>) => {
      result = await executeSetProfile({ name, ...options }, runtime);
    });
  profiles
    .command('list')
    .description('List configured profile names and contexts')
    .action(async () => {
      result = await executeListProfiles(runtime.env);
    });
  profiles
    .command('show')
    .description('Show one profile without revealing its credential')
    .argument('<name>')
    .action(async (name: string) => {
      result = await executeShowProfile(name, runtime.env);
    });
  profiles
    .command('remove')
    .description('Remove one profile and its stored credential reference')
    .argument('<name>')
    .option('--yes', 'confirm removal without prompting')
    .action(async (name: string, options: { yes?: boolean }) => {
      result = await executeRemoveProfile(name, options.yes, runtime);
    });

  try {
    await program.parseAsync([...argv]);
    if (result === undefined) throw usageFailure('A command is required.');
    await finalizeResult?.();
    runtime.stdout(jsonLine(result));
    return CLI_EXIT_CODES.success;
  } catch (error) {
    if (error instanceof CommanderError && error.code === 'commander.helpDisplayed') {
      return CLI_EXIT_CODES.success;
    }
    if (error instanceof CliPartialFailure) {
      runtime.stderr(
        jsonLine(redactValue(error.payload, [...error.secrets, runtime.env.SHELF_TOKEN])),
      );
      return error.exitCode;
    }
    const token = runtime.env.SHELF_TOKEN;
    const cliFailure =
      error instanceof CliFailure
        ? error
        : error instanceof CommanderError
          ? usageFailure(error.message)
          : failure('INTERNAL_ERROR', 'An unexpected CLI error occurred.');
    runtime.stderr(jsonLine(redactEnvelope(cliFailure.envelope, token)));
    return cliFailure.exitCode;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv);
}
