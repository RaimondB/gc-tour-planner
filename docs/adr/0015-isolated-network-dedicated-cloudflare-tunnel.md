# ADR-0015 — gctp on an isolated network behind its own Cloudflare Tunnel

- **Status:** Accepted
- **Date:** 2026-06-02
- **Deciders:** Raimond Brookman (owner)
- **Related:** [ADR-0001](0001-stack-choices.md)

## Context

The UAT deployment runs on a host that also hosts an unrelated
other workloads stack (`another stack on the host`: other workloads,
…). Until now gctp's `api` and `web` containers joined that stack's shared
shared reverse proxy network (`the shared proxy network`) so the shared reverse proxy could terminate
TLS and route `app.example.com` (web at `/`, api at `/api/*` with a
stripprefix middleware).

Two problems with that:

1. **Blast radius.** The gctp `api` has *no real authentication yet* — it runs
   `NODE_ENV=uat` with the dev-user middleware (every request is one hardcoded
   user; real JWT auth is the unbuilt M6 module). Sitting on `shared proxy network` means
   **any** container in the other workloads stack — or a compromised one — can
   reach gctp's unauthenticated API directly over that shared bridge.
2. **Coupling.** gctp's public reachability depended on other workloads infra
   (the shared reverse proxy + its tunnel), mixing two unrelated trust domains.

We want gctp publicly reachable with authentication handled at the edge
(Cloudflare Access), without sharing any network with other workloads.

## Decision

**Isolate gctp onto its own single Docker network and put it behind its own
dedicated Cloudflare Tunnel.**

- **Drop `the shared proxy network`.** `api`/`web` no longer join the shared
  reverse-proxy network and carry no shared reverse proxy labels. gctp's only network is its
  own compose-generated `gctp_default`; no other stack is attached to it.
- **`web` (nginx) becomes the stack's single same-origin edge.** It serves the
  SPA and reverse-proxies `/api/*` → `api:3000`, stripping the `/api` prefix —
  the exact behaviour the shared reverse proxy stripprefix middleware used to provide. nginx
  `client_max_body_size` is raised to 64 MB to match the API's GPX upload cap
  (`MAX_GPX_BYTES`), which shared reverse proxy previously passed through.
- **A dedicated `cloudflared`** service runs gctp's *own* named tunnel (separate
  connector token from the other workloads tunnel) and joins **only**
  `gctp_default`. Its public hostname route `app.example.com → http://web:80`
  and the **Cloudflare Access** policy live in the Cloudflare Zero Trust
  dashboard. A separate tunnel (not a second hostname on the shared one) is
  required because a tunnel's origins must be reachable from every connector —
  reusing the shared connector would re-link the networks and defeat the
  isolation.
- **No host ports** are published for any gctp service. The tunnel's outbound
  connection to the Cloudflare edge is the *only* ingress; `gctp_default` keeps
  egress (NAT) so `cloudflared` can dial out.
- **TLS terminates at the Cloudflare edge.** No Let's Encrypt cert is provisioned
  on-box anymore (the shared reverse proxy's DNS-01 cert for the host is no longer in
  the path).
- **All access goes through Cloudflare**, LAN included: the internal
  split-horizon DNS override (`app.example.com → the deployment host`) is removed so
  on-LAN clients also pass Cloudflare Access. There is intentionally no
  unauthenticated LAN bypass while the API is pre-auth.

## Consequences

- **Security:** other workloads can no longer reach the gctp API; the pre-auth
  API is only reachable through Cloudflare Access. This is the interim
  authentication story until the M6 JWT module lands.
- **Auth is entirely Cloudflare's job "for now."** If the Access app is
  misconfigured or removed, the API is unauthenticated to anyone who reaches the
  hostname — so the no-host-ports + tunnel-only ingress invariant matters.
- **Ops:** two cloudflared instances run on the host (other workloads's and
  gctp's), each with its own token. gctp public config (hostname route + Access)
  is dashboard state, not in this repo; `CLOUDFLARE_TUNNEL_TOKEN` is the only
  new env knob (see `infra/.env.example`).
- **Loss of on-box TLS/LAN-direct:** LAN users no longer get a direct
  shared reverse proxy/Let's Encrypt path; everything is mediated by Cloudflare. Acceptable
  for a single-tester UAT.
- **Defence-in-depth follow-up (not done):** the data tier (postgres, valkey,
  osrm, solver) still shares `gctp_default` with the edge. A later split into an
  internal-only backend network + a frontend network for web/api/cloudflared
  would further limit a compromised-edge blast radius.
- **Reversible:** re-adding the `shared proxy network` network + shared reverse proxy labels and dropping
  the cloudflared service restores the previous shared-proxy topology.
