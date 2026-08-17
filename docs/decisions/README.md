# Shelf Decision Register

This register shows which choices are settled and which remain open.
The [Product Contract](../plans/2026-08-17-0030-feat-shelf-product-plan.md) owns normative product behavior; this file tracks decision state and links back to the owning requirements.

## Accepted product decisions

| ID | Decision | Contract authority |
|---|---|---|
| D1 | The product is named Shelf. | R1 and Key Decisions |
| D2 | Shelf is a durable publishing workspace rather than an expiry-first file drop. | R2-R7 and R14-R17 |
| D3 | Files and complete folders are publishing units. | R2-R7 |
| D4 | Revision history, comparison, and restore are core behavior. | R3-R6 |
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
| T2 | PostgreSQL is Shelf's authoritative v1 metadata database, accessed through Kysely and `pg` with explicit reviewed migrations. Content storage remains behind core ports, with a local-filesystem adapter for a single-host self-hosted profile and a generic S3-protocol adapter configured and tested first for Cloudflare R2. | PostgreSQL provides the transaction, uniqueness, and locking semantics required for durable idempotency and immutable revision visibility. Local storage keeps core operation free of proprietary dependencies; R2 is an optional hosted data plane. Provider configuration is not stored in revision records. AWS S3 can reuse the S3 adapter after conformance testing; GCP or another native backend can implement the same ports. Backup, reconciliation, live R2 qualification, and deployment remain T5 work rather than hidden assumptions of T2. |
| T3 | Better Auth provides self-hosted human identity and PostgreSQL-backed browser sessions, while Shelf owns actors, opaque CLI/agent access credentials, relational workspace/action grants, rotation, revocation, and authentication audit events. | Better Auth keeps password, cookie, session, recovery, and future external-provider mechanics out of Shelf's domain code without introducing a mandatory hosted dependency. Shelf credentials remain separate because their stable actor identity and workspace grants are part of provenance and authorization, not merely login. Better Auth Organizations, its API Key and Agent Auth plugins, open registration, social login, passkeys, and multi-user roles are not enabled by this decision. Exact Better Auth versions and generated schema changes are pinned, reviewed, and applied through explicit migrations. |
| T5a | Shelf's first runnable self-host profile is a Docker Compose reference deployment with one API process, PostgreSQL, and a durable local-content volume. Migrations and owner/credential administration remain explicit one-shot operator commands. | This is the smallest environment that proves Shelf can actually be installed, initialized, published to, stopped, and restarted without adding Kubernetes or a hosted dependency. It is a reference alpha profile, not completion of T5: backup, restore, reconciliation, administrative recovery, TLS/reverse-proxy qualification, and live R2 conformance remain open. |

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
| P2 | Size, file-count, revision-count, and bandwidth limits | Makes failure behavior predictable for operators and agents. |
| P3 | Password-protected share behavior | Determines whether passwords supplement or replace authenticated access policies. |

## Open technical decisions

| ID | Decision to make | Constraint already known |
|---|---|---|
| T4 | CLI packaging and distribution | Must be easy for humans and agents to install across supported platforms. |
| T5 | Complete self-host deployment shape beyond the T5a reference profile | Must include upgrade, backup, restore, reconciliation, TLS/reverse-proxy qualification, health, and administrative recovery paths. |
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
