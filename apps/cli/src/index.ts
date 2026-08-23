#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { CLI_EXIT_CODES } from '@shelf/contracts';
import { Command, CommanderError } from 'commander';
import {
  type ArtifactHistoryCommandOptions,
  type DeleteArtifactCommandOptions,
  type EmptyTrashCommandOptions,
  executeArtifactHistory,
  executeDeleteArtifact,
  executeEmptyTrash,
  executeListArtifacts,
  executeListTrash,
  executePermanentlyDeleteArtifact,
  executeRecoverArtifact,
  executeRenameArtifact,
  executeResolveArtifact,
  executeRestoreArtifact,
  executeSetArtifactRetention,
  executeShowArtifact,
  executeShowTrashedArtifact,
  type ListArtifactsCommandOptions,
  type ListTrashCommandOptions,
  type PermanentlyDeleteArtifactCommandOptions,
  type RecoverArtifactCommandOptions,
  type RenameArtifactCommandOptions,
  type ResolveArtifactCommandOptions,
  type RestoreArtifactCommandOptions,
  type SetArtifactRetentionCommandOptions,
  type ShowArtifactCommandOptions,
} from './commands/artifacts.js';
import {
  type CommentSummariesCommandOptions,
  type CreateCommentCommandOptions,
  type EditCommentCommandOptions,
  executeCommentSummaries,
  executeCreateComment,
  executeDeleteComment,
  executeEditComment,
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
import {
  describeCommandAt,
  executeSchema,
  resolveCommandPath,
  SCHEMA_FLAG,
  subcommandsOf,
} from './schema.js';
import { CLI_VERSION } from './version.js';

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
  // Commander reports "no command given" by writing help to stderr and throwing
  // commander.help. Capture that text so it can be re-emitted on stdout instead of
  // surfacing Commander's internal "(outputHelp)" sentinel as an error message.
  let suppressedHelp = '';

  const program = new Command()
    .name('shelf')
    .description('Publish, version, inspect, and share Shelf artifacts')
    .version(CLI_VERSION, '--version', 'Print the CLI version')
    .showHelpAfterError(false)
    .showSuggestionAfterError(false)
    .exitOverride()
    .configureOutput({
      writeOut: runtime.stdout,
      writeErr(chunk) {
        suppressedHelp += chunk;
      },
    })
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
  credential from a configured profile. A bare command with no context flags uses the profile
  named "default" when it is configured. Otherwise pass --url (and --workspace where the command
  is workspace-scoped) and export SHELF_TOKEN. Mixing --profile with --url, --workspace, or
  --allow-insecure-loopback is a usage error. Never pass tokens as arguments.

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
    .option('--url <url>', 'installation origin for legacy publishing; conflicts with --profile')
    .option('--workspace <workspace>', 'workspace ID for legacy publishing; requires --url')
    .option('--file <path>', 'file to publish in legacy mode; use the path argument instead')
    .option(
      '--idempotency-key <key>',
      'stable key that makes retries safe (1-128 characters); derived from the operation journal when omitted',
    )
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

Output:
  Success returns urls.artifact and urls.revision, plus urls.share when --share is used. Report
  those URLs rather than raw IDs.

Partial success:
  With --share, the publish can succeed while the share fails. The CLI then exits non-zero and
  writes "status": "partial" to stderr, carrying the completed publish result and its urls. The
  revision already exists. Retry only the share with "shelf shares create"; do not re-publish.

Idempotency:
  --idempotency-key is optional here. Omit it and Shelf derives a stable key from the crash-safe
  operation journal, so re-running an interrupted publish resumes instead of duplicating. Supply
  your own key to make retries of the SAME logical publish safe; reuse it verbatim when retrying,
  and use a NEW key when publishing a new revision of an existing artifact.

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
    .option('--url <url>', 'installation origin to publish to; conflicts with --profile')
    .option('--workspace <workspace>', 'workspace ID that owns the artifact; requires --url')
    .requiredOption('--directory <path>', 'local directory to snapshot and publish')
    .requiredOption(
      '--idempotency-key <key>',
      'stable key that makes retries of this snapshot safe (1-128 characters)',
    )
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

Idempotency:
  --idempotency-key is required. Supply any stable string of 1-128 characters and reuse it
  verbatim when retrying the SAME snapshot; that is what makes a retry safe after a timeout or
  crash. Use a NEW key to publish a new snapshot of an existing folder artifact.

Examples:
  shelf folders publish --profile default --directory ./site --title "Site" --description "Static build" --idempotency-key site-2026-02-01
  shelf folders publish --profile default --directory ./site --artifact art_<id> --title "Site" --description "Rebuild" --idempotency-key site-2026-02-02
`,
    )
    .action(async (options: PublishFolderCommandOptions) => {
      result = await executePublishFolder(options, runtime);
    });
  folders
    .command('tree')
    .description('Read one immutable folder revision tree')
    .option('--profile <name>', 'use one configured profile instead of --url')
    .option('--url <url>', 'installation origin to read from; conflicts with --profile')
    .requiredOption('--revision <revision-id>', 'folder revision to read the tree from')
    .option('--limit <count>', 'entries to return (1-100, default 100)')
    .option('--cursor <cursor>', 'opaque cursor returned by the previous page')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText(
      'after',
      `
Examples:
  shelf folders tree --profile default --revision rev_<id>
  shelf folders tree --profile default --revision rev_<id> --limit 50 --cursor <cursor>
`,
    )
    .action(async (options: FolderTreeCommandOptions) => {
      result = await executeFolderTree(options, runtime);
    });
  folders
    .command('download')
    .description('Download one file from inside an immutable folder revision')
    .option('--profile <name>', 'use one configured profile instead of --url')
    .option('--url <url>', 'installation origin to read from; conflicts with --profile')
    .requiredOption('--revision <revision-id>', 'folder revision that contains the entry')
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
    .option('--url <url>', 'installation origin to read from; conflicts with --profile')
    .requiredOption('--base <revision-id>', 'revision to compare from')
    .requiredOption('--target <revision-id>', 'revision to compare against the base')
    .option('--limit <count>', 'comparison entries to return (1-100, default 100)')
    .option('--cursor <cursor>', 'opaque cursor returned by the previous page')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText(
      'after',
      `
Examples:
  shelf revisions compare --profile default --base rev_<id> --target rev_<id>
  shelf revisions compare --profile default --base rev_<id> --target rev_<id> --limit 25
`,
    )
    .action(async (options: CompareRevisionsCommandOptions) => {
      result = await executeCompareRevisions(options, runtime);
    });
  revisions
    .command('download')
    .description('Download one exact immutable file revision')
    .option('--profile <name>', 'use one configured profile instead of --url')
    .option('--url <url>', 'installation origin to read from; conflicts with --profile')
    .requiredOption('--revision <revision-id>', 'exact immutable revision to download')
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
    .option('--url <url>', 'installation origin to read from; conflicts with --profile')
    .option('--workspace <workspace>', 'workspace ID to list artifacts from; requires --url')
    .option('--limit <count>', 'artifacts to return (1-100, default 20)')
    .option('--cursor <cursor>', 'opaque cursor returned by the previous page')
    .option('--sort <created|updated>', 'sort field; defaults to updated')
    .option('--order <asc|desc>', 'sort direction; defaults to desc')
    .option('--search <text>', 'search title, description, filename, or artifact name')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText(
      'after',
      `
Responses include items and nextCursor; pass nextCursor back with --cursor to page further.

Examples:
  shelf artifacts list --profile default
  shelf artifacts list --profile default --search "release notes" --limit 50
  shelf artifacts list --profile default --sort created --order asc
`,
    )
    .action(async (options: ListArtifactsCommandOptions) => {
      result = await executeListArtifacts(options, runtime);
    });
  artifacts
    .command('show')
    .description('Show one artifact and its latest revision')
    .option('--profile <name>', 'use one configured profile instead of --url')
    .option('--url <url>', 'installation origin to read from; conflicts with --profile')
    .requiredOption('--artifact <artifact-id>', 'artifact to show')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText(
      'after',
      `
Returns the artifact and its latest revision as one JSON document.

Example:
  shelf artifacts show --profile default --artifact art_<id>
`,
    )
    .action(async (options: ShowArtifactCommandOptions) => {
      result = await executeShowArtifact(options, runtime);
    });
  artifacts
    .command('resolve')
    .description('Find an artifact from a share ID or share link')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>', 'installation origin to read from; conflicts with --profile')
    .option('--workspace <workspace>', 'workspace ID to search; requires --url')
    .requiredOption('--from <share-id-or-link>', 'share ID, Public link, or Protected link')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText(
      'after',
      `
Protected URL fragments are parsed locally and never sent to Shelf. The response includes the
resolved artifactId and share state, including expired or revoked management records.

Examples:
  shelf artifacts resolve --profile default --from shr_<id>
  shelf artifacts resolve --profile default --from https://shelf.example/s/publiccode12
`,
    )
    .action(async (options: ResolveArtifactCommandOptions) => {
      result = await executeResolveArtifact(options, runtime);
    });
  artifacts
    .command('history')
    .description('List immutable revision history')
    .option('--profile <name>', 'use one configured profile instead of --url')
    .option('--url <url>', 'installation origin to read from; conflicts with --profile')
    .requiredOption('--artifact <artifact-id>', 'artifact whose revision history to list')
    .option('--limit <count>', 'revisions to return (1-100, default 20)')
    .option('--order <newest|oldest>', 'history order; defaults to newest')
    .option('--cursor <cursor>', 'opaque cursor returned by the previous page')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText(
      'after',
      `
Each item is one immutable revision. Page with --cursor using the previous response's nextCursor.

Examples:
  shelf artifacts history --profile default --artifact art_<id>
  shelf artifacts history --profile default --artifact art_<id> --order oldest --limit 100
`,
    )
    .action(async (options: ArtifactHistoryCommandOptions) => {
      result = await executeArtifactHistory(options, runtime);
    });
  artifacts
    .command('rename')
    .description('Rename an artifact without changing revision content')
    .option('--profile <name>', 'use one configured profile instead of --url')
    .option('--url <url>', 'installation origin to write to; conflicts with --profile')
    .requiredOption('--artifact <artifact-id>', 'artifact to rename')
    .requiredOption('--name <name>', 'new display name (1-255 characters, no control characters)')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText(
      'after',
      `
Renaming updates the display name only. Existing revisions and share links are unaffected.

Example:
  shelf artifacts rename --profile default --artifact art_<id> --name "Q3 release notes"
`,
    )
    .action(async (options: RenameArtifactCommandOptions) => {
      result = await executeRenameArtifact(options, runtime);
    });
  artifacts
    .command('restore')
    .description('Create a new revision from an earlier immutable revision')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>', 'installation origin to write to; conflicts with --profile')
    .option('--workspace <workspace>', 'workspace ID that owns the artifact; requires --url')
    .requiredOption('--artifact <artifact-id>', 'artifact to restore a revision into')
    .requiredOption('--revision <revision-id>', 'earlier revision to copy into a new revision')
    .requiredOption(
      '--idempotency-key <key>',
      'stable key that makes retries of this restore safe (1-128 characters)',
    )
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText(
      'after',
      `
Restoring never rewrites history. It copies the chosen revision's content into a new revision at
the head of the artifact.

Idempotency:
  --idempotency-key is required. Reuse the same key verbatim when retrying the SAME restore so a
  timeout cannot create two revisions. Use a NEW key for a subsequent, distinct restore.

Example:
  shelf artifacts restore --profile default --artifact art_<id> --revision rev_<id> --idempotency-key restore-art-rev-1
`,
    )
    .action(async (options: RestoreArtifactCommandOptions) => {
      result = await executeRestoreArtifact(options, runtime);
    });
  artifacts
    .command('delete')
    .description('Soft-delete an artifact and revoke its active shares')
    .option('--profile <name>', 'use one configured profile instead of --url')
    .option('--url <url>', 'installation origin to write to; conflicts with --profile')
    .requiredOption('--artifact <artifact-id>', 'artifact to soft-delete')
    .requiredOption('--confirm <artifact-id>', 'confirm the exact artifact ID to delete')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText(
      'after',
      `
Deletion is a soft delete: active shares are revoked immediately and the artifact stays
recoverable with "shelf artifacts recover" during its recovery window. --confirm must repeat the
same artifact ID passed to --artifact.

Example:
  shelf artifacts delete --profile default --artifact art_<id> --confirm art_<id>
`,
    )
    .action(async (options: DeleteArtifactCommandOptions) => {
      result = await executeDeleteArtifact(options, runtime);
    });
  artifacts
    .command('recover')
    .description('Recover a soft-deleted artifact during its recovery window')
    .option('--profile <name>', 'use one configured profile instead of --url')
    .option('--url <url>', 'installation origin to write to; conflicts with --profile')
    .requiredOption('--artifact <artifact-id>', 'soft-deleted artifact to recover')
    .option(
      '--idempotency-key <key>',
      'stable key that makes retries safe (1-128 characters); a fresh key is generated when omitted',
    )
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText(
      'after',
      `
Recovery only succeeds while the artifact is inside its recovery window. Shares revoked by the
delete are not restored.

Idempotency:
  --idempotency-key is optional. Omitted, the CLI generates a fresh key per invocation. Pass your
  own stable key and reuse it verbatim to make retries of the SAME recovery safe.

Example:
  shelf artifacts recover --profile default --artifact art_<id>
`,
    )
    .action(async (options: RecoverArtifactCommandOptions) => {
      result = await executeRecoverArtifact(options, runtime);
    });

  const artifactRetention = artifacts
    .command('retention')
    .description('Inspect or change automatic artifact retention');
  artifactRetention
    .command('set')
    .description('Keep an artifact or return it to automatic cleanup')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>', 'installation origin to write to; conflicts with --profile')
    .option('--workspace <workspace>', 'workspace ID that owns the artifact; requires --url')
    .requiredOption('--artifact <artifact-id>', 'artifact whose retention should change')
    .requiredOption('--mode <automatic|keep>', 'automatic Trash cleanup or indefinite keep')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText(
      'after',
      `
Automatic artifacts move to Trash after their active custom shares and grace period end. Keep
disables automatic Trash for the artifact. Prepared default links never count as active shares.

Examples:
  shelf artifacts retention set --profile default --artifact art_<id> --mode keep
  shelf artifacts retention set --profile default --artifact art_<id> --mode automatic
`,
    )
    .action(async (options: SetArtifactRetentionCommandOptions) => {
      result = await executeSetArtifactRetention(options, runtime);
    });

  const trash = program.command('trash').description('List and recover artifacts in Trash');
  trash
    .command('list')
    .description('List recoverable artifacts in one workspace Trash')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>', 'installation origin to read from; conflicts with --profile')
    .option('--workspace <workspace>', 'workspace ID whose Trash should be listed; requires --url')
    .option('--limit <count>', 'artifacts to return (1-100, default 20)')
    .option('--cursor <cursor>', 'opaque cursor returned by the previous page')
    .option('--search <text>', 'search artifact ID, title, description, filename, or name')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText(
      'after',
      `
Each item includes deletedAt and purgeAt. Pass nextCursor back with --cursor to page further.

Examples:
  shelf trash list --profile default
  shelf trash list --profile default --search art_<id>
`,
    )
    .action(async (options: ListTrashCommandOptions) => {
      result = await executeListTrash(options, runtime);
    });
  trash
    .command('show')
    .description('Show one recoverable artifact from Trash by ID')
    .option('--profile <name>', 'use one configured profile instead of --url')
    .option('--url <url>', 'installation origin to read from; conflicts with --profile')
    .requiredOption('--artifact <artifact-id>', 'trashed artifact to show')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (options: ShowArtifactCommandOptions) => {
      result = await executeShowTrashedArtifact(options, runtime);
    });
  trash
    .command('recover')
    .description('Recover an artifact and create a seven-day Protected recovery link')
    .option('--profile <name>', 'use one configured profile instead of --url')
    .option('--url <url>', 'installation origin to write to; conflicts with --profile')
    .requiredOption('--artifact <artifact-id>', 'trashed artifact to recover')
    .option('--idempotency-key <key>', 'stable retry key (1-128 characters)')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (options: RecoverArtifactCommandOptions) => {
      result = await executeRecoverArtifact(options, runtime);
    });
  trash
    .command('delete')
    .description('Permanently delete one artifact from Trash')
    .option('--profile <name>', 'use one configured profile instead of --url')
    .option('--url <url>', 'installation origin to write to; conflicts with --profile')
    .requiredOption('--artifact <artifact-id>', 'trashed artifact to delete permanently')
    .requiredOption('--confirm <artifact-id>', 'must exactly match --artifact')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText(
      'after',
      `
This cannot be undone. Metadata is removed immediately and unreferenced content is queued for
deletion from the configured Local File or R2 storage backend.

Example:
  shelf trash delete --profile default --artifact art_<id> --confirm art_<id>
`,
    )
    .action(async (options: PermanentlyDeleteArtifactCommandOptions) => {
      result = await executePermanentlyDeleteArtifact(options, runtime);
    });
  trash
    .command('empty')
    .description('Permanently delete every artifact from one workspace Trash')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>', 'installation origin to write to; conflicts with --profile')
    .option('--workspace <workspace>', 'workspace ID whose Trash should be emptied; requires --url')
    .requiredOption('--confirm <workspace-id>', 'must exactly match the resolved workspace ID')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText(
      'after',
      `
This cannot be undone. Metadata is removed immediately and unreferenced content is queued for
deletion from the configured Local File or R2 storage backend.

Example:
  shelf trash empty --profile default --confirm workspace-main
`,
    )
    .action(async (options: EmptyTrashCommandOptions) => {
      result = await executeEmptyTrash(options, runtime);
    });

  const shares = program.command('shares').description('Create and manage share links');
  shares
    .command('create')
    .description('Create a reusable Protected or Public share link')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>', 'installation origin to write to; conflicts with --profile')
    .option('--workspace <workspace>', 'workspace ID that owns the artifact; requires --url')
    .requiredOption('--artifact <artifact-id>', 'artifact to share')
    .requiredOption(
      '--idempotency-key <key>',
      'stable key that makes retries of this share safe (1-128 characters)',
    )
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

Idempotency:
  --idempotency-key is required. Reuse the same key verbatim when retrying the SAME share so a
  timeout cannot mint two links. Use a NEW key for every additional distinct link.

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
    .option('--url <url>', 'installation origin to read from; conflicts with --profile')
    .option('--workspace <workspace>', 'workspace ID that owns the artifact; requires --url')
    .requiredOption('--artifact <artifact-id>', 'artifact whose default links to get or repair')
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
    .option('--url <url>', 'installation origin to read from; conflicts with --profile')
    .option('--workspace <workspace>', 'workspace ID to list shares from; requires --url')
    .option('--limit <count>', 'shares to return (1-100, default 20)')
    .option('--cursor <cursor>', 'opaque cursor returned by the previous page')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText(
      'after',
      `
Lists reusable links with lifecycle state and usage counts. Protected capability secrets are
never printed.

Examples:
  shelf shares list --profile default
  shelf shares list --profile default --limit 50 --cursor <cursor>
`,
    )
    .action(async (options: ListSharesCommandOptions) => {
      result = await executeListShares(options, runtime);
    });
  shares
    .command('revoke')
    .description('Revoke one share immediately')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>', 'installation origin to write to; conflicts with --profile')
    .option('--workspace <workspace>', 'workspace ID that owns the share; requires --url')
    .requiredOption('--share <share-id>', 'share to revoke')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText(
      'after',
      `
Revocation takes effect immediately and cannot be undone. Permanent Latest defaults are recreated
on demand by "shelf shares defaults".

Example:
  shelf shares revoke --profile default --share shr_<id>
`,
    )
    .action(async (options: RevokeShareCommandOptions) => {
      result = await executeRevokeShare(options, runtime);
    });
  shares
    .command('comments')
    .description('Set the comment policy on an existing share')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>', 'installation origin to write to; conflicts with --profile')
    .option('--workspace <workspace>', 'workspace ID that owns the share; requires --url')
    .requiredOption('--share <share-id>', 'share whose comment policy to set')
    .requiredOption('--comments <off|private|shared>', 'new comment policy for this share')
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
    .option('--url <url>', 'installation origin to use; conflicts with --profile')
    .option('--workspace <workspace>', 'workspace ID that owns the artifact; requires --url')
    .requiredOption('--artifact <artifact-id>', 'artifact that owns the thread or post')
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
    .option('--url <url>', 'installation origin to use; conflicts with --profile')
    .option('--workspace <workspace>', 'workspace ID that owns the artifact; requires --url')
    .requiredOption('--artifact <artifact-id>', 'artifact that owns the thread or post')
    .requiredOption('--thread <thread-id>', 'comment thread to act on')
    .requiredOption('--body <text>', 'reply body text (1-20000 characters)')
    .option('--display-name <name>', 'moderator display name shown on the reply (1-128 characters)')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText(
      'after',
      `
The reply is posted as the authenticated moderator and returned as one structured post. Bodies
are limited to 20000 characters. Add --display-name to override the recorded moderator name.

Example:
  shelf comments reply --url https://shelf.example --workspace <id> --artifact art_<id> --thread <thread-id> --body "Reviewed and fixed."
  shelf comments reply --profile default --artifact art_<id> --thread <thread-id> --body "Fixed." --display-name "Release bot"
`,
    )
    .action(async (options: ReplyCommentCommandOptions) => {
      result = await executeReplyComment(options, runtime);
    });

  comments
    .command('create')
    .description('Create a new artifact comment thread as the authenticated actor')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>', 'installation origin to use; conflicts with --profile')
    .option('--workspace <workspace>', 'workspace ID that owns the artifact; requires --url')
    .requiredOption('--artifact <artifact-id>', 'artifact to comment on')
    .requiredOption('--share <share-id>', 'active comments-enabled share for the thread')
    .requiredOption('--revision <revision-id>', 'revision rendered by the share')
    .requiredOption('--body <text>', 'comment body text (1-20000 characters)')
    .option('--path <path>', 'folder path or file label for the anchor')
    .option('--start-line <line>', 'first anchored line; requires --end-line')
    .option('--end-line <line>', 'last anchored line; requires --start-line')
    .option('--quoted-text <text>', 'quoted source text for anchor relocation')
    .option('--content-hash <hash>', 'content hash observed when the anchor was created')
    .option('--display-name <name>', 'actor display name shown on the comment')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText(
      'after',
      `
The selected share must have comments enabled and target the supplied revision. Omit line flags
for a whole-file comment; supply both line flags for a range comment.
`,
    )
    .action(async (options: CreateCommentCommandOptions) => {
      result = await executeCreateComment(options, runtime);
    });

  comments
    .command('edit')
    .description('Edit a comment reply created by the authenticated actor')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>', 'installation origin to use; conflicts with --profile')
    .option('--workspace <workspace>', 'workspace ID that owns the artifact; requires --url')
    .requiredOption('--artifact <artifact-id>', 'artifact that owns the post')
    .requiredOption('--post <post-id>', 'authenticated actor post to edit')
    .requiredOption('--body <text>', 'replacement body text (1-20000 characters)')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (options: EditCommentCommandOptions) => {
      result = await executeEditComment(options, runtime);
    });
  comments
    .command('delete')
    .description('Delete a comment reply created by the authenticated actor')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>', 'installation origin to use; conflicts with --profile')
    .option('--workspace <workspace>', 'workspace ID that owns the artifact; requires --url')
    .requiredOption('--artifact <artifact-id>', 'artifact that owns the post')
    .requiredOption('--post <post-id>', 'authenticated actor post to delete')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .action(async (options: PostModerationCommandOptions) => {
      result = await executeDeleteComment(options, runtime);
    });

  comments
    .command('summaries')
    .description('Summarize comment activity for a batch of workspace artifacts')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>', 'installation origin to use; conflicts with --profile')
    .option('--workspace <workspace>', 'workspace ID that owns the artifact; requires --url')
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
  shelf comments STATUS --url https://shelf.example --workspace <id> --artifact art_<id> --thread <thread-id>
`;
  comments
    .command('resolve')
    .description('Resolve an artifact comment thread')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>', 'installation origin to use; conflicts with --profile')
    .option('--workspace <workspace>', 'workspace ID that owns the artifact; requires --url')
    .requiredOption('--artifact <artifact-id>', 'artifact that owns the thread or post')
    .requiredOption('--thread <thread-id>', 'comment thread to act on')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText('after', threadStatusHelp.replace('STATUS', 'resolve'))
    .action(async (options: ThreadStatusCommandOptions) => {
      result = await executeResolveComment(options, runtime);
    });
  comments
    .command('reopen')
    .description('Reopen an artifact comment thread')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>', 'installation origin to use; conflicts with --profile')
    .option('--workspace <workspace>', 'workspace ID that owns the artifact; requires --url')
    .requiredOption('--artifact <artifact-id>', 'artifact that owns the thread or post')
    .requiredOption('--thread <thread-id>', 'comment thread to act on')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText('after', threadStatusHelp.replace('STATUS', 'reopen'))
    .action(async (options: ThreadStatusCommandOptions) => {
      result = await executeReopenComment(options, runtime);
    });

  const postModerationHelp = `
Moderation changes visibility without rewriting the visitor's post. The updated post is returned
as structured JSON.

Example:
  shelf comments ACTION --url https://shelf.example --workspace <id> --artifact art_<id> --post <post-id>
`;
  comments
    .command('hide')
    .description('Hide an artifact comment post as moderator')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>', 'installation origin to use; conflicts with --profile')
    .option('--workspace <workspace>', 'workspace ID that owns the artifact; requires --url')
    .requiredOption('--artifact <artifact-id>', 'artifact that owns the thread or post')
    .requiredOption('--post <post-id>', 'comment post to moderate')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText('after', postModerationHelp.replace('ACTION', 'hide'))
    .action(async (options: PostModerationCommandOptions) => {
      result = await executeHideComment(options, runtime);
    });
  comments
    .command('unhide')
    .description('Unhide an artifact comment post as moderator')
    .option('--profile <name>', 'use one configured profile instead of --url and --workspace')
    .option('--url <url>', 'installation origin to use; conflicts with --profile')
    .option('--workspace <workspace>', 'workspace ID that owns the artifact; requires --url')
    .requiredOption('--artifact <artifact-id>', 'artifact that owns the thread or post')
    .requiredOption('--post <post-id>', 'comment post to moderate')
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText('after', postModerationHelp.replace('ACTION', 'unhide'))
    .action(async (options: PostModerationCommandOptions) => {
      result = await executeUnhideComment(options, runtime);
    });

  const profiles = program.command('profiles').description('Configure isolated CLI contexts');
  profiles
    .command('set')
    .description('Create or update an isolated CLI context')
    .argument('<name>', 'profile name to create or overwrite')
    .requiredOption('--url <url>', 'installation origin, HTTPS unless --allow-insecure-loopback')
    .requiredOption('--workspace <workspace>', 'workspace ID this profile is scoped to')
    .option(
      '--credential-env <variable>',
      'record the NAME of an env var; the token is read from it on every invocation',
    )
    .option(
      '--store-token-from-env <variable>',
      'read the token from this env var ONCE and copy it into the OS keyring',
    )
    .option('--allow-insecure-loopback', 'allow HTTP only for loopback development')
    .addHelpText(
      'after',
      `
Credentials:
  Choose exactly one of --credential-env or --store-token-from-env; they are mutually exclusive.

  --credential-env <VAR>        Stores only the variable NAME in the profile. The token is never
                                written to disk and is read from the environment at each
                                invocation, so <VAR> must be exported whenever you run shelf.
  --store-token-from-env <VAR>  Reads the token out of <VAR> ONCE and copies it into the OS native
                                keyring. <VAR> need not be set afterward. The keyring is
                                unavailable on some systems, including many headless and CI hosts;
                                use --credential-env there.

  Tokens are never accepted as command arguments.

Examples:
  shelf profiles set default --url https://shelf.example --workspace <id> --credential-env SHELF_TOKEN
  shelf profiles set release --url https://shelf.example --workspace <id> --store-token-from-env SHELF_TOKEN
`,
    )
    .action(async (name: string, options: Omit<SetProfileOptions, 'name'>) => {
      result = await executeSetProfile({ name, ...options }, runtime);
    });
  profiles
    .command('list')
    .description('List configured profile names and contexts')
    .addHelpText(
      'after',
      `
Lists each profile's installation URL, workspace, and credential reference. Tokens are never
printed.

Example:
  shelf profiles list
`,
    )
    .action(async () => {
      result = await executeListProfiles(runtime.env);
    });
  profiles
    .command('show')
    .description('Show one profile without revealing its credential')
    .argument('<name>', 'profile name to show')
    .addHelpText(
      'after',
      `
Reports the credential reference (env variable name or keyring account), never the token itself.

Example:
  shelf profiles show default
`,
    )
    .action(async (name: string) => {
      result = await executeShowProfile(name, runtime.env);
    });
  profiles
    .command('remove')
    .description('Remove one profile and its stored credential reference')
    .argument('<name>', 'profile name to remove')
    .option('--yes', 'confirm removal without prompting')
    .addHelpText(
      'after',
      `
Removes the profile entry and deletes its keyring credential when one was stored. Nothing on the
Shelf installation is changed.

Example:
  shelf profiles remove default --yes
`,
    )
    .action(async (name: string, options: { yes?: boolean }) => {
      result = await executeRemoveProfile(name, options.yes, runtime);
    });

  program
    .command('schema')
    .description('Print the full command tree as JSON for programmatic discovery')
    .argument(
      '[command...]',
      'command path to describe on its own, e.g. "artifacts list"; omit for the full tree',
    )
    .addHelpText(
      'after',
      `
Pass no argument for the whole tree with its exit-code and error-code tables. Pass a command path
to get just that command's contract, which is the same document "<command> --schema" prints.

Examples:
  shelf schema
  shelf schema artifacts list
  shelf artifacts list --schema
`,
    )
    .action(async (segments: string[]) => {
      if (segments.length === 0) {
        result = await executeSchema(program);
        return;
      }
      const resolved = resolveCommandPath(program, segments);
      if (resolved === undefined) {
        throw usageFailure(`Unknown command path "${segments.join(' ')}".`);
      }
      result = describeCommandAt(resolved.command, resolved.path);
    });

  // Register --schema on every command by walking the tree, so a new command
  // inherits it automatically and the flag can never drift from the surface.
  const registerSchemaFlag = (command: Command): void => {
    command.option(SCHEMA_FLAG, "print this command's JSON contract and exit");
    for (const child of subcommandsOf(command, true)) registerSchemaFlag(child);
  };
  registerSchemaFlag(program);

  try {
    // Answer --schema before Commander parses, because parsing enforces
    // requiredOption and would reject "shelf artifacts show --schema" for a
    // missing --artifact. Resolving the path off the live tree keeps the
    // required options intact while still letting an agent read the contract.
    const userArgs = argv.slice(2);
    if (userArgs.includes(SCHEMA_FLAG)) {
      const segments: string[] = [];
      for (const token of userArgs) {
        if (token.startsWith('-')) break;
        segments.push(token);
      }
      if (segments.length === 0) {
        runtime.stdout(jsonLine(await executeSchema(program)));
        return CLI_EXIT_CODES.success;
      }
      const resolved = resolveCommandPath(program, segments);
      if (resolved === undefined) {
        throw usageFailure(`Unknown command path "${segments.join(' ')}".`);
      }
      runtime.stdout(jsonLine(describeCommandAt(resolved.command, resolved.path)));
      return CLI_EXIT_CODES.success;
    }

    await program.parseAsync([...argv]);
    if (result === undefined) throw usageFailure('A command is required.');
    await finalizeResult?.();
    runtime.stdout(jsonLine(result));
    return CLI_EXIT_CODES.success;
  } catch (error) {
    if (
      error instanceof CommanderError &&
      (error.code === 'commander.helpDisplayed' || error.code === 'commander.version')
    ) {
      return CLI_EXIT_CODES.success;
    }
    // A bare "shelf" or bare command group displays help but runs no command. Write the
    // help text to stdout and exit with the usage code.
    if (error instanceof CommanderError && error.code === 'commander.help') {
      if (suppressedHelp.length > 0) runtime.stdout(suppressedHelp);
      return CLI_EXIT_CODES.usage;
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
