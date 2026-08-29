# Shelf

Shelf is an open-source, self-hostable service for publishing versioned artifacts.

You publish a file or a complete folder from the CLI. Shelf stores it as an immutable revision. Shelf then gives you a link that you can share and revoke. A link can follow the latest revision, or it can stay pinned to one exact revision.

Shelf puts the CLI first, and the CLI is safe for agents to operate. The web dashboard is a companion. Use it to browse artifacts, view content, moderate discussions, and manage access.

## Features

- **Immutable revisions.** Every publish creates a new revision. History is permanent, and each revision records where it came from.
- **Files and folders.** Publish one file or a complete folder snapshot. There is no collection abstraction.
- **Automatic retention with Trash.** Artifacts without an active custom share move to Trash after a 30-day grace period. Trash remains recoverable for another 30 days before metadata and unreferenced content are purged. Important artifacts can be kept indefinitely.
- **Share links.** Protected links use a private capability. Public links use a short unlisted URL. Links can be permanent, expiring, or session-limited, and you can revoke them at any time. A Latest link can opt into bounded revision navigation.
- **Discussions.** Visitors and authenticated agents can start discussions anchored to a file or line range. Agents can reply and edit or delete their own posts; moderation remains separate.
- **Safe rendering.** A dark, content-first viewer supports Markdown, JSON/YAML, CSV/TSV, source text and code, raster images including AVIF, SVG, PDF, and browser-supported audio/video through constrained inline preview routes with byte-range delivery. Active HTML runs in a separate sandboxed renderer process. DOCX and XLSX have direct browser previews; legacy spreadsheets, presentations, and unsupported office formats keep an explicit download fallback.
- **Agent-first CLI.** One JSON document per run. Strict exit codes. No interactive prompts. Idempotency keys on every mutation.
- **Self-hostable.** One host with PostgreSQL. Content storage uses a local filesystem or Cloudflare R2.

## Quick start

Install the CLI with Homebrew:

```sh
brew tap amitray007/tap
brew install amitray007/tap/shelf
```

Then configure one profile and publish:

```sh
export SHELF_PERSONAL_TOKEN='shf_v1...'
shelf profiles set default --url https://shelf.example \
  --workspace workspace-main --credential-env SHELF_PERSONAL_TOKEN
shelf publish ./idea.html --title "Idea" --description "Interactive concept" --share
```

A profile stores the installation URL, the workspace, and a credential reference. It does not store a plaintext token. A credential reference points to a named environment variable or to the native keyring. If the keyring fails, Shelf does not fall back to plaintext.

## Server upload limits

The production server accepts authenticated single-file uploads up to 256 MiB by default. Set
`SHELF_MAX_FILE_BYTES` to a positive byte count to change the limit, up to the hard 1 GiB maximum.
The upload path streams into configured content storage, but a higher limit still increases network,
temporary-disk, and storage exposure. Keep any reverse-proxy request limit aligned with this value.

Folder snapshots keep their separate bounds: 10 MiB per file and 100 MiB total per snapshot.

## Sharing model

- Every new artifact prepares two permanent "Latest" links: one Protected and one Public. Shelf does not show either URL until you ask to share.
- **Protected links** need their private capability before a viewer session can begin. They can be permanent, expiring, session-limited, or any combination.
- **Public links** are short unlisted URLs without a secret. A finite Public link can last at most 30 days.
- Each link has a comment policy:
  - `off` — no comments.
  - `private` — visitors see only the discussions they started. Admins see all.
  - `shared` — everyone on the link sees shared discussions.
- Both link types can follow Latest or pin one revision. Both are excluded from search-engine indexing.
- A Latest link defaults to `target-only`. Add `--revision-access shared-history` to let viewers move between the revision current when the link was created and later revisions. Earlier revisions remain private. Pinned links always expose one exact revision.
- The shared viewer shows Previous, Next, and Latest controls for a shared-history link. It also checks for a newer revision when the tab becomes active, or when the viewer selects **Check updates**.
- Prepared default links do not keep an artifact active. Any non-default custom link keeps it active until it is revoked, expires, or exhausts its protected-session budget.

