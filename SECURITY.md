# Security Policy

## Supported versions

Shelf is in alpha. Only the latest state of the `main` branch receives security fixes.

## Reporting a vulnerability

Do not open a public issue for a security problem.

Report it privately through the repository's **private vulnerability reporting** (GitHub → Security → Report a vulnerability). Include:

- A description of the problem and its impact.
- Steps to reproduce it.
- The commit or version you tested.

You will get an acknowledgement within 7 days. Please give us a reasonable time to ship a fix before any public disclosure.

## Scope notes

- Protected share capabilities, viewer session tokens, and agent credentials are secret material. A path that exposes any of them is in scope.
- The renderer sandbox is a trust boundary. An escape from the isolated HTML renderer to the main origin is in scope.
- Denial-of-service reports require a realistic, unauthenticated path.
