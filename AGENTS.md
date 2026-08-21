# Working with the Shelf CLI

Shelf is a self-hostable service for publishing versioned artifacts. You publish a file or a complete folder, Shelf stores it as an immutable revision, and Shelf gives you a link you can share, pin to one revision, or revoke.

This document is the operating contract for the `shelf` CLI. It is written for agents. Read it instead of the source.

## Machine contract

- Success writes exactly one JSON document to stdout and exits `0`.
- Failure writes exactly one redacted JSON error envelope to stderr and exits non-zero.
- Both are one line, newline-terminated. Parse stdout only on exit `0`.
- There are never interactive prompts. Nothing blocks waiting on a human.
- Error output redacts the token in `SHELF_TOKEN` and the profile token, replacing each occurrence with `[REDACTED]` in the message and in every `details[].reason`.

Error envelope shape:

```json
{
  "error": {
    "code": "SERVICE_UNAVAILABLE",
    "message": "Another Shelf publish is updating this operation.",
    "retryable": true,
    "requestId": "cli",
    "details": [{ "field": "title", "reason": "must not be empty" }]
  }
}
```

`code`, `message`, `retryable`, and `requestId` are always present. `details` is optional and holds at most 32 entries; `field` inside a detail is optional. `requestId` is the literal string `cli` for failures the CLI raises locally, and the server request ID for failures that came from the API.

## Exit codes

| Code | Name | Meaning | Retry |
| --- | --- | --- | --- |
| 0 | success | One JSON document on stdout. | n/a |
| 1 | unexpected | `INTERNAL_ERROR`. An unhandled fault. | No. Report it. |
| 2 | usage | Bad flags, missing context, unconfigured profile, unreadable path. | No. Fix the command. |
| 3 | authentication | `AUTHENTICATION_REQUIRED`. Token missing, expired, or rejected. | No. Fix the credential. |
| 4 | authorization | `AUTHORIZATION_DENIED`. Token is valid but lacks authority here. | No. |
| 5 | validation | `INVALID_REQUEST`, `IDEMPOTENCY_CONFLICT`, `ARTIFACT_NOT_FOUND`, `ARTIFACT_RECOVERY_EXPIRED`, `REVISION_NOT_FOUND`, `SHARE_NOT_FOUND`, `ACCESS_CREDENTIAL_NOT_FOUND`, `WORKSPACE_ALREADY_EXISTS`, `WORKSPACE_NOT_EMPTY`, `RANGE_NOT_SATISFIABLE`, `MULTI_RANGE_UNSUPPORTED`. | No. Change the request. |
| 6 | transient | `REQUEST_CANCELLED`, `CONTENT_UNAVAILABLE`, `SERVICE_UNAVAILABLE`. | Yes. Retry is safe. |

Branch on the exit code first. Exit `6` means the same command can be re-run as-is. For every other non-zero code, read `error.code` and decide.

Do not infer retry safety from the code alone. Every envelope carries `retryable` as a boolean; trust it. A `5` is never retryable, a `6` always is, and `retryable` tells you which envelopes in between are worth another attempt.

## Setup

A profile stores the installation URL, the workspace ID, and a credential *reference*. It never stores a plaintext token.

```sh
export SHELF_TOKEN='shf_v1...'
shelf profiles set default --url https://shelf.example \
  --workspace workspace-main --credential-env SHELF_TOKEN
```

`shelf profiles set <name>` requires `--url` and `--workspace`, plus exactly one of `--credential-env` or `--store-token-from-env`. Supplying both, or neither, is a usage error (exit `2`).

| Flag | Behavior |
| --- | --- |
| `--credential-env VAR` | Stores a reference to the environment variable `VAR`. Nothing is written to a secret store. Every later command must have `VAR` exported. |
| `--store-token-from-env VAR` | Reads the token out of `VAR` **now** and writes it into the native OS keyring. Later commands do not need `VAR` exported. If the keyring is unavailable or the write fails, the command fails with exit `2` and tells you to use `--credential-env`. There is no plaintext fallback. |

Prefer `--credential-env` in CI and containers. Prefer `--store-token-from-env` on a developer workstation.

`VAR` must be a valid environment variable name (`^[A-Za-z_][A-Za-z0-9_]*$`). Profile names must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. The URL must be an `https:` origin with no path, query, fragment, or userinfo; only `--allow-insecure-loopback` permits `http://localhost`, `http://127.0.0.1`, or `http://[::1]`.

### Context resolution

Every remote command accepts `--profile <name>`. Resolution order:

1. `--profile <name>` given: use that profile.
2. No `--profile`, no `--url`, no `--workspace`, no `--allow-insecure-loopback`, and a profile named `default` exists: use `default` automatically. Bare commands just work.
3. Otherwise: `--url` is required, `--workspace` too where the command is workspace-scoped, and `SHELF_TOKEN` must be exported.

Mixing `--profile` with `--url`, `--workspace`, or `--allow-insecure-loopback` is a usage error. Because of rule 2, once `default` is configured you can drop `--profile default` from every example below.

### Config file locations

| Platform | Profile config | Publish journal |
| --- | --- | --- |
| macOS | `~/Library/Preferences/Shelf/profiles.json` | `~/Library/Application Support/Shelf/operations/` |
| Linux | `$XDG_CONFIG_HOME/shelf/profiles.json`, default `~/.config/shelf/profiles.json` | `$XDG_DATA_HOME/shelf/operations/`, default `~/.local/share/shelf/operations/` |
| Windows | `%APPDATA%\Shelf\Config\profiles.json` | `%LOCALAPPDATA%\Shelf\Data\operations\` |

`SHELF_CONFIG_DIR` overrides the config directory. `SHELF_DATA_DIR` overrides the journal directory. Both are useful for isolating a test run.

### Inspect and remove profiles

```sh
shelf profiles list
shelf profiles show default
shelf profiles remove staging --yes
```

`shelf profiles show` never reveals the credential, only the reference. `shelf profiles remove` requires `--yes` and also deletes the keyring entry when the profile used one.

## When to run what

| Intent | Command |
| --- | --- |
| Publish a new file | `shelf publish ./report.md --title "..." --description "..."` |
| Publish a new folder snapshot | `shelf publish ./site --title "..." --description "..."` |
| Publish a new revision of an existing artifact | `shelf publish ./report.md --artifact art_... --title "..." --description "..."` |
| Publish and share in one run | `shelf publish ./report.md --title "..." --description "..." --share` |
| Share protected, expiring | `shelf shares create --artifact art_... --access protected --expires-in 7d --idempotency-key k` |
| Share public, short URL | `shelf shares create --artifact art_... --access public --expires-in 24hr --idempotency-key k` |
| Get the two prepared Latest links | `shelf shares defaults --artifact art_...` |
| Find something I published earlier | `shelf artifacts list --search "notes" --sort updated` |
| Inspect one artifact | `shelf artifacts show --artifact art_...` |
| See the revision history | `shelf artifacts history --artifact art_...` |
| Poll which artifacts have new discussion | `shelf comments summaries --artifact art_... --artifact art_...` |
| Read review feedback | `shelf comments list --artifact art_...` |
| Reply to feedback | `shelf comments reply --artifact art_... --thread <thread-id> --body "..."` |
| Close out a thread | `shelf comments resolve --artifact art_... --thread <thread-id>` |
| Roll back to an old revision | `shelf artifacts restore --artifact art_... --revision rev_... --idempotency-key k` |
| Stop sharing | `shelf shares revoke --share shr_...` |
| Clean up | `shelf artifacts delete --artifact art_... --confirm art_...` |
| Undo a delete | `shelf artifacts recover --artifact art_...` |

### Publish something new

Positional `shelf publish <path>` is the profile-backed path and the one agents should use. The path may be a file or a directory; Shelf decides which from the filesystem.

```sh
shelf publish ./report.md \
  --title "Q3 report" \
  --description "Rendered summary of the Q3 data pull"
```

Add repeatable string metadata with `--metadata key=value`. Keys `title` and `description` are set by the dedicated flags, and provenance keys such as `actorId`, `classification`, and `contentHash` are reserved and rejected.

```sh
shelf publish ./site \
  --title "Design preview" \
  --description "Static preview of the new marketing site" \
  --metadata run=ci-4821 --metadata branch=feat/new-hero
```

The output JSON has `operation: "publish"`, `status: "complete"`, `publish` (artifact and revision IDs), `share`, and a `urls` object with `artifact`, `revision`, and `share`.

`shelf folders publish` is the explicit folder command. It requires `--directory` and `--idempotency-key`. Positional `shelf publish ./dir` covers the same ground with less ceremony, so use it unless you specifically need to supply your own key with `--url`/`--workspace` context.

Folder publishing includes regular files and empty directories, rejects symlinks and special files, and never uploads an absolute host path.

### Publish a new revision

Pass `--artifact` with the existing artifact ID. Revisions are immutable and append-only.

```sh
shelf publish ./report.md --artifact art_9fK2xQ1bTn7Lp0RcZsVe4W \
  --title "Q3 report" --description "Corrected the revenue table"