## CLI usage

The product CLI is named `shelf`. It talks only to the public `/api/v1` contract. `shelf-admin` is a separate host-local operator tool.

The CLI contract for programs and agents:

- Success writes one JSON document to stdout. Failure writes one redacted error envelope to stderr.
- Exit codes: `0` success, `1` unexpected, `2` usage, `3` authentication, `4` authorization, `5` validation, `6` transient (retry is safe). Every error envelope also carries a `retryable` boolean.
- There are no interactive prompts. Destructive commands need explicit flags: `--confirm <artifact-id>`, `--yes`, or `--overwrite`.
- Profile-mode publishing keeps a crash-safe journal. If a run is interrupted, the next run resumes it. It does not publish twice.
- `shelf publish --share` can partly succeed. If the publish lands but the share does not, the CLI exits non-zero and writes `"status": "partial"` to stderr with the completed `publish` result and its `urls`. The revision already exists, so retry only the share with `shelf shares create`. Re-running the publish is not needed.
- Tokens are never command-line arguments. Error output redacts tokens and protected share URLs.

Every remote command accepts `--profile <name>`. The explicit `--url` + `SHELF_TOKEN` form also works for automation that manages its own credentials. In this repository, run the built CLI with `pnpm shelf ...`.

```sh
# Artifacts
shelf artifacts list --profile default --search "notes" --sort updated
shelf artifacts show --profile default --artifact art_...
shelf artifacts resolve --profile default --from 'https://shelf.example/s/shr_...#capability'
shelf artifacts history --profile default --artifact art_...
shelf artifacts retention set --profile default --artifact art_... --mode keep
shelf artifacts rename --profile default --artifact art_... --name "Project notes"
shelf artifacts restore --profile default --artifact art_... --revision rev_... \
  --idempotency-key restore-1
shelf artifacts delete --profile default --artifact art_... --confirm art_...
shelf artifacts recover --profile default --artifact art_...
shelf trash list --profile default --search art_...
shelf trash show --profile default --artifact art_...
shelf trash recover --profile default --artifact art_...
shelf trash delete --profile default --artifact art_... --confirm art_...
shelf trash empty --profile default --confirm workspace-main

# Folders and revisions
shelf folders tree --profile default --revision rev_...
shelf folders download --profile default --revision rev_... --path docs/spec.md --output spec.md
shelf revisions compare --profile default --base rev_... --target rev_...
shelf revisions download --profile default --revision rev_... --output artifact.bin

# Shares
shelf shares defaults --profile default --artifact art_...
shelf shares create --profile default --artifact art_... --access public \
  --expires-in 24hr --idempotency-key public-share-1
shelf shares create --profile default --artifact art_... --access protected \
  --expires-in 7d --max-sessions 5 --idempotency-key protected-share-1
shelf shares create --profile default --artifact art_... --access protected \
  --revision-access shared-history --idempotency-key review-history-1
shelf shares list --profile default
shelf shares comments --profile default --share shr_... --comments shared
shelf shares revoke --profile default --share shr_...

# Discussions
shelf comments summaries --profile default --artifact art_... --artifact art_...
shelf comments list --profile default --artifact art_...
shelf comments create --profile default --artifact art_... --share shr_... \
  --revision rev_... --body "Please revisit this section."
shelf comments reply --profile default --artifact art_... --thread <thread-id> \
  --body "Fixed in the 4th revision." --display-name "Amit"
shelf comments edit --profile default --artifact art_... --post <post-id> --body "Updated note"
shelf comments delete --profile default --artifact art_... --post <post-id>
shelf comments resolve --profile default --artifact art_... --thread <thread-id>
shelf comments hide --profile default --artifact art_... --post <post-id>
```

Publishing rules:

- Positional publishing requires `--title` and `--description`. A human can skip them with `--user-bypass`.
- Add repeatable string metadata with `--metadata key=value`.
- To publish a new revision of an existing artifact, add `--artifact art_...`. Positional profile-mode publishing derives its own key from a content fingerprint, so `--idempotency-key` is not needed. The legacy `--file` form and `folders publish` require a new `--idempotency-key` for each new revision.
- Folder publishing includes regular files and empty directories. It rejects symlinks and special files. It never uploads an absolute host path.

