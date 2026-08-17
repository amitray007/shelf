# Shelf

Shelf is an open-source, self-hostable home for publishing versioned artifacts.
It accepts individual files or complete folders, preserves their revision history, and produces links that can follow the latest revision or remain pinned to an exact one.

Shelf is designed for both people and agents: the dashboard and CLI are first-class ways to publish, compare, restore, organize, share, import, and export artifacts.

## Project status

Shelf now has a validated TypeScript service-first foundation: Fastify for the API, Commander for the CLI, framework-independent publishing and read services, and a generated OpenAPI contract.
PostgreSQL with Kysely is the authoritative metadata path. Content can use a hardened single-host local-filesystem adapter or Cloudflare R2 through a provider-neutral S3-protocol adapter; AWS S3 and native providers can be added behind the same core interfaces.

The persistence slice proves durable idempotent single-file publishing, stable artifact updates and history, restart recovery, multipart object upload, and byte-range delivery. The authentication foundation uses Better Auth for closed-registration owner sessions and Shelf-owned, workspace-scoped agent credentials with rotation, revocation, and audit history. A production server and host-local operator CLI now make that path runnable through the single-host Docker Compose alpha. The operator can perform an age-gated, read-only reconciliation scan across PostgreSQL and either content adapter, plus an offline PostgreSQL/Local File backup and verified empty-target restore on a host with PostgreSQL client tools. Compose-volume orchestration, R2 backup/recovery, destructive cleanup policy, administrative password recovery, and live R2 conformance remain intentionally incomplete.

React with Vite and React Router remains the accepted dashboard stack, but the dashboard is intentionally absent until a dashboard behavior enters the active implementation scope.

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
```

Set `SHELF_TOKEN` before these commands. Publish another immutable revision with the same stable artifact identity by adding `--artifact art_...` and using a new idempotency key.

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
- Treat files, folders, and collections as useful publishing units.
- Give humans and agents predictable, equivalent capabilities.
- Remain portable between self-hosted installations.
- Render active content safely and preserve a clear trust boundary for viewers.

## Documentation

- [Product contract](docs/plans/2026-08-17-0030-feat-shelf-product-plan.md)
- [Decision register](docs/decisions/README.md)
- [Persistence and content-storage operation](docs/operations/persistence.md)
- [Authentication and authorization operation](docs/operations/authentication.md)
- [Single-host self-hosting](docs/operations/self-hosting.md)