```

### Share protected vs public

Both link types can follow Latest or pin one exact revision with `--revision`. Both are excluded from search-engine indexing.

- **Protected**: a capability URL. The secret lives in the URL fragment. It can be permanent, expiring, session-limited, or all three. Use for anything not meant to be world-readable.
- **Public**: a short unlisted URL with no secret. A finite public link lasts at most 30 days.

```sh
# Prepared permanent Protected default, returned not created
shelf publish ./draft.md --title "Draft" --description "First pass" --share

# Custom finite Public link created at publish time
shelf publish ./draft.md --title "Draft" --description "First pass" \
  --share --access public --expires-in 24hr

# Standalone share on an existing artifact, pinned to one revision
shelf shares create --artifact art_... --revision rev_... \
  --access protected --expires-in 7d --max-sessions 5 \
  --idempotency-key share-report-v3
```

With `--share` and no finite or session policy, Shelf returns the prepared permanent default for `--access` (protected when omitted) rather than creating a new link. Adding `--expires-in`, `--expires-at`, or `--max-sessions` creates a custom link instead. `--expires-in` and `--expires-at` conflict; use one.

`--expires-in` presets: `never`, `5m`, `30m`, `2hr`, `6hr`, `24hr`, `3d`, `7d`, `15d`, `30d`. `--max-sessions` is 1 to 1000000 and applies to protected links only.

Share policy flags without `--share` are a usage error on `shelf publish`.

Comment policy is `off` (default on new links), `private` (a visitor sees only their own threads), or `shared` (everyone on the link sees shared threads). Omitting `--comments` leaves a prepared link's existing policy alone; explicit `--comments off` disables it.

```sh
shelf shares comments --share shr_... --comments shared
```

### Find an artifact you published earlier

```sh
shelf artifacts list --search "Q3 report" --sort updated --order desc --limit 20
```

`--search` matches title, description, filename, or artifact name. `--sort` is `created` or `updated` (default `updated`), `--order` is `asc` or `desc` (default `desc`). Page with `--cursor` using the `nextCursor` from the previous response.

```sh
shelf artifacts show --artifact art_...
shelf artifacts history --artifact art_... --order newest --limit 50
shelf revisions compare --base rev_... --target rev_...
```

`shelf revisions compare` diffs two revisions without reading content bytes.

### Read content back

```sh
shelf revisions download --revision rev_... --output ./artifact.bin
shelf folders tree --revision rev_...
shelf folders download --revision rev_... --path docs/spec.md --output ./spec.md
```

Both download commands stream to a temp file and rename atomically into `--output`. They refuse to replace an existing file unless you pass `--overwrite`.

### Read and answer review feedback

Poll cheaply first. `summaries` accepts 1 to 100 repeated `--artifact` flags and reports open thread counts, reply counts, participants, and the latest activity instant without paging every thread.

```sh
shelf comments summaries --artifact art_one --artifact art_two --artifact art_three
```

Then page the threads that actually moved:

```sh
shelf comments list --artifact art_... --limit 25
shelf comments list --artifact art_... --cursor <nextCursor>
shelf comments list --artifact art_... --revision rev_...
```

Without `--revision`, line anchors are evaluated against the latest revision. Responses carry `items` and `nextCursor`.

Act as moderator:

```sh
shelf comments reply --artifact art_... --thread <thread-id> \
  --body "Fixed in the next revision." --display-name "Release bot"