The CLI has deliberate limits. Credential issuance, rotation, and revocation belong to the dashboard and `shelf-admin`. Workspace creation needs a human session. The CLI never accepts visitor capability secrets as arguments.

## Development

You need Node.js 24 and pnpm 10.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:browser
pnpm build
pnpm format:check
pnpm lint
pnpm test:streaming-memory
```

Install Playwright's pinned browsers once with `pnpm test:browser:install`. The browser suite starts an isolated production web preview and a fixture-backed instance of the real HTML renderer. It does not need PostgreSQL and does not use `.env.dev`.

For host-local development, install and start PostgreSQL. Then run:

```sh
pnpm dev:setup
pnpm dev
```

The first command creates a private `.env.dev`, a local content directory, and the `shelf_dev` database, and applies all migrations. It is safe to run again: it keeps an existing environment. The second command watches the workspace and starts the API at `http://127.0.0.1:3000`, the renderer at `http://localhost:3001`, and the web client at `http://127.0.0.1:5173`. The [host-local development guide](docs/operations/development.md) explains configuration, owner bootstrap, sign-in, and a first publish.

PostgreSQL integration tests need an explicitly supplied disposable-database authority:

```sh
SHELF_TEST_POSTGRES_URL=postgresql:///postgres pnpm exec vitest run \
  packages/postgres/test/revision-repository.test.ts \
  packages/postgres/test/auth-repository.test.ts \
  packages/auth/test/human-session.test.ts \
  apps/api/test/auth.integration.test.ts \
  apps/api/test/persistence.integration.test.ts
```

To self-host, follow the [single-host self-hosting guide](docs/operations/self-hosting.md).

## Architecture and status

Shelf is a TypeScript monorepo. The API uses Fastify and publishes a generated OpenAPI contract. The CLI uses Commander. The publishing, read, share, and comment services are framework-independent. PostgreSQL with Kysely is the authoritative metadata store. React, Vite, React Router, Tailwind CSS, and Cloudflare Kumo components power the viewer and the dashboard.

Authentication uses Better Auth for closed-registration owner sessions. Agent credentials are Shelf-owned, workspace-scoped, and support rotation, revocation, and audit history. There is no default credential and no automatic owner bootstrap.

Works today: idempotent publishing with restart recovery, multipart upload, portable folder-tree reads, revision comparison without content reads, byte-range delivery, reconciliation scans, and offline backup with verified restore, all runnable through the single-host Docker Compose alpha.

The [self-hosting guide](docs/operations/self-hosting.md) lists the current operational limitations, and the [product contract](docs/plans/2026-08-17-0030-feat-shelf-product-plan.md#product-delivery-roadmap) tracks the longer-term roadmap.

## Product principles

- Keep important artifacts durable while cleaning up abandoned artifacts through visible, recoverable lifecycle states.
- Make every revision immutable, and record where it came from.
- Treat files and complete folders as the publishing units.
- Make publishing and sharing quick from the CLI, with defaults that stay safe for agents.
- Keep the dashboard useful and polished, but secondary to the publish-to-link workflow.
- Stay portable between self-hosted installations.
- Render active content safely. Keep a clear trust boundary for viewers.

## Documentation

- [Product contract](docs/plans/2026-08-17-0030-feat-shelf-product-plan.md)
- [Decision register](docs/decisions/README.md)
- [Persistence and content-storage operation](docs/operations/persistence.md)
- [Authentication and authorization operation](docs/operations/authentication.md)
- [Single-host self-hosting](docs/operations/self-hosting.md)

## Contributing

Contributions are welcome. Read the [contributing guide](CONTRIBUTING.md) before you open a pull request. This project follows a [code of conduct](CODE_OF_CONDUCT.md). To report a security problem, follow the [security policy](SECURITY.md).

## License

Shelf is released under the [MIT License](LICENSE).
