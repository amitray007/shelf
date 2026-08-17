# Shelf Decision Register

This register shows which choices are settled and which remain open.
The [Product Contract](../plans/2026-08-17-0030-feat-shelf-product-plan.md) owns normative product behavior; this file tracks decision state and links back to the owning requirements.

## Accepted product decisions

| ID | Decision | Contract authority |
|---|---|---|
| D1 | The product is named Shelf and its portable user-facing CLI is named exactly `shelf`; host-local administration remains the separate `shelf-admin` executable. | R1 and Key Decisions |
| D2 | Shelf is a durable publishing workspace rather than an expiry-first file drop. | R2-R7 and R14-R17 |
| D3 | Files and complete folders are publishing units. | R2-R7 |
| D4 | Revision history, comparison, and source-linked restore-as-latest are core behavior; restore never rewrites earlier revisions. | R3-R6 |
| D5 | Visibility and latest-versus-pinned share targets are core behavior. | R10-R13 |
| D6 | Dashboard and agent-safe CLI access are both first-class. | R14-R19 |
| D7 | Provenance and metadata are part of every revision. | R3 and R20 |
| D8 | Collections are shareable groups of artifact references. | R9 |
| D9 | Import, export, and portable ownership are core behavior. | R18-R19 and R22-R24 |
| D10 | Shelf is open source and self-hostable without a mandatory proprietary dependency. | R22-R25 |

## Accepted technical decisions

| ID | Decision | Rationale and boundary |
|---|---|---|
| T1 | Shelf uses a TypeScript service-first modular monolith: Node.js 24 LTS, TypeScript 7, pnpm workspaces, Fastify 5 for `/api/v1`, React 19 with Vite 8 and React Router 8 Data Mode for the dashboard, and Commander 15 for the CLI. | Chosen after comparing a Go core, Next.js, and the current TypeScript server field. It keeps the dashboard, API, CLI, and domain model in one language while preserving versioned HTTP and OpenAPI as the durable external contract. This choice does not require the dashboard to ship before dashboard behavior enters scope. |
| T2 | PostgreSQL is Shelf's authoritative v1 metadata database, accessed through Kysely and `pg` with explicit reviewed migrations. Content storage remains behind core ports, with a local-filesystem adapter for a single-host self-hosted profile and a generic S3-protocol adapter configured and tested first for Cloudflare R2. | PostgreSQL provides the transaction, uniqueness, and locking semantics required for durable idempotency and immutable revision visibility. Local storage keeps core operation free of proprietary dependencies; R2 is an optional hosted data plane. Provider configuration is not stored in revision records. AWS S3 can reuse the S3 adapter after conformance testing; GCP or another native backend can implement the same ports. Provider recovery, live R2 qualification, and deployment remain T5 work rather than hidden assumptions of T2. |
| T3 | Better Auth provides self-hosted human identity and PostgreSQL-backed browser sessions, while Shelf owns actors, opaque CLI/agent access credentials, relational workspace/action grants, rotation, revocation, and authentication audit events. | Better Auth keeps password, cookie, session, recovery, and future external-provider mechanics out of Shelf's domain code without introducing a mandatory hosted dependency. Shelf credentials remain separate because their stable actor identity and workspace grants are part of provenance and authorization, not merely login. Better Auth Organizations, its API Key and Agent Auth plugins, open registration, social login, passkeys, and multi-user roles are not enabled by this decision. Exact Better Auth versions and generated schema changes are pinned, reviewed, and applied through explicit migrations. |
| T5a | Shelf's first runnable self-host profile is a Docker Compose reference deployment with one API process, PostgreSQL, and a durable local-content volume. Migrations and owner/credential administration remain explicit one-shot operator commands. | This is the smallest environment that proves Shelf can actually be installed, initialized, published to, stopped, and restarted without adding Kubernetes or a hosted dependency. It is a reference alpha profile, not completion of T5: Compose-volume/provider recovery, destructive cleanup, administrative recovery, TLS/reverse-proxy qualification, and live R2 conformance remain open. |
| T5b | Shelf's first reconciliation capability is a host-local, provider-neutral, read-only scan. It compares installation-scoped PostgreSQL references with local or S3-protocol inventory, applies a 24-hour default age gate, reports stable JSON, and has no deletion operation. | Read-only classification provides operator visibility without turning an observation into an unsafe cleanup decision. Missing and size-mismatched referenced content is always reported; unreferenced sealed objects and staging become candidates only after the age gate. Destructive cleanup must later perform a fresh metadata check and remains open with provider/Compose recovery, TLS qualification, and live R2 conformance under T5. |
| T5c | Shelf's first backup/recovery contract is an offline host-native workflow for PostgreSQL plus Local File storage. The operator confirms the exact installation has no active writers; Shelf proves the database contains no other installation, rejects unrecognized local entries, and writes a PostgreSQL custom dump, complete local-content tar, checksums, and a versioned manifest of every referenced immutable content descriptor. Restore accepts only the same exclusive installation, an empty database, and an absent content root, then verifies migration state and every referenced byte count/hash before success. | Immutable referenced content lets an offline dump and content archive form a verifiable recovery point without a database/storage distributed snapshot. Refusing in-place replacement keeps the first restore path non-destructive. The backup directory is sensitive and operator-owned. Docker Compose named-volume automation, R2/provider recovery, online snapshots, PITR, retention, and destructive cleanup remain separate T5 work. |
| T9 | Folder revisions use a canonical `shelf-folder-manifest/v1` over independently sealed regular-file objects and explicit directories. PostgreSQL commits the revision and complete entry set atomically. Paths are conservative NFC-normalized relative POSIX paths; symlinks, special files, aliases, and cross-platform-unsafe segments are rejected. Initial defaults cap a snapshot at 1,000 files, 2,000 entries, 10 MiB per file, 100 MiB aggregate bytes, and a 2 MiB transport manifest. | Per-entry immutable objects keep browsing, restore, reconciliation, backup, and later comparison provider-neutral without repeatedly unpacking an archive. Conservative paths make snapshots portable between self-hosted installations and common filesystems. These are the first folder transport limits, not a final decision on revision count, bandwidth, or operator policy. |

