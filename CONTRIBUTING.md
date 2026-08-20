# Contributing to Shelf

Thank you for your interest in Shelf. This guide explains how to set up the project, make a change, and send it for review.

## Before you start

- Read the [README](README.md) for the product shape and the development commands.
- Read the [product contract](docs/plans/2026-08-17-0030-feat-shelf-product-plan.md) before you propose a feature. Shelf has deliberate boundaries. For example, there is no dashboard publishing route and no collections abstraction.
- For questions and ideas, open an issue first. For small fixes, a pull request is enough.

## Set up

You need Node.js 24 and pnpm 10.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

For a full local stack, install PostgreSQL and follow the [host-local development guide](docs/operations/development.md):

```sh
pnpm dev:setup
pnpm dev
```

## Make a change

1. Create a branch from `main`.
2. Make the smallest complete change.
3. Add or update tests next to the code you changed. Every package has a `test/` directory with examples.
4. Run the checks before you push:

```sh
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
```

If you change an API route or schema, regenerate the OpenAPI contract:

```sh
pnpm --filter @shelf/api openapi:generate
```

If you change the database schema, add a new migration file in `packages/postgres/src/migrations/`. Do not edit an existing migration.

## Commit and pull-request style

- Use conventional commit messages: `feat(scope): summary`, `fix(scope): summary`, `docs: summary`.
- Keep one logical change per commit.
- In the pull request, explain what changed and why. Include the verification you ran.

## Code style

- Biome enforces formatting and lint rules. Run `pnpm format` to fix formatting.
- Match the style of the surrounding code.
- Do not add code comments that restate the code. Comment only what the code cannot show.

## Reporting security issues

Do not open a public issue for a security problem. Follow [SECURITY.md](SECURITY.md).
