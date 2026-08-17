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
| D6 | The agent-safe CLI is Shelf's primary publishing and lifecycle surface. The dashboard is a polished but deliberately lightweight utility for browsing, viewing, and occasional management. | R14-R19 and R26 |
| D7 | Provenance and metadata are part of every revision. | R3 and R20 |
| D8 | Shelf has no collection abstraction; shares target one artifact or one exact revision. | R9-R13 |
| D9 | Import, export, and portable ownership are core behavior. | R18-R19 and R22-R24 |
| D10 | Shelf is open source and self-hostable without a mandatory proprietary dependency. | R22-R25 |

## Accepted technical decisions

| ID | Decision | Rationale and boundary |
|---|---|---|
| T1 | Shelf uses a TypeScript service-first modular monolith: Node.js 24 LTS, TypeScript 7, pnpm workspaces, Fastify 5 for `/api/v1`, React 19 with Vite 8 and React Router 8 Data Mode for the dashboard, and Commander 15 for the CLI. | Chosen after comparing a Go core, Next.js, and the current TypeScript server field. It keeps the dashboard, API, CLI, and domain model in one language while preserving versioned HTTP and OpenAPI as the durable external contract. This choice does not require the dashboard to ship before dashboard behavior enters scope. |
| T2 | PostgreSQL is Shelf's authoritative v1 metadata database, accessed through Kysely and `pg` with explicit reviewed migrations. Content storage remains behind core ports, with a local-filesystem adapter for a single-host self-hosted profile and a generic S3-protocol adapter configured and tested first for Cloudflare R2. | PostgreSQL provides the transaction, uniqueness, and locking semantics required for durable idempotency and immutable revision visibility. Local storage keeps core operation free of proprietary dependencies; R2 is an optional hosted data plane. Provider configuration is not stored in revision records. AWS S3 can reuse the S3 adapter after conformance testing; GCP or another native backend can implement the same ports. Provider recovery, live R2 qualification, and deployment remain T5 work rather than hidden assumptions of T2. |
| T3 | Better Auth provides self-hosted human identity and PostgreSQL-backed browser sessions, while Shelf owns actors, opaque CLI/agent access credentials, relational workspace/action grants, rotation, revocation, and authentication audit events. | Better Auth keeps password, cookie, session, recovery, and future external-provider mechanics out of Shelf's domain code without introducing a mandatory hosted dependency. Shelf credentials remain separate because their stable actor identity and workspace grants are part of provenance and authorization, not merely login. Better Auth Organizations, its API Key and Agent Auth plugins, open registration, social login, passkeys, and multi-user roles are not enabled by this decision. Exact Better Auth versions and generated schema changes are pinned, reviewed, and applied through explicit migrations. |
| T4a | Shelf CLI profiles are versioned, source-owned configuration in the operating system's standard per-user config directory. A profile binds exactly one installation origin, default workspace, insecure-loopback policy, and non-secret credential reference. Credential material lives either in the native OS keyring or in one explicitly named environment variable; keyring failure is fatal and never falls back to plaintext. The reserved `default` profile is used only when `--profile` is absent, while a complete legacy flag context remains available without mixing fields from a profile. Profile and local operation-state writes are atomic, refuse links, and use owner-only permissions. | This is the smallest portable configuration decision needed for U19 without prematurely choosing package managers or release channels under T4. Explicit credential references keep personal and work authority separate, allow headless agents to use environment injection, and avoid hidden token precedence. A local response-loss journal may retain generated idempotency keys and committed public identifiers, but never credentials or capability-bearing share URLs. |
| T5a | Shelf's first runnable self-host profile is a Docker Compose reference deployment with one application/API process, one separately credentialed active-HTML renderer process, PostgreSQL, and a durable local-content volume. The application process serves the built dark web client; the renderer receives no authentication secret. Migrations and owner/credential administration remain explicit one-shot operator commands. | This is the smallest environment that proves a generated share URL can actually be installed, opened, stopped, and restarted without adding Kubernetes or a hosted dependency. It is a reference alpha profile, not completion of T5: least-privilege renderer database/storage credentials, Compose-volume/provider recovery, destructive cleanup, administrative recovery, TLS/reverse-proxy qualification, and live R2 conformance remain open. |
| T5b | Shelf's first reconciliation capability is a host-local, provider-neutral, read-only scan. It compares installation-scoped PostgreSQL references with local or S3-protocol inventory, applies a 24-hour default age gate, reports stable JSON, and has no deletion operation. | Read-only classification provides operator visibility without turning an observation into an unsafe cleanup decision. Missing and size-mismatched referenced content is always reported; unreferenced sealed objects and staging become candidates only after the age gate. Destructive cleanup must later perform a fresh metadata check and remains open with provider/Compose recovery, TLS qualification, and live R2 conformance under T5. |
| T5c | Shelf's first backup/recovery contract is an offline host-native workflow for PostgreSQL plus Local File storage. The operator confirms the exact installation has no active writers; Shelf proves the database contains no other installation, rejects unrecognized local entries, and writes a PostgreSQL custom dump, complete local-content tar, checksums, and a versioned manifest of every referenced immutable content descriptor. Restore accepts only the same exclusive installation, an empty database, and an absent content root, then verifies migration state and every referenced byte count/hash before success. | Immutable referenced content lets an offline dump and content archive form a verifiable recovery point without a database/storage distributed snapshot. Refusing in-place replacement keeps the first restore path non-destructive. The backup directory is sensitive and operator-owned. Docker Compose named-volume automation, R2/provider recovery, online snapshots, PITR, retention, and destructive cleanup remain separate T5 work. |
| T6 | Shelf's first renderer supports escaped UTF-8 text, source and JSON; sanitized Markdown with raw HTML disabled; raster images; folder trees; and self-contained HTML. HTML is the only initial active format and runs only from a separately configured renderer hostname/origin and process inside an iframe sandbox without same-origin, form, popup, download, or top-navigation privileges. The application rejects a renderer configured on its own hostname, and the renderer rejects cookie-bearing render requests. CSP denies fetch, XHR, and subresource networking. A closure-held runtime channel distinguishes the renderer's completed first document from a parse-time replacement; the parent blanks an incomplete handshake and every later iframe navigation. Browsers may still issue one own-frame navigation request before that guard runs, so Shelf does not claim zero egress for arbitrary HTML. SVG, PDF, media that is not explicitly allowlisted, and other binaries remain download-only. A single-hostname or strict zero-egress installation remains download-only for HTML. | The allowlist makes unsupported behavior explicit while giving agent-produced HTML a useful Claude-Artifact-like path. A separate hostname, no application authentication secret or session cookie, a credentialless hint, sandboxing, CSP, private completion handshake, no-referrer responses, no-store caching, and navigation termination form complementary boundaries; media-type sniffing never promotes a download into an inline renderer. Least-privilege renderer database/storage credentials and content-aware diff adapters remain open under T5/P1. |
| T8 | Shelf's web application uses React Router Data Mode, Tailwind CSS 4 for product layout, Geist Sans/Mono, and Cloudflare Kumo as its single managed dark component system. Kumo's Base UI substrate owns generic interaction behavior; Shelf owns the artifact map bar, viewer, inspector composition, semantic tokens, and safe renderer boundaries. Phosphor is the icon language. Additional UI packages must own one deep accepted behavior, remain isolated behind a Shelf adapter, and pass keyboard, reduced-motion, zoom, browser, and bundle checks. beUI and shadcn remain references rather than parallel visual systems. | The direct-primitive implementation demonstrated that Shelf was maintaining more than 1,400 lines of dashboard CSS while receiving package behavior only for Dialog. A real Kumo-versus-HeroUI artifact-screen spike selected Kumo because it preserves the accepted Base UI/Tailwind foundation while outsourcing polished controls, fields, menus, dialogs, tables, toast, clipboard, loading, and code components. The interface remains a lightweight artifact utility rather than a provider-themed dashboard. `@pierre/trees` stays conditional on a beta qualification spike; `@pierre/diffs` stays deferred until content-aware comparison exists. The [Shelf Interface Standard](../design/shelf-interface-standard.md) governs composition and quality. |
| T9 | Folder revisions use a canonical `shelf-folder-manifest/v1` over independently sealed regular-file objects and explicit directories. PostgreSQL commits the revision and complete entry set atomically. Paths are conservative NFC-normalized relative POSIX paths; symlinks, special files, aliases, and cross-platform-unsafe segments are rejected. Initial defaults cap a snapshot at 1,000 files, 2,000 entries, 10 MiB per file, 100 MiB aggregate bytes, and a 2 MiB transport manifest. | Per-entry immutable objects keep browsing, restore, reconciliation, backup, and later comparison provider-neutral without repeatedly unpacking an archive. Conservative paths make snapshots portable between self-hosted installations and common filesystems. These are the first folder transport limits, not a final decision on revision count, bandwidth, or operator policy. |
| T10 | Shelf's first revision comparison is a provider-neutral metadata operation over immutable file descriptors and complete folder entry sets. It compares only two revisions of the same artifact and kind, returns at most 100 folder changes per cursor-bound page, and never opens content storage. A moved file is reported only for a unique removed/added pair with the same content hash and byte count; ambiguous duplicates remain additions and removals. | Exact descriptor comparison is deterministic across Local File, R2, and future providers and supplies the stable API/CLI input for later dashboard presentation. It does not choose renderable formats, inspect file contents, infer ambiguous renames, or settle T6/T8 diff and interface adapters. |