## Working defaults

These defaults make the current Product Contract coherent, but they may be revised before implementation reaches them.

| ID | Working default | Contract authority |
|---|---|---|
| W1 | The first release has one owner and multiple isolated workspaces. | R8 and Dependencies and Assumptions |
| W2 | A folder revision is an atomic snapshot of the complete directory. | R3-R6 |
| W3 | Artifact, revision, and share lifetimes are independent. | R12-R13 |
| W4 | A collection is live, while each artifact reference may follow latest or pin a revision. | R9 and Dependencies and Assumptions |
| W5 | Restore creates a new revision and never rewrites history. | R5 and AE2 |
| W6 | Rendered active content is isolated from Shelf's authenticated application. | R21 and AE5 |
| W7 | Artifacts start private, shares start unlisted, and public indexing is separately enabled. | R10 |
| W8 | Artifacts and revisions do not expire automatically, and explicit deletion has a 30-day recovery period. | R13 |
| W9 | Provenance is immutable while later metadata edits are retained as auditable events. | R20 |
| W10 | Artifact, revision, and share URLs remain stable across renames and later publishes. | R2-R3, R11, and AE9 |

## Open product decisions

| ID | Decision to make | Why it matters |
|---|---|---|
| P1 | Initial renderable and comparable formats | Defines the first useful content coverage beyond HTML and Markdown. |
| P2 | Limits beyond the accepted first folder transport defaults, including revision-count, bandwidth, archive-download, and operator override policy | Makes failure behavior predictable for operators and agents without treating one safe initial envelope as the complete resource policy. |
| P3 | Password-protected share behavior | Determines whether passwords supplement or replace authenticated access policies. |

## Open technical decisions

| ID | Decision to make | Constraint already known |
|---|---|---|
| T4 | CLI packaging and distribution | Must be easy for humans and agents to install across supported platforms. |
| T5 | Complete self-host deployment shape beyond the T5a-T5c reference, reconciliation, and host-native recovery profiles | Must still include Compose-volume and R2 recovery, online/PITR policy, upgrade, destructive cleanup policy, TLS/reverse-proxy qualification, live R2 conformance, and administrative recovery paths. |
| T6 | Renderer and diff adapters | Must enforce the safety boundary and degrade cleanly for unsupported formats. |
| T7 | Bulk manifest and export formats | Must preserve per-item results, history, metadata, and relationships. |
| T8 | Candidate interface components | Evaluate `@pierre/trees` and `@pierre/diffs` against the eventual stack and licensing requirements. |

## Deferred capabilities

- Comments and anchored annotations
- Live analytics
- Custom domains
- Public profiles
- Multi-user teams and hosted multi-tenancy
- Real-time viewer updates

When a decision is made, update the Product Contract first if behavior changes, then move or replace the corresponding register entry.
