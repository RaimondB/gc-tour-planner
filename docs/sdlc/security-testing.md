# Security testing

How we penetration-test gc-tour-planner, and the **go/no-go gates** that must be
green before we remove a Cloudflare protection layer. Read alongside
[ADR-0023](../adr/0023-staged-cloudflare-access-tunnel-removal.md) (why), [ADR-0021](../adr/0021-auth-and-session-strategy.md)
(auth contract), and [auth-and-sharing.md](../design/auth-and-sharing.md) (the
normative public-endpoint inventory).

## Why this exists

Today [Cloudflare Access](../adr/0015-isolated-network-dedicated-cloudflare-tunnel.md)
sits in front of the app and is doing real security work — an unauthenticated
internet client never reaches the API at all. We want to **remove the Access gate**
(M6 auth now handles users) and keep the **option** to later remove the **Tunnel**
too. Each removal shifts defensive work onto the app/host, so each is gated on
evidence: a penetration test plus a fixed checklist.

The test runs against an **isolated, origin-exposed clone** of the prod stack — which
*is* the no-Access/no-Tunnel topology — so one run informs **both** gates with zero
risk to real data.

## The two gates

### Gate 1 — remove Cloudflare Access (keep the Tunnel)
You lose only the identity gate; you keep edge TLS, DDoS/WAF, bot mitigation, and
`CF-Connecting-IP`. **All five must be green:**

