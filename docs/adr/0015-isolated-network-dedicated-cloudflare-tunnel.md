# ADR-0015 — gctp on an isolated network behind its own Cloudflare Tunnel

- **Status:** Accepted
- **Date:** 2026-06-02
- **Deciders:** Raimond Brookman (owner)
- **Related:** [ADR-0001](0001-stack-choices.md)

## Context

The UAT instance runs on a shared host that also runs other, unrelated
workloads. Originally gctp's `api` and `web` containers joined a shared
reverse-proxy network on that host so a shared proxy could terminate TLS and
route the app's hostname (web at `/`, api at `/api/*` with a stripprefix
middleware).

Two problems with that:

1. **Blast radius.** The gctp `api` has *no real authentication yet* — it runs
   `NODE_ENV=uat` with the dev-user middleware (every request is one hardcoded
   user; real JWT auth is the unbuilt M6 module). Sharing a network with other
   workloads means any container on that shared network — or a compromised one —
   could reach gctp's unauthenticated API directly.
2. **Coupling.** gctp's public reachability depended on shared infrastructure it
   doesn't own, mixing two unrelated trust domains.

We want gctp publicly reachable with authentication handled at the edge
(Cloudflare Access), without sharing any network with other workloads.

## Decision

**Isolate gctp onto its own single Docker network and put it behind its own
dedicated Cloudflare Tunnel.**

- **No shared proxy network.** `api`/`web` join only gctp's own
  compose-generated `gctp_default` network and carry no reverse-proxy labels.
  No other workload is attached to that network.
- **`web` (nginx) becomes the stack's single same-origin edge.** It serves the
  SPA and reverse-proxies `/api/*` → `api:3000`, stripping the `/api` prefix.
  nginx `client_max_body_size` is raised to 64 MB to match the API's GPX upload
  cap (`MAX_GPX_BYTES`).
- **A dedicated `cloudflared`** service runs gctp's *own* named tunnel (its own
  connector token) and joins **only** `gctp_default`. Its public hostname route
  (`<app-host> → http://web:80`) and the **Cloudflare Access** policy live in
  the Cloudflare Zero Trust dashboard. A dedicated tunnel (not a second hostname
  on a shared one) is required because a tunnel's origins must be reachable from
  every connector — reusing a shared connector would re-link networks and defeat
  the isolation.
- **No host ports** are published for any gctp service. The tunnel's outbound
  connection to the Cloudflare edge is the *only* ingress; `gctp_default` keeps
  egress (NAT) so `cloudflared` can dial out.
- **TLS terminates at the Cloudflare edge.** No on-box certificate is needed.
- **All access goes through Cloudflare**, including from the local network, so
  every client passes Cloudflare Access. There is intentionally no
  unauthenticated bypass while the API is pre-auth.

## Consequences

- **Security:** other workloads on the host can no longer reach the gctp API;
  the pre-auth API is only reachable through Cloudflare Access. This is the
  interim authentication story until the M6 JWT module lands.
- **Auth is entirely Cloudflare's job "for now."** If the Access app is
  misconfigured or removed, the API is unauthenticated to anyone who reaches the
  hostname — so the no-host-ports + tunnel-only ingress invariant matters.
- **Ops:** gctp's public config (hostname route + Access policy) is Cloudflare
  dashboard state, not in this repo; `CLOUDFLARE_TUNNEL_TOKEN` is the only new
  env knob (see `infra/.env.example`).
- **Defence-in-depth follow-up (not done):** the data tier (postgres, valkey,
  osrm, solver) still shares `gctp_default` with the edge. A later split into an
  internal-only backend network + a frontend network for web/api/cloudflared
  would further limit a compromised-edge blast radius.
- **Reversible:** the isolation is just compose networking + the cloudflared
  service; it can be rewired without code changes.
