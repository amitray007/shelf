# Persistence and content storage comparison for Shelf

**Status:** research note, not a decision
**Date checked:** 2026-08-17
**Scope:** PostgreSQL versus SQLite for authoritative metadata; S3-compatible object storage versus a local filesystem for immutable content; narrow Node.js/TypeScript implementation choices

## Recommendation

Use **PostgreSQL as Shelf's only production metadata database for v1** and make **S3-compatible object storage the reference production content backend**.

A hardened **local-filesystem content adapter is worth supporting as an explicitly single-node deployment profile**, because it materially lowers the self-hosting floor. It should not be presented as equivalent to S3 for replicas, failover, or independent API scaling. Defer SQLite until there is demonstrated demand for a true one-process appliance; do not carry two SQL dialects through Shelf's first schema and migration history merely because both are possible.

The coherent profiles are therefore:

| Profile | Metadata | Content | Shelf recommendation |
|---|---|---|---|
| Reference production | PostgreSQL | S3-compatible | **Default.** Supports multiple API processes and keeps bytes off application-local disks. |
| Simple single-node | PostgreSQL | Local filesystem | **Supported option, after hardening.** One database service remains, but no object-storage service is required. |
| Appliance, later | SQLite | Local filesystem | **Defer.** Attractive operationally, but commits Shelf to a second dialect and a host-bound write topology. |
| Mismatched | SQLite | S3-compatible | **Do not prioritize.** It pays for remote object storage while metadata still anchors the service to one host and one concurrent writer. |

This is a Shelf-specific recommendation, not a claim that PostgreSQL or S3 is universally better. SQLite plus files is excellent for a genuinely local appliance. Shelf's planned workspaces, scoped credentials, share links, retention jobs, and agent concurrency make that constraint likely to arrive sooner than the saved database service is worth. Collections were part of the product model when this comparison began and have since been removed; that removal does not change the concurrency or durability conclusion.

## Verified database facts

