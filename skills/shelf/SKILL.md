---
name: shelf
description: Publish a file or folder to a Shelf installation with the `shelf` CLI, get back a shareable URL, and read or answer review comments on what you published. Use when you have produced a report, document, dataset, site, or any local artifact that a human needs to open in a browser, or when you need to check feedback left on something you already published.
---

# Publishing artifacts with the `shelf` CLI

Shelf stores a file or a whole folder as an immutable revision and hands back a URL. Publishing is
append-only: every publish creates a new revision, and revisions are never edited in place.

The full command reference lives in `AGENTS.md` at the repository root. This document is the
task layer: what to run, what to decide, and what to do when it fails. Read `AGENTS.md` when you
need the complete flag surface.

## Use this when

- You produced a local file or directory and a human needs a link to it.
- You need to publish an update to something you published before.
- You need to read, answer, or resolve review comments on a published artifact.

Do not use it to store secrets, to send a file to another machine's filesystem, or as a general
key-value store. Shelf publishes content that a person is going to open.

## Contract you can rely on

- Exit `0`: exactly one JSON document on stdout. Parse it.
- Non-zero: exactly one JSON document on stderr, tokens redacted. Parse it, then branch.
- No interactive prompts, ever. Nothing blocks waiting on a human.
- `--help` and `--version` print text, not JSON. Do not parse them.

## First run: configure a profile

A profile holds the installation URL, the workspace ID, and a *reference* to a credential. It never
stores a plaintext token. Check for one before assuming you need to create one.

```sh
shelf profiles list
```

If nothing is configured, create one. `--url` and `--workspace` are required, plus **exactly one**
of the two credential flags. Passing both, or neither, is a usage error (exit `2`).

| Flag | What it does | Use when |
| --- | --- | --- |
| `--credential-env VAR` | Stores only the *name* `VAR`. The token is read from the environment on every invocation. `VAR` must be exported for every later command. | CI, containers, headless hosts, any sandbox. This is the default choice. |
| `--store-token-from-env VAR` | Reads the token out of `VAR` once, now, and writes it into the OS native keyring. Later commands do not need `VAR` exported. | A developer workstation with a working keyring. |

```sh
export SHELF_TOKEN='shf_v1...'
shelf profiles set default --url https://shelf.example \
  --workspace workspace-main --credential-env SHELF_TOKEN
```

If `--store-token-from-env` cannot reach the keyring, it fails at exit `2` and tells you to use
`--credential-env`. There is no plaintext fallback. Do not retry the same way; switch flags.

You cannot obtain a token yourself. Token issuance, rotation, and workspace creation are not in this
CLI. If no credential exists, stop and ask the human for one.

Name the profile `default`. Once `default` exists, every remote command with no context flags uses
it automatically, so `--profile default` can be dropped from all examples below. Mixing `--profile`
with `--url`, `--workspace`, or `--allow-insecure-loopback` is a usage error.

## The core loop

Publish, read the URLs out of the JSON, report the URLs.

```sh
shelf publish ./report.md \
  --title "Q3 report" \
  --description "Rendered summary of the Q3 data pull" \
  --share
```

Success returns `status: "complete"` and a `urls` object:

```json
{
  "operation": "publish",
  "status": "complete",
  "publish": { "artifactId": "art_...", "revisionId": "rev_..." },
  "urls": {
    "artifact": "https://shelf.example/artifacts/art_...",
    "revision": "https://shelf.example/artifacts/art_.../revisions/rev_...",
    "share": "https://shelf.example/s/..."
  }
}
```

**Report URLs to the human, not IDs.** `art_...` and `rev_...` are internal handles; a person cannot
open them. Give them `urls.share` when you shared, otherwise `urls.artifact`. Give `urls.revision`
when the exact version matters. Keep the IDs for your own follow-up commands.

`urls.share` is `null` unless you passed `--share`. Without `--share` the artifact still exists and
`urls.artifact` still works for anyone with dashboard access; only outside visitors need a share
link.

Publish a directory the same way. The path argument takes a file or a folder and Shelf decides which
from the filesystem:

```sh
shelf publish ./site --title "Design preview" --description "Static preview of the new site" --share
```

Add repeatable string metadata with `--metadata key=value`. Provenance keys such as `actorId`,
`classification`, and `contentHash` are reserved and rejected.

## Decisions

### New artifact or new revision

| Situation | Do this |
| --- | --- |
| First time publishing this content | `shelf publish <path> --title ... --description ...` |
| An updated version of something you already published | Add `--artifact art_...` with the existing ID |
| You lost the artifact ID | `shelf artifacts list --search "<title>" --sort updated` |

Use a new revision whenever the content is *the same thing, later*. Existing share links that follow
Latest pick it up with no further action, which is usually what the human wants. Publishing a fresh
artifact instead orphans every link you already handed out.