## Working defaults

These defaults make the current Product Contract coherent, but they may be revised before implementation reaches them.

| ID | Working default | Contract authority |
|---|---|---|
| W1 | The first release has one owner and multiple isolated workspaces. | R8 and Dependencies and Assumptions |
| W2 | A folder revision is an atomic snapshot of the complete directory. | R3-R6 |
| W3 | Artifact, revision, and share lifetimes are independent. | R12-R13 |
| W4 | A share targets one artifact's latest revision or one exact revision; grouping multiple artifacts is outside Shelf's product model. | R9-R11 and Dependencies and Assumptions |
| W5 | Restore creates a new revision and never rewrites history. | R5 and AE2 |
| W6 | Rendered active content is isolated from Shelf's authenticated application. | R21 and AE5 |
| W7 | Artifacts start private, shares start unlisted, and public indexing is separately enabled. | R10 |
| W8 | Artifacts and revisions do not expire automatically, and explicit deletion has a 30-day recovery period. | R13 |
| W9 | Provenance is immutable while later metadata edits are retained as auditable events. | R20 |
| W10 | Artifact, revision, and share URLs remain stable across renames and later publishes. | R2-R3, R11, and AE9 |

## Open product decisions

| ID | Decision to make | Why it matters |
|---|---|---|
| P1 | Content-comparable formats beyond structural descriptor comparison | T6 settles the first renderable formats; content-level diff coverage remains open until a format-specific adapter enters scope. |
| P2 | Limits beyond the accepted first folder transport defaults, including revision-count, bandwidth, archive-download, and operator override policy | Makes failure behavior predictable for operators and agents without treating one safe initial envelope as the complete resource policy. |
| P3 | Password-protected share behavior | Determines whether passwords supplement or replace authenticated access policies. |

## Open technical decisions

| ID | Decision to make | Constraint already known |
|---|---|---|
| T4 | CLI packaging and distribution beyond the accepted T4a profile/configuration contract | Must be easy for humans and agents to install across supported platforms. |
| T5 | Complete self-host deployment shape beyond the T5a-T5c reference, reconciliation, and host-native recovery profiles | Must still include Compose-volume and R2 recovery, online/PITR policy, upgrade, destructive cleanup policy, TLS/reverse-proxy qualification, live R2 conformance, and administrative recovery paths. |
| T7 | Bulk manifest and export formats | Must preserve per-item results, history, metadata, and relationships. |

## Deferred capabilities

- Comments and anchored annotations
- Live analytics
- Custom domains
- Public profiles
- Multi-user teams and hosted multi-tenancy
- Real-time viewer updates

When a decision is made, update the Product Contract first if behavior changes, then move or replace the corresponding register entry.