| Concern | PostgreSQL | SQLite |
|---|---|---|
| Atomic metadata commit | Transactions, foreign keys, composite unique constraints, row locks, and `INSERT ... ON CONFLICT` are first-class. PostgreSQL can also run a transaction at `SERIALIZABLE` and abort one participant when concurrent behavior cannot match a serial execution. ([constraints](https://www.postgresql.org/docs/current/ddl-constraints.html), [`INSERT`](https://www.postgresql.org/docs/current/sql-insert.html), [transaction isolation](https://www.postgresql.org/docs/current/sql-set-transaction.html), [locking](https://www.postgresql.org/docs/current/explicit-locking.html)) | Transactions and unique constraints can express Shelf's atomic visibility and idempotency invariants on one database. The limiting fact is concurrency, not transactional correctness. ([transactions](https://www.sqlite.org/lang_transaction.html), [conflict handling](https://www.sqlite.org/lang_conflict.html)) |
| Concurrent writers | PostgreSQL uses MVCC and row-level locking; competing changes can be serialized around the rows or unique keys they actually contend on. | SQLite permits multiple concurrent readers but only **one simultaneous write transaction**. A competing writer can receive `SQLITE_BUSY`. ([transactions](https://www.sqlite.org/lang_transaction.html)) |
| Multiple app processes or hosts | PostgreSQL uses a client/server model in which multiple clients connect to a server process. ([architecture](https://www.postgresql.org/docs/current/tutorial-arch.html)) | WAL lets readers and a writer proceed concurrently across processes on the same host, but it still has one writer and WAL does not work over a network filesystem because the processes share a WAL index in memory. ([WAL](https://www.sqlite.org/wal.html)) |
| Operational floor | Requires a separately operated service, connection limits, upgrades, and credentials. | One database file and an embedded library. SQLite's own guidance favors it for device-local storage with low writer concurrency. ([appropriate uses](https://www.sqlite.org/whentouse.html)) |
| Backup and recovery | `pg_dump` creates a consistent logical backup while the database remains in use; PostgreSQL also documents physical backups and continuous WAL archiving/PITR. ([backup approaches](https://www.postgresql.org/docs/18/backup.html), [`pg_dump`](https://www.postgresql.org/docs/current/app-pgdump.html)) | The Online Backup API makes a snapshot while briefly locking source pages; `VACUUM INTO` is another documented live-copy path. In WAL mode the `-wal` file is part of persistent state and must not be separated by a naive file copy. ([backup API](https://www.sqlite.org/backup.html), [WAL file handling](https://www.sqlite.org/wal.html)) |
| Node 24 path | The long-established `pg` driver is supported by Kysely's built-in PostgreSQL dialect; transactions must keep all statements on the same checked-out client. ([Kysely dialects](https://www.kysely.dev/), [`node-postgres` transactions](https://node-postgres.com/features/transactions)) | Node 24 includes `node:sqlite`, online backup, defensive mode, and a busy timeout, but the module is currently stability **1.2 / release candidate** and all `DatabaseSync` APIs execute synchronously. ([Node 24 SQLite](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)) |

### Shelf database inference

PostgreSQL gives the revision repository a direct implementation of KTD4 without a process-local mutex:

- enforce idempotency identity with a composite unique constraint over installation, workspace, actor, operation, and client key;
- insert or resolve that claim inside the same transaction that creates the artifact/revision, advances the latest pointer, and records the successful result;
- lock the artifact row when allocating a new revision ordinal or advancing its latest pointer;
- let concurrent processes wait on database constraints/row locks, then compare the committed fingerprint for replay versus conflict.

The default `READ COMMITTED` level plus explicit constraints and targeted row locks is likely sufficient. `SERIALIZABLE` should be introduced only for a demonstrated anomaly because callers must then retry serialization failures. The correctness proof should rest on database-enforced uniqueness, not on application pre-checks.

SQLite can implement the same logical transaction in one process, but the product would need busy-timeout/retry policy, WAL checkpoint operations, a same-host restriction, and a complete second migration/test matrix. Those are reasonable appliance costs later, not leverage for the first production repository.

## Verified content-store facts

| Concern | S3-compatible object storage | Local filesystem |
|---|---|---|
| Streaming and range reads | S3 `GetObject` supports a `Range` request; AWS SDK v3 returns a stream rather than buffering the object. The SDK's `@aws-sdk/lib-storage` supports streams of unknown size through multipart upload with configurable part size/concurrency and normally aborts multipart parts after failure. ([`GetObject`](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html), [SDK streaming](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/migrate-s3.html), [`lib-storage`](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-lib-storage/)) | Node can stream selected byte offsets with `createReadStream` and create a hard link for a same-filesystem no-clobber seal. Node warns that promise-based filesystem operations are not synchronized or threadsafe when code performs concurrent modifications, so the adapter must own its naming and locking invariants. ([Node filesystem API](https://nodejs.org/api/fs.html)) |
| Successful-write visibility | Amazon S3 provides strong read-after-write consistency for PUT/DELETE, and updates to one key are atomic: readers see old or new content, never a partial object. Other S3-compatible implementations must be tested rather than assumed identical. ([S3 consistency](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html)) | A file can be staged privately and sealed on the same filesystem, but crash durability depends on file and directory synchronization plus the host filesystem. Cross-device rename/link is not a valid seal primitive. |
| Preventing overwrite | Amazon S3 conditional writes support `If-None-Match: *` on `PutObject` and `CompleteMultipartUpload`; one concurrent creator wins and later attempts fail. Bucket policy can require conditional writes. Versioning and Object Lock offer additional recovery/WORM layers but are not substitutes for unique Shelf object keys. ([conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html), [policy enforcement](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html), [Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html)) | A server-generated final path and an exclusive create/hard-link operation can fail if the destination exists. A plain `rename` or default copy must not be treated as no-overwrite across platforms. ([Node filesystem API](https://nodejs.org/api/fs.html)) |
| Multiple API replicas | The content service is network-addressable, so every API process can read the same immutable key. | A local root binds reads to the host. Shared POSIX/NFS storage introduces filesystem-specific locking and durability assumptions and should be treated as a separate backend, not as “local files but clustered.” |
| Crash leftovers | Incomplete multipart uploads remain billable until aborted; AWS recommends a lifecycle rule using `AbortIncompleteMultipartUpload`. Completed objects that never receive a metadata reference remain sealed orphans. ([conditional multipart behavior](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)) | Request staging files and sealed-but-unreferenced files remain on disk after crashes unless scanned and reconciled. |
| Backup and portability | Versioning, replication, inventory, and lifecycle features vary by provider. They help operate a bucket but do not create a transactionally consistent Shelf backup by themselves. | Standard filesystem snapshot/copy tooling is simple on one host, but a raw copy is only useful if coordinated with metadata and garbage collection. |

### Shelf content-store inference

For either backend, allocate a cryptographically random permanent object key before reading the upload. The upload itself is not publicly readable. A successful close/completion is the **seal**; only the following PostgreSQL transaction makes a revision visible. This avoids requiring a database/object-store distributed transaction and matches the product plan's accepted orphan model.

For S3, use `If-None-Match: *` on both small-object PUT and multipart completion where the backend supports it. Require the adapter to pass a compatibility suite for:

1. streamed upload and cancellation;
2. conditional create under concurrent writers;
3. complete/abort multipart behavior;
4. `HEAD` followed by full and single-range `GET`;
5. checksum/byte-count agreement;
6. list/delete of objects under Shelf-owned prefixes for reconciliation.

“S3-compatible” is not one behavioral guarantee. AWS S3 should define the reference contract; alternate services qualify by tests. Shelf should not bundle one server as part of T2. Garage describes itself as an AGPLv3, lightweight S3 store for small-to-medium self-hosted deployments, while its own quick start warns that a single node has no redundancy. MinIO's current license page limits unlicensed current software to non-production evaluation, whereas older MinIO documentation describes AGPL deployments; selecting or redistributing either deserves a separate, current deployment/licensing review. ([Garage repository](https://github.com/deuxfleurs-org/garage), [Garage quick start](https://garagehq.deuxfleurs.fr/documentation/), [current MinIO license](https://docs.min.io/license/), [older MinIO license command](https://min.io/docs/minio/linux/reference/minio-mc/mc-license-info.html))

For a filesystem backend, require one Shelf API host, keep staging and sealed roots on the same filesystem, use restrictive permissions, seal without replacing an existing path, and prevent two independently configured Shelf installations from sharing a root. This is a production profile only after crash, permission, disk-full, backup, and recovery tests—not by relabeling the current temporary adapter.

## Backup, restore, export, and reconciliation

Database backup and content backup cannot be advertised as one atomic snapshot. Shelf can nevertheless make them consistent because referenced content is immutable:

1. pause retention and orphan deletion;
2. take a PostgreSQL snapshot/dump and record a backup identifier;
3. derive a manifest of every referenced storage key, hash, and byte count from that snapshot;
4. copy/snapshot those immutable objects and the manifest;
5. resume destructive jobs;
6. restore metadata and content, then verify every manifest entry before serving traffic.

Objects created after the database snapshot may be copied as harmless extras; a referenced object missing from the content backup is not harmless. The portable Shelf export format should remain independent of PostgreSQL dumps, S3 provider features, and filesystem layout.

Crash reconciliation needs two age-gated passes in both profiles:

- abort/remove incomplete request staging after a grace period;
- delete sealed content with no committed metadata reference only after a longer grace period and a fresh authoritative database check.

Never infer orphanhood from an eventually stale cache, an old backup manifest, or one failed metadata lookup. Log and meter candidates before deletion, and keep the destructive job independently disableable.

## Narrow TypeScript choices

### Database: Kysely + `pg`

Recommend **Kysely with its built-in PostgreSQL dialect and `pg`**, using frozen, reviewed migration files. Kysely is a type-safe SQL query builder rather than a data mapper; that is a better fit for Shelf's small repository port and PostgreSQL-specific correctness rules than hiding the critical write path behind a broader ORM abstraction.

| Concern | Kysely + `pg` | Drizzle ORM/Kit + `pg` | Prisma 7 + `@prisma/adapter-pg` |
|---|---|---|---|
| Atomic `commitPublish` | Callback transactions commit on success and roll back on exception. Kysely directly exposes composite or named-constraint `ON CONFLICT`, conditional conflict updates, `RETURNING`, and `FOR UPDATE`. ([transactions](https://www.kysely.dev/docs/examples/transactions/simple-transaction), [`ON CONFLICT`](https://kysely-org.github.io/kysely-apidoc/classes/InsertQueryBuilder.html), [row locks](https://kysely-org.github.io/kysely-apidoc/interfaces/SelectQueryBuilder.html)) | Callback transactions, savepoints, PostgreSQL isolation options, and composite conflict targets are first-class. It can express Shelf's transaction without dropping to an untyped repository. ([transactions](https://orm.drizzle.team/docs/transactions), [upserts](https://orm.drizzle.team/docs/guides/upsert)) | Interactive transactions can contain the whole operation, and compound unique constraints are queryable. However, Prisma delegates an upsert to PostgreSQL only under documented criteria that include one unique field; other concurrent upserts can fail with `P2002` and need retry. Shelf's composite idempotency claim and row locking would therefore use raw SQL or more retry machinery in the hottest path. ([transactions](https://www.prisma.io/docs/orm/prisma-client/queries/transactions), [`upsert`](https://www.prisma.io/docs/orm/reference/prisma-client-reference#upsert), [compound constraints](https://www.prisma.io/docs/orm/prisma-client/special-fields-and-types/working-with-composite-ids-and-constraints)) |
| Migration artifact | Official migrations are frozen TypeScript `up`/`down` functions using schema builders or the raw `sql` template; Kysely does **not** generate a standalone SQL diff. Exact SQL remains reviewable when PostgreSQL-specific DDL is authored through `sql`, but Shelf owns that discipline. ([migrations](https://www.kysely.dev/docs/migrations)) | Drizzle Kit derives timestamped `migration.sql` and snapshot files from a TypeScript schema; unsupported operations can use an empty custom SQL migration. This is the strongest code-first and reviewable-SQL workflow of the three. ([generate](https://orm.drizzle.team/docs/drizzle-kit-generate), [custom migrations](https://orm.drizzle.team/docs/kit-custom-migrations)) | Prisma Migrate also generates customizable `migration.sql` files, replays history in a shadow database during development, and applies committed history with `migrate deploy`. It has the most integrated drift workflow. ([overview](https://www.prisma.io/docs/orm/prisma-migrate), [development and production](https://www.prisma.io/docs/orm/prisma-migrate/workflows/development-and-production)) |
| Migration execution | The current PostgreSQL adapter acquires a session-level advisory lock, and the migrator runs the history in one transaction by default. Transactions can be deliberately disabled for PostgreSQL operations that cannot run inside one. ([migrator source](https://github.com/kysely-org/kysely/blob/v0.29.5/src/migration/migrator.ts#L540-L579), [PostgreSQL adapter](https://github.com/kysely-org/kysely/blob/v0.29.5/src/dialect/postgres/postgres-adapter.ts)) | The stable 0.45.2 PostgreSQL runner reads the latest applied migration before entering its transaction and has no advisory lock in that path. Shelf would have to guarantee a single migration job; its all-migrations transaction also excludes `CREATE INDEX CONCURRENTLY` without a separate path. The v1 documentation currently installs release-candidate packages and changes the migration layout, so do not base Shelf on that line without a fresh compatibility spike. ([stable runner source](https://github.com/drizzle-team/drizzle-orm/blob/0.45.2/drizzle-orm/src/pg-core/dialect.ts#L73-L112), [v1 upgrade](https://orm.drizzle.team/docs/upgrade-v1)) | `migrate deploy` uses advisory locking and committed SQL history, but the schema, configuration, migration CLI, generated client, and driver adapter are all additional moving pieces. ([deployment workflow](https://www.prisma.io/docs/orm/prisma-migrate/workflows/development-and-production), [Prisma 7 upgrade](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7)) |
| PostgreSQL-specific DDL | SQL-shaped builders plus unrestricted raw SQL keep expression/partial indexes, checks, and later retention optimizations available. Database types are hand-maintained or generated separately; Kysely itself does not require code generation. ([Kysely](https://www.kysely.dev/)) | The schema API covers composite unique/check constraints and rich partial, expression, concurrent, and operator-class indexes; custom SQL fills remaining gaps. ([indexes and constraints](https://orm.drizzle.team/docs/indexes-constraints)) | The feature matrix still lists expression and `INCLUDE` indexes as unavailable in Prisma Schema and partial-index syntax as preview. Unsupported DDL can be added by editing generated SQL, but then the Prisma schema is not a complete representation of the database. ([feature matrix](https://www.prisma.io/docs/orm/reference/database-features), [unsupported features](https://www.prisma.io/docs/orm/prisma-migrate/workflows/unsupported-database-features)) |
| Node 24 / TypeScript 7 / ESM | ESM-native, no runtime generator, and no extra build artifact beyond Shelf's TypeScript output. | ESM-native with no runtime client generator, but Drizzle Kit adds a TypeScript-executing CLI, schema snapshots, and a migration format currently changing on the v1 release-candidate line. | Node 24 and ESM are supported, but Prisma 7 requires an explicit generated-client output, `prisma generate`, a driver adapter, and Prisma configuration. That is valid but more build and deployment coupling than this repository port needs. ([Prisma 7 upgrade](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7), [client generation](https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/introduction)) |

The current Kysely recommendation therefore survives a closer comparison. Drizzle is the runner-up and has the better generated-SQL authoring experience, but Shelf would still need to constrain migration execution and accept a moving v1 boundary. Prisma has polished migrations, yet its generated client and composite-upsert caveat add machinery precisely where Shelf needs transparent PostgreSQL behavior.

Whichever query layer is selected, migration and repository acceptance must run against disposable **real PostgreSQL**, not a mock or SQLite substitute: create an empty database, apply the full history, verify constraints/indexes, run the concurrent replay/conflict/latest-pointer cases through separate pooled connections, and apply the history again as a no-op. Prisma documents the same container-start, migrate, test, destroy pattern; Kysely and Drizzle provide migrators but do not replace this Shelf-owned proof. ([Prisma integration testing](https://www.prisma.io/docs/orm/prisma-client/testing/integration-testing))

This recommendation is based on control of transactions and schema evolution, not package popularity. Do not use Kysely's availability of a SQLite dialect as a promise that one schema and migration set is portable; PostgreSQL and SQLite concurrency, types, indexing, and DDL semantics remain different. Keep Kysely, `pg`, and migration types entirely inside the PostgreSQL adapter package so neither `RevisionRepository` nor content-store adapters acquire database-library types.

### Object storage: AWS SDK for JavaScript v3

Use the modular **`@aws-sdk/client-s3`** client. Evaluate **`@aws-sdk/lib-storage`** for unknown-length multipart streams because its official API provides bounded part concurrency and abort support, but retain an explicit Shelf adapter around upload, seal, abort, conditional-write, and read-range behavior. ([AWS SDK v3](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/), [`lib-storage`](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-lib-storage/))

Before adopting the high-level uploader, spike whether it preserves Shelf's required `If-None-Match` semantics on multipart completion against AWS and at least one self-hosted S3 implementation. If it does not, implement the explicit multipart commands behind the same adapter rather than weakening no-overwrite behavior.

## Smallest implementation sequence

1. Implement the PostgreSQL revision repository with Kysely/`pg`; prove concurrent identical replay, conflicting idempotency reuse, latest-pointer serialization, rollback, and restart persistence against a real PostgreSQL process.
2. Keep the existing filesystem adapter only as test infrastructure while that repository lands; this isolates database correctness from a second new external system.
3. Implement the S3 adapter and its backend conformance suite, including cancellation, multipart cleanup, conditional creation, range reads, and post-seal/pre-commit orphan recovery.
4. Add the backup manifest and dry-run reconciliation commands before calling the profile production-ready.
5. Harden a separate filesystem adapter as the single-node profile if lowering the deployment floor is still a release priority. Do not block the PostgreSQL/S3 reference path on SQLite.

This sequence makes one durable decision at a time: PostgreSQL first, then the content backend behavior, then the optional convenience profile.