```sh
shelf publish ./report.md --artifact art_9fK2xQ1bTn7Lp0RcZsVe4W \
  --title "Q3 report" --description "Corrected the revenue table"
```

### Protected or public

| Access | Shape | Choose when |
| --- | --- | --- |
| `protected` (default) | Capability URL; the secret lives in the URL fragment. Can be permanent, expiring, session-limited, or all three. | Default for everything. Anything internal, unreleased, or sensitive. |
| `public` | Short unlisted URL, no secret. A finite public link lasts at most 30 days. | The human explicitly asked for a link they can paste anywhere, or the content is already public. |

Default to `protected`. Both types are excluded from search-engine indexing, but a public URL is
world-readable by anyone who receives it. Protected URLs are confidential: hand them to the human,
do not log them or write them into files that get committed.

### Prepared default or custom link

Every artifact has two permanent Latest links prepared, one of each access type. With `--share` and
no expiry or session policy, Shelf returns the prepared default instead of minting a new link. Add
`--expires-in`, `--expires-at`, or `--max-sessions` and it creates a custom link.

```sh
# Returns the prepared permanent Protected default
shelf publish ./draft.md --title "Draft" --description "First pass" --share

# Creates a custom public link that dies in a day
shelf publish ./draft.md --title "Draft" --description "First pass" \
  --share --access public --expires-in 24hr
```

`--expires-in` accepts `never`, `5m`, `30m`, `2hr`, `6hr`, `24hr`, `3d`, `7d`, `15d`, `30d`.
`--expires-in` and `--expires-at` conflict. `--max-sessions` is 1 to 1000000 and applies to
protected links only. Share policy flags without `--share` are a usage error.

### Follow Latest or pin a revision

Shares follow Latest by default. Add `--revision rev_...` to `shelf shares create` to pin one exact
revision.

- **Follow Latest** for living documents where the human should always see the current state.
- **Pin a revision** when the link is evidence: a review snapshot, a build output, an audit record,
  anything referenced from a message that must not change under the reader.

```sh
shelf shares create --artifact art_... --revision rev_... \
  --access protected --expires-in 7d --idempotency-key share-report-v3
```

`shelf shares create` always requires `--idempotency-key`. Derive it from something stable and
meaningful such as `share-<artifact>-<purpose>`. Reuse the exact same key when retrying the same
share; use a new key for a genuinely different link. A timestamp or fresh UUID inside a retry loop
creates duplicates.

## Failure handling

Branch on the exit code first.

| Exit | Meaning | Action |
| --- | --- | --- |
| 0 | Success. One JSON document on stdout. | Parse it. |
| 1 | `INTERNAL_ERROR`, unhandled fault. | Do not retry. Report it. |
| 2 | Usage: bad flags, missing context, unconfigured profile, unreadable path. | Do not retry. Fix the command. |
| 3 | `AUTHENTICATION_REQUIRED`. Token missing, expired, or rejected. | Do not retry. Fix the credential, or ask the human for one. |
| 4 | `AUTHORIZATION_DENIED`. Valid token, insufficient authority. | Do not retry. Report it. |
| 5 | Validation: `INVALID_REQUEST`, `IDEMPOTENCY_CONFLICT`, `ARTIFACT_NOT_FOUND`, `REVISION_NOT_FOUND`, `SHARE_NOT_FOUND`, and similar. | Do not retry. Change the request. |
| 6 | Transient: `REQUEST_CANCELLED`, `CONTENT_UNAVAILABLE`, `SERVICE_UNAVAILABLE`. | Retry the identical command, with backoff. |

Then read the envelope. Every error carries a `retryable` boolean; trust it over your own reading of
the code.

```json
{ "error": { "code": "SERVICE_UNAVAILABLE", "message": "...", "retryable": true, "requestId": "cli" } }
```

`requestId` is the literal string `cli` for failures raised locally and the server request ID for
failures from the API. Include it when reporting a failure to a human. Optional `details[]` entries
carry `field` and `reason` and usually say exactly which flag was wrong.

When you retry an exit `6`, re-run the **identical** command. Profile-backed `shelf publish <path>`
keeps a crash-safe local journal keyed on a fingerprint of the profile, path, metadata, share
policy, and a hash of the content, so an interrupted run resumes rather than publishing twice.
Changing the file between attempts changes the fingerprint and correctly becomes a new operation.

### The partial-failure trap

`shelf publish --share` does two things: it publishes, then it shares. The publish can succeed while
the share fails. When that happens the CLI **exits non-zero** and writes a payload to stderr with:

```json
{
  "operation": "publish",
  "status": "partial",
  "publish": { "artifactId": "art_...", "revisionId": "rev_..." },
  "share": null,
  "urls": { "artifact": "https://...", "revision": "https://...", "share": null },
  "error": { "code": "...", "message": "...", "retryable": true, "requestId": "..." }
}
```

**The revision already exists.** Re-running the publish is the wrong move; at best the journal saves
you, at worst you create a duplicate revision that a human has to clean up.