shelf comments resolve --artifact art_... --thread <thread-id>
shelf comments reopen  --artifact art_... --thread <thread-id>
shelf comments hide    --artifact art_... --post <post-id>
shelf comments unhide  --artifact art_... --post <post-id>
```

Reply bodies cap at 20000 characters. `--display-name` is 1 to 128 characters. Hiding changes visibility without rewriting the visitor's post.

### Clean up

```sh
shelf shares revoke --share shr_...
shelf artifacts delete --artifact art_... --confirm art_...
shelf artifacts recover --artifact art_...
```

Deletion is soft. It revokes the artifact's active shares and leaves the artifact recoverable for 30 days. After that window, `recover` fails with `ARTIFACT_RECOVERY_EXPIRED` at exit `5`.

### Rename and restore

```sh
shelf artifacts rename --artifact art_... --name "Project notes"
shelf artifacts restore --artifact art_... --revision rev_... --idempotency-key restore-report-1
```

`rename` changes the label only; it creates no revision. `restore` creates a *new* revision whose content matches the earlier one. History stays intact.

## Idempotency

These commands require `--idempotency-key`:

| Command | Required |
| --- | --- |
| `shelf folders publish` | Yes |
| `shelf artifacts restore` | Yes |
| `shelf shares create` | Yes |
| `shelf publish <path>` (profile mode) | No. Optional override. |
| `shelf artifacts recover` | No. Optional. |
| `shelf publish --url ... --file ...` (legacy mode) | Yes |

Rules:

1. **The key must be stable across retries of the same logical operation.** Retrying after an exit `6` must reuse the exact same key. A fresh random key on retry produces a duplicate.
2. **A new logical operation needs a new key.** Publishing a new revision of an existing artifact is a new operation. Reusing the previous key returns the previous result instead of publishing.
3. **Reusing a key with different parameters fails** with `IDEMPOTENCY_CONFLICT` at exit `5`. Do not retry; it will keep failing.

Derive keys from something stable and meaningful, such as `publish-<artifact>-<content-hash>` or `share-<artifact>-<purpose>`. Never use a timestamp or a fresh UUID inside a retry loop.

### The publish journal

Profile-backed `shelf publish <path>` keeps a crash-safe local journal, so you usually do not need to manage a key yourself.

Before uploading, the CLI computes a fingerprint over the profile, installation URL, workspace, resolved absolute path, file-or-folder kind, target artifact ID, sorted metadata, share policy, any explicit `--idempotency-key`, and a SHA-256 of the content. It then opens a journal record at that fingerprint and mints stable publish and share idempotency keys inside it. The record is deleted when the run completes.

Consequences to rely on:

- If a run is interrupted mid-upload, running the **identical command again** resumes it. It does not publish twice.
- Changing the file content changes the fingerprint, so an edited file is a genuinely new operation with a new key. That is the behavior you want.
- Two concurrent identical publishes serialize on a lock file. If the lock cannot be acquired, you get `SERVICE_UNAVAILABLE` with `retryable: true` at exit `6`. Back off and retry.
- If the publish succeeds but the share step fails, the CLI emits a **partial** payload on stderr with `status: "partial"`, the completed `publish`, `share: null`, and the `error` object. The artifact exists. Do not re-publish. Create the share separately with `shelf shares create`.

## Safety rails

- **`--title` and `--description` are required for agent publishes.** Missing either is a usage error at exit `2`. Neither may be blank or whitespace-only.
- **`--user-bypass` is for humans only.** It exists so a person can intentionally publish an untitled scratch file. An agent must never pass it. If you find yourself reaching for it, supply real metadata instead.
- **Destructive actions need explicit flags.** `shelf artifacts delete` requires `--confirm <artifact-id>` matching `--artifact` exactly. `shelf profiles remove` requires `--yes`. Both download commands require `--overwrite` to replace an existing local file. There is no prompt fallback; omitting the flag fails.
- **Tokens are never command-line arguments.** There is no `--token` flag. Credentials come from an environment variable or the OS keyring, by way of a profile. Never put a token in a command line, where it lands in process listings and shell history.
- **The CLI never accepts visitor capability secrets.** There is no flag for the fragment of a protected share URL, and no visitor identity flag. Visitor-side access is a browser concern. Protected share URLs are confidential; do not log them.
- **Artifact IDs are validated locally** against `^art_[A-Za-z0-9_-]{22}$` before any request, so a malformed ID fails fast at exit `2`. Revision IDs use `rev_` and share IDs use `shr_` with the same 22-character shape. Thread and post IDs are opaque strings; pass back exactly what the API returned.

## Deliberate limits

The following are **not** in this CLI, on purpose:

- Credential issuance, rotation, and revocation. Use the dashboard or the separate host-local `shelf-admin` tool.
- Workspace creation. It needs a human session.
- Anything requiring a visitor capability secret.

If a task needs one of these, stop and report that it requires the dashboard or `shelf-admin`. Do not try to work around it.

## Discovery

Enumerate the command surface programmatically:

```sh
shelf schema
```

This prints the full command tree as one JSON document to stdout, following the same one-document contract as every other command. Use it to discover commands and flags without parsing help text.

Human-readable help is still available and includes per-command examples:

```sh
shelf --help
shelf publish --help
shelf shares create --help
shelf --version
```

`--help` and `--version` write to stdout and exit `0`, but they are **not** JSON. Do not feed them to a JSON parser.

## Running from this repository

The published binary is `shelf`, installed with `brew install amitray007/tap/shelf`. Inside this repo, run the built CLI through the workspace script:

```sh
pnpm shelf artifacts list --profile default
```

Build it first with `pnpm build`. The CLI talks only to the public `/api/v1` contract.
