# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue or PR for a
suspected vulnerability.

- Use GitHub's **[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)**:
  on the repository, go to **Security → Report a vulnerability**. This opens a private
  advisory visible only to the maintainers and you.

When reporting, please include:

- the affected component (e.g. auth/session, GPX upload, tour sharing, an admin
  endpoint) and version/commit,
- reproduction steps or a proof of concept,
- the impact you observed (data exposure, privilege escalation, etc.).

We aim to acknowledge a report within a few days. As a small open-source project
there is no formal SLA, but credible reports are taken seriously and fixed as a
priority. We're happy to credit reporters in the advisory unless you prefer to remain
anonymous.

## Supported versions

This project is pre-1.0 and under active development. Only the **latest `main`** is
supported; fixes land there and are not back-ported. There is no released-version
support matrix yet.

## Scope

In scope: the application code in this repository (`apps/`, `packages/`, `infra/`) —
authentication and session handling, per-user data isolation, CSRF, input parsing
(GPX/XML), the REST API surface, and tour-sharing links.

Out of scope: third-party infrastructure (Cloudflare, the hosting provider), and any
deployment-specific configuration, which is intentionally kept out of this public
repository.

## For maintainers / authorized testers

The repository ships a self-service penetration-testing harness and a staged plan for
hardening the app to run with less third-party edge protection. See
[docs/sdlc/security-testing.md](docs/sdlc/security-testing.md) and
[ADR-0023](docs/adr/0023-staged-cloudflare-access-tunnel-removal.md). Run security
tests only against an isolated throwaway stack, never against a live deployment you do
not own.