Before treating any non-zero publish exit as a failed publish, check whether stderr has
`"status": "partial"`. If it does:

1. Keep `publish.artifactId` and the `urls` from the partial payload. They are real.
2. Retry **only the share**:

```sh
shelf shares create --artifact art_... --access protected --idempotency-key share-<artifact>-retry
```

3. Report `urls.artifact` to the human either way. The content is published and reachable; only the
   share link is missing.

A plain error envelope (a top-level `error` key and no `status` field) means the publish itself
failed and nothing was created.

## Safety rails

- `--title` and `--description` are **required** for agent publishes. Missing or whitespace-only
  either one is a usage error at exit `2`.
- `--user-bypass` skips that requirement and is **for humans only**. Never pass it. If you are
  tempted, write real metadata instead: the title and description are what the human sees in a list
  of artifacts weeks later.
- Destructive commands need an explicit flag and have no prompt fallback:
  `shelf artifacts delete` requires `--confirm <artifact-id>` matching `--artifact` exactly,
  `shelf profiles remove` requires `--yes`, and both download commands require `--overwrite` to
  replace an existing local file.
- **Tokens are never command-line arguments.** There is no `--token` flag. Credentials come from an
  environment variable or the OS keyring by way of a profile. A token on a command line lands in
  process listings and shell history.
- Deletion is soft: it revokes the artifact's active shares and leaves it recoverable for 30 days
  via `shelf artifacts recover --artifact art_...`. After that window recovery fails permanently.
- `art_`, `rev_`, and `shr_` IDs are validated locally against a 22-character shape before any
  request, so a malformed ID fails fast at exit `2`. Thread and post IDs are opaque strings with no
  prefix; pass back exactly what the API returned.

## Reading and answering review feedback

Poll cheaply first. `summaries` takes 1 to 100 repeated `--artifact` flags and reports open thread
counts, reply counts, participants, and last activity without paging anything.

```sh
shelf comments summaries --artifact art_one --artifact art_two
```

Then page only the artifacts that moved, and act as moderator:

```sh
shelf comments list --artifact art_... --limit 25
shelf comments list --artifact art_... --cursor <nextCursor>

shelf comments reply --artifact art_... --thread <thread-id> \
  --body "Fixed in the next revision." --display-name "Release bot"
shelf comments resolve --artifact art_... --thread <thread-id>
shelf comments reopen  --artifact art_... --thread <thread-id>
shelf comments hide    --artifact art_... --post <post-id>
```

Bodies cap at 20000 characters, `--display-name` at 128. Without `--revision`, line anchors are
evaluated against the latest revision. Responses carry `items` and `nextCursor`.

The usual loop after feedback: read the threads, change the file locally, publish a new revision
with `--artifact`, then reply on each thread pointing at the new revision URL and resolve it.

## Reading content back

```sh
shelf artifacts show --artifact art_...
shelf artifacts history --artifact art_... --order newest --limit 50
shelf revisions compare --base rev_... --target rev_...
shelf revisions download --revision rev_... --output ./artifact.bin
shelf folders tree --revision rev_...
shelf folders download --revision rev_... --path docs/spec.md --output ./spec.md
```

Downloads stream to a temp file and rename atomically. They refuse to replace an existing file
unless you pass `--overwrite`.

## Learning a command's exact contract at runtime

Do not scrape help text and do not guess flags. Ask the CLI for its own schema as JSON.

```sh
shelf schema                       # full command tree
shelf schema artifacts list        # one command, by path
shelf artifacts list --schema      # just this command's contract
```

Each returns one JSON document on stdout at exit `0`, like every other command. `shelf schema` with
a path and `<command> --schema` return the same `kind: "Command"` document; bare `shelf schema`
returns `kind: "CommandSchema"` with every command plus the exit-code and error-code tables, so you
can build the branching above from the CLI itself rather than from this file.

A command entry carries `path`, `name`, `usage`, and, when it has any, `arguments`, `options`,
`subcommands`, and `examples`. Each option carries the canonical `flags` string, for example
`--metadata <key=value>`, from which the long flag and value placeholder are readable. The payload
omits anything false or empty rather than shipping `null`, so read presence, not value:

| Key on an option | Means |
| --- | --- |
| `required: true` | The flag must be supplied. Absent means optional. |
| `repeatable: true` | The flag may be passed more than once. |
| `choices` | The exact allowed values. |
| `default` | The value used when the flag is omitted. |

> This introspection is new. If your installed CLI does not recognize a form, fall back to bare
> `shelf schema` and select the entry whose `path` matches. Prefer reading one real response over
> trusting the field names above.

## Limits

Not in this CLI, on purpose: credential issuance, rotation, and revocation; workspace creation;
anything needing a visitor's capability secret. If a task requires one, stop and report that it
needs the dashboard or the separate host-local `shelf-admin` tool. Do not work around it.