1. **Trust-proxy + rate-limit keying.** `trust proxy` set and the throttler keys on
   `CF-Connecting-IP` (not nginx's socket IP); nginx strips spoofable inbound
   `X-Forwarded-For`/`CF-Connecting-IP`. *(check-rate-limit.sh)*
2. **bull-board behind auth** — not reachable unauthenticated. *(check-bull-board.sh)*
3. **Admin role-gating** on `/admin/*` + `POST /tours/walking-graph/purge-bogus`
   (add the `users.is_admin` column from FR-P12 + an admin guard). *(check-admin-authz.sh)*
4. **Registration abuse control** — email verification / CAPTCHA / invite, or an
   explicit accept-with-hard-caps decision. *(manual + check-rate-limit.sh)*
5. **No exploitable findings** on auth, session, IDOR, CSRF, injection. *(check-idor /
   check-csrf / check-session + ZAP/sqlmap)*

### Gate 2 — also remove the Tunnel (direct origin exposure)
Everything in Gate 1, plus:

6. **On-box TLS + HSTS** (terminator + cert + renewal); throttler keyer switches to a
   trusted `X-Forwarded-For` hop. *(check-headers.sh, + the production-config pass)*
7. **Replace CF DDoS/WAF** — host firewall, app-layer WAF, proxy connection/rate
   limits, fail2ban/CrowdSec.
8. **Origin hardening** — only `80/443` exposed; data tier stays internal.

> Gate 2's host/TLS/WAF specifics (hostnames, certs, firewall rules) stay **out of
> this public repo** ([CLAUDE.md](../../CLAUDE.md)); document them generically here and
> keep real values in the deployment's untracked env/override.

## Stand up the target

An isolated compose project on fresh volumes — never shares with dev/UAT:

```bash
cd infra
cp pentest.env.example pentest.env     # edit the throwaway AUTH_SESSION_SECRET
docker compose -p gctp-pentest \
  -f docker-compose.yml -f docker-compose.pentest.yml --env-file pentest.env \
  up --build -d
```

The override ([`infra/docker-compose.pentest.yml`](../../infra/docker-compose.pentest.yml)):

- **drops `cloudflared`** (disabled via an unselected profile),
- **publishes `web` → `127.0.0.1:18080`** so a scanner hits the real same-origin
  `nginx → api` path directly (the no-CF shape),
- shifts postgres/valkey/osrm host ports so it can run beside a dev/UAT stack.

First boot preprocesses an OSRM extract; pick the **smallest** `OSRM_REGION` in
`pentest.env` (the security surface barely uses routing). The api depends on
osrm being healthy, so it boots once OSRM finishes (~minutes for a small region).
Landuse import runs in parallel and is not needed for the test.

Target origin: **`http://127.0.0.1:18080`**. Two first-boot gotchas:

- **`migrate` can lose a race on a cold volume.** On the very first boot Postgres
  briefly accepts then restarts during cluster init; the one-shot `migrate`
  (`restart: "no"`) may hit `ECONNREFUSED` and exit 1, which leaves `api`/`web`/`jobs`
  in `Created`. Just re-run `up -d` — Postgres is healthy by then and migrate succeeds.
- **The published port must be free on the host.** `web` binds `127.0.0.1:18080`; if a
  host service already holds it, `web` fails to bind. Change the port in the override if
  needed.

Teardown wipes everything:

```bash
docker compose -p gctp-pentest -f docker-compose.yml -f docker-compose.pentest.yml down -v
```

### Two config passes

- **(i) Active-scan pass — `NODE_ENV=uat` over HTTP (default).** Cookies aren't
  `Secure`, so a scanner can drive an authenticated session over plain-HTTP loopback.
  This is the bulk of the work. `AUTH_DEV_BYPASS` stays unset so the real guard runs.
- **(ii) Production-config pass — `NODE_ENV=production` behind a local TLS terminator.**
  A short pass to confirm `Secure` cookies, HSTS, and the "won't boot without
  `AUTH_SESSION_SECRET`" guard. Front the `web` service with a throwaway
  Caddy/nginx self-signed terminator, or just inspect the raw `Set-Cookie` headers.

## Toolkit

Free/OSS, run-not-bundled (so no GPL dependency-licensing concern):

- **OWASP ZAP** — authenticated active scan + spider. Primary DAST.
- **Burp Suite Community** — manual request tampering (auth, IDOR).
- **nuclei** — security-header/exposure/CVE templates; probe the bull-board path.
- **sqlmap** — confirm the parameterised-Kysely claim on the filter surfaces.
- **`scripts/pentest/`** — the repo's black-box checks for business-logic bugs the
  scanners can't express. See [scripts/pentest/README.md](../../scripts/pentest/README.md).

## Run the scripted checks

```bash
cd scripts/pentest
BASE_URL=http://127.0.0.1:18080 ./run-all.sh
```

Seeds two tenants (A, B) with cross-tenant cache data, then runs every check.
`PASS` = the app behaved securely; `FAIL (finding)` = a defence failed open. The
runner exits non-zero if any finding fired. Map each finding to its Gate item.

## Test matrix

| Area | How | Where |
| --- | --- | --- |
| Rate-limit keying / XFF spoof (Gate 1.1) | scripted + manual | `check-rate-limit.sh` |
| bull-board exposure (Gate 1.2) | scripted | `check-bull-board.sh` |
| Admin authz (Gate 1.3) | scripted | `check-admin-authz.sh` |
| Registration abuse (Gate 1.4) | manual decision + rate probe | runbook + `check-rate-limit.sh` |
| IDOR / owner isolation | scripted | `check-idor.sh` |
| CSRF double-submit | scripted | `check-csrf.sh` |
| Session fixation / replay | scripted | `check-session.sh` |
| Headers / cookies / CORS | scripted | `check-headers.sh` + production-config pass |
| GPX XXE / XML-bomb | manual payloads vs `scripts/pentest/fixtures/*.gpx` | ZAP / curl |
| SQL/SSRF injection | `sqlmap` on `/api/caches` filters + planner bodies | sqlmap |
| Broad active scan | authenticated ZAP context + nuclei | ZAP / nuclei |
| Tour sharing (ADR-0022) | design review now; retest `GET /shared/:slug` at M6-δ | manual |

### Notes per area

- **XXE:** the parser uses `fast-xml-parser` (`packages/shared/src/gpx/parse.ts`),
  which does not resolve external entities by default — verify with a `SYSTEM`
  entity + a billion-laughs payload uploaded via `POST /api/gpx/upload`.
- **IDOR:** cache ids are sequential integers shared across owners; the guarantee is
  a per-`owner_id` `WHERE` + 404 on cross-tenant access. `check-idor.sh` walks A's
  ids as B.
- **Injection:** filters reach the DB via parameterised Kysely; prove it rather than
  assume it.

## Read-only production-config pass (while Access is still up)

Before flipping Gate 1, validate the *real* deployment through a Cloudflare Access
**service token** — **read-only, no active scanning** (avoid polluting prod data and
tripping CF abuse protection):

- TLS/HSTS and cert at the edge;
- `Secure` cookie flag actually set in the production-config response;
- Access actually gates the app (an unauthenticated request gets a CF challenge, not
  the app);
- security headers as served end-to-end.

## Findings handling

- Keep the findings report **out of the repo** if it contains live-prod specifics.
- Each finding → a follow-up fix PR (one per Gate item; don't fold fixes into the
  harness PR) or a written accepted-risk note.
- Re-run `scripts/pentest/run-all.sh` after each fix; a Gate flips only when its items
  are green **and** the ZAP/sqlmap passes are clean.
