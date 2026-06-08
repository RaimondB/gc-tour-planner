# ADR-0023 — Staged removal of the Cloudflare Access gate (and optionally the Tunnel)

- **Status:** Proposed
- **Date:** 2026-06-08
- **Deciders:** Raimond Brookman (owner)
- **Related:** [ADR-0015](0015-isolated-network-dedicated-cloudflare-tunnel.md) (amends its auth premise), [ADR-0021](0021-auth-and-session-strategy.md), [ADR-0022](0022-tour-sharing-link-security.md)

## Context

[ADR-0015](0015-isolated-network-dedicated-cloudflare-tunnel.md) put gctp behind
a dedicated Cloudflare Tunnel **and** a Cloudflare Access identity gate, because
at the time *"the gctp `api` has no real authentication yet"* — Access **was** the
authentication. That premise no longer holds: **M6 shipped real auth** (Valkey
sessions, password + Google OAuth, CSRF, a global guard, per-user `owner_id`
isolation — [ADR-0021](0021-auth-and-session-strategy.md)). The owner now wants to
**remove the Access gate** (so the app authenticates its own users without a second
Cloudflare login in front), and wants the **option to later remove the Tunnel** too
(direct origin exposure).

This cannot be a flip of a dashboard switch, because Cloudflare silently provides
more than identity. Removing each layer shifts work onto the app and host:

- **Access** is today the *only* thing stopping an unauthenticated internet client
  from reaching the public surface (and, after self-service registration, the whole
  authenticated surface). It also means real client IPs arrive as `CF-Connecting-IP`.
- **The Tunnel + CF edge** additionally provide **TLS termination, DDoS/WAF, bot
  mitigation, IP reputation, and origin-IP hiding**. The stack has **no on-box TLS**
  (nginx listens on `:80` only) and no WAF.

A pre-removal security review (see
[docs/sdlc/security-testing.md](../sdlc/security-testing.md)) found several controls
that currently **fail open** without Cloudflare in front:

1. The per-IP login/register throttle keys on `req.ip` with no `trust proxy`, so
   behind nginx it collapses to a single global bucket; only the per-email limiter
   survives.
2. The bull-board queue dashboard is mounted as raw Express middleware
   (`apps/api/src/main.ts`), **outside** the Nest guard — unauthenticated.
3. `/admin/*` routes and the destructive `POST /tours/walking-graph/purge-bogus`
   have **no role check** (`users.is_admin` is unused) — any authenticated user.
4. `POST /auth/register` is fully open (no email verification / CAPTCHA / invite).

## Decision

**Remove Cloudflare in two ordered gates, each blocked on its mitigations, with a
penetration test against an origin-exposed clone as the evidence gate.** The clone
(`infra/docker-compose.pentest.yml`, no `cloudflared`, origin published on loopback)
*is* the no-Access/no-Tunnel topology, so one test run clears both gates.

**Execute Gate 1 now; document Gate 2 as a mapped path for later.**

### Gate 1 — remove Cloudflare Access, keep the Tunnel
Must be green first:
1. **Trust-proxy + rate-limit keying.** Set Express `trust proxy` to the exact hop
   and add a throttler `keyGenerator` reading the real client IP from
   `CF-Connecting-IP` (Tunnel still present), with nginx stripping spoofable inbound
   `X-Forwarded-For`/`CF-Connecting-IP`.
2. **bull-board behind auth.** Put the dashboard behind the session guard (or remove
   it from the public path).
3. **Admin role-gating.** Enforce `users.is_admin` on `/admin/*` and the destructive
   purge.
4. **Registration abuse control.** Add email verification / CAPTCHA / invite, or
   explicitly accept open signup with hard caps.
5. **Clean pentest** on auth / session / IDOR / CSRF / injection.

### Gate 2 — also remove the Tunnel (direct origin exposure)
Everything in Gate 1, plus:
6. **On-box TLS + HSTS** (terminator + cert + renewal); throttler keyer switches from
   `CF-Connecting-IP` to a trusted `X-Forwarded-For` hop.
7. **Replace CF DDoS/WAF** — host firewall, app-layer WAF, proxy connection/rate
   limits, fail2ban/CrowdSec.
8. **Origin hardening** — expose only `80/443`; keep postgres/valkey/osrm/solver
   internal.

Deployment specifics for (6)–(8) — hostnames, certs, IPs, firewall rules — stay
**out of this public repo** (per CLAUDE.md); they live in the deployment's untracked
env/override and operator notes. This ADR records the *requirements*, not the values.

## Consequences

- **Reversible at Gate 1.** Re-enabling the Access policy is a dashboard change; the
  Tunnel and isolated-network invariants of ADR-0015 are untouched. The four app
  fixes are improvements regardless of whether Access is ever removed.
- **ADR-0015 amended, not superseded.** Its network-isolation and no-host-ports
  invariants still stand; only its "Access **is** the authentication" premise is
  retired here. The `no-host-ports` invariant in particular protects Gate 2: it
  forces a deliberate `:443` publish rather than an accidental exposure.
- **Gate 2 is a larger commitment** (TLS/WAF/host hardening) and harder to reverse;
  it is deferred until there is a concrete reason to drop the (free) Tunnel, since
  doing so trades away meaningful defence-in-depth for a single-operator origin.
- **The pentest harness is reusable** as the regression gate for the M6-δ
  `GET /shared/:slug` surface and any future public-surface change.
