# Shelf

Shelf is an open-source, self-hostable home for publishing versioned artifacts.
It accepts individual files or complete folders, preserves their revision history, and produces links that can follow the latest revision or remain pinned to an exact one.

Shelf is designed first around a fast, agent-safe CLI workflow: publish an artifact, receive a link, and optionally create a revocable share without losing the underlying revision history. The dashboard is a lightweight companion for browsing, viewing, and occasional lifecycle management rather than the center of the product.

## Project status

Shelf now has a validated TypeScript service-first foundation: Fastify for the API, Commander for the CLI, framework-independent publishing and read services, and a generated OpenAPI contract.
PostgreSQL with Kysely is the authoritative metadata path. Content can use a hardened single-host local-filesystem adapter or Cloudflare R2 through a provider-neutral S3-protocol adapter; AWS S3 and native providers can be added behind the same core interfaces.

The persistence slice proves durable idempotent file publishing and complete folder snapshots, stable artifact updates and history, mutable artifact names, restore-as-latest with source provenance, restart recovery, multipart object upload, portable folder-tree reads, provider-neutral revision comparison, and byte-range file delivery. File comparisons use immutable content descriptors; folder comparisons page deterministic added, removed, changed, and exact unambiguous moved entries without reading content storage. Folder manifests and their independently sealed file entries participate in reconciliation and backup verification. The authentication foundation uses Better Auth for closed-registration owner sessions and Shelf-owned, workspace-scoped agent credentials with rotation, revocation, and audit history. A production server and host-local operator CLI now make that path runnable through the single-host Docker Compose alpha. The operator can perform an age-gated, read-only reconciliation scan across PostgreSQL and either content adapter, plus an offline PostgreSQL/Local File backup and verified empty-target restore on a host with PostgreSQL client tools. Compose-volume orchestration, R2 backup/recovery, destructive cleanup policy, administrative password recovery, live R2 conformance, content-aware diff adapters, and the dashboard remain intentionally incomplete.

React with Vite and React Router remains the accepted dashboard stack, but the dashboard is intentionally absent until a dashboard behavior enters the active implementation scope.

The intended installed workflow is deliberately short: `shelf publish ./idea.html --share`. CLI profiles and share creation are not implemented yet, so the alpha commands below still require explicit installation, workspace, and idempotency arguments.

## Development

Requires Node.js 24 and pnpm 10.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
pnpm lint
pnpm test:streaming-memory
```

For host-local development, install and start PostgreSQL, then run:

```sh
pnpm dev:setup
pnpm dev
```

The first command creates a private ignored `.env.dev`, an ignored local-content directory, the
`shelf_dev` database when using local PostgreSQL, and applies all migrations. It is safe to rerun:
an existing environment or database is preserved. The second command watches the TypeScript
workspace and restarts the API at `http://127.0.0.1:3000`. See the
[host-local development guide](docs/operations/development.md) for configuration, owner bootstrap,
and publishing a test file.

The API remains injectable for tests and also ships explicit `shelf-server` and `shelf-admin` process boundaries. There is no default credential or automatic owner bootstrap. The portable product CLI is named exactly `shelf`; `shelf-admin` is a separate host-local operator tool. It uses only the public `/api/v1` contract and emits one JSON document on success or failure. During repository development, run the built CLI with `pnpm shelf ...`:

```sh
pnpm shelf publish --url https://shelf.example --workspace workspace-main \
  --file README.md --idempotency-key readme-1
pnpm shelf artifacts list --url https://shelf.example --workspace workspace-main
pnpm shelf artifacts show --url https://shelf.example --artifact art_...
pnpm shelf artifacts history --url https://shelf.example --artifact art_...
pnpm shelf artifacts rename --url https://shelf.example --artifact art_... --name "Project notes"
pnpm shelf artifacts restore --url https://shelf.example --workspace workspace-main \
  --artifact art_... --revision rev_... --idempotency-key restore-1
pnpm shelf folders publish --url https://shelf.example --workspace workspace-main \
  --directory ./my-project --idempotency-key project-1
pnpm shelf folders tree --url https://shelf.example --revision rev_...
pnpm shelf revisions compare --url https://shelf.example \
  --base rev_... --target rev_...
```

Set `SHELF_TOKEN` before these commands. Publish another immutable file revision or complete folder snapshot with the same stable artifact identity by adding `--artifact art_...` and using a new idempotency key. Folder publishing includes regular files and empty directories, rejects symlinks and special files, and never uploads an absolute host path. Rename changes only artifact presentation. Restore creates a new latest revision and leaves the selected source plus all later history unchanged. Comparison accepts two revisions of the same artifact; folder change pages use `--limit` and `--cursor` and never download stored file bytes.

For the runnable local profile, follow the [single-host self-hosting guide](docs/operations/self-hosting.md). The delivery roadmap is maintained in the [product contract](docs/plans/2026-08-17-0030-feat-shelf-product-plan.md#product-delivery-roadmap).

PostgreSQL integration tests require an explicitly supplied disposable-database authority:

```sh
SHELF_TEST_POSTGRES_URL=postgresql:///postgres pnpm exec vitest run \
  packages/postgres/test/revision-repository.test.ts \
  packages/postgres/test/auth-repository.test.ts \
  packages/auth/test/human-session.test.ts \
  apps/api/test/auth.integration.test.ts \
  apps/api/test/persistence.integration.test.ts
```

## Product principles

- Keep artifacts durable while allowing shares to expire or be revoked independently.
- Make every revision immutable and explain where it came from.
- Treat files and complete folders as useful publishing units; Shelf has no collection abstraction.
- Make publishing and sharing quick from the CLI, with explicit defaults that remain safe for agents.
- Keep the dashboard useful and polished, but secondary to the publish-to-link workflow.
- Remain portable between self-hosted installations.
- Render active content safely and preserve a clear trust boundary for viewers.

## Documentation

- [Product contract](docs/plans/2026-08-17-0030-feat-shelf-product-plan.md)
- [Decision register](docs/decisions/README.md)
- [Persistence and content-storage operation](docs/operations/persistence.md)
- [Authentication and authorization operation](docs/operations/authentication.md)
- [Single-host self-hosting](docs/operations/self-hosting.md)
