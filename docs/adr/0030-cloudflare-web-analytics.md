# ADR-0030 — Cloudflare Web Analytics

- **Status:** Accepted
- **Date:** 2026-06-17
- **Deciders:** Raimond Brookman (owner)
- **Related:** [ADR-0027](0027-icon-system-lucide.md) (no-CDN, self-hosted assets), [ADR-0028](0028-pwa-installability-offline-and-native-share.md) / [ADR-0029](0029-frontend-offline-resilience-caching-and-state.md) (PWA/offline), [ADR-0015](0015-isolated-network-dedicated-cloudflare-tunnel.md) (Cloudflare Tunnel ingress), [CLAUDE.md hard rules](../../CLAUDE.md)

## Context

The owner wants a basic sense of usage — page views, top routes, rough geography,
referrers — to guide where to spend effort. The app ships **no analytics or
telemetry** today, and it deliberately ships **no external CDNs** ("for
privacy/offline", [ADR-0027](0027-icon-system-lucide.md)). So adding any analytics
is a real tension with an established principle and needs a recorded decision.

Constraints that shaped the choice:

1. **No tracking cookies, no consent friction.** A self-respecting personal app
   shouldn't drop a consent banner or third-party tracking cookies on visitors.
2. **Must not regress offline / PWA behaviour.** The beacon can't sit in the
   precache, hijack navigations, or surface errors when offline.
3. **No new trust boundary.** The site's traffic already transits Cloudflare via
   the dedicated Tunnel ([ADR-0015](0015-isolated-network-dedicated-cloudflare-tunnel.md)),
   so Cloudflare is already in the request path.

## Decision

**Adopt Cloudflare Web Analytics, loaded via the standard JS beacon, gated on a
public build-time token and enabled in production only.**

- **Cookieless, no PII.** Cloudflare Web Analytics sets no cookies and does not
  fingerprint or track individuals across sites — so no consent banner is required
  in the regions we care about. This satisfies the privacy intent behind the
  no-CDN rule even though the script itself loads from a CDN.
- **The CDN exception is deliberate and narrow.** One small `defer` script from
  `https://static.cloudflareinsights.com/beacon.min.js`, reporting RUM to
  `https://cloudflareinsights.com/cdn-cgi/rum`. It is the *only* third-party CDN
  asset; everything else stays self-hosted/inline per ADR-0027.
- **Env-gated, production only.** The public token rides the same path as the
  Turnstile site key — a `VITE_CF_WEB_ANALYTICS_TOKEN` build arg
  (`Dockerfile.web` → `docker-compose.yml` → `import.meta.env`), baked into the
  static bundle. Unset in dev/UAT/e2e, so those environments emit nothing and
  show no analytics footer note. Injection lives in
  `apps/web/src/lib/cloudflare-analytics.ts` (`initCloudflareAnalytics`), called
  once at bootstrap; it no-ops when the token is absent and is idempotent.
- **Offline-safe, SW-neutral.** The beacon is cross-origin, so the service worker
  neither precaches nor intercepts it; offline the fetch fails silently. No
  workbox/nginx changes are needed.
- **Transparency.** When enabled, a brief footer note ("cookieless analytics via
  Cloudflare") appears on the landing page and in the app shell.

## Consequences

- **Positive.** Real usage insight with near-zero maintenance and no backend,
  database, or new container. No cookies, no consent banner, no cross-site
  tracking. Dev/UAT stay analytics-free by construction.
- **Cost / risk.**
  - A documented exception to the no-CDN posture — mitigated by being cookieless,
    no-PII, single deferred script, and Cloudflare already being in the path.
  - The token is visible in page source (public by design, like the Turnstile
    site key) — not a secret, but env-injected and never committed.
  - There is **no CSP** today; if one is ever added it must allow
    `script-src https://static.cloudflareinsights.com` and
    `connect-src https://cloudflareinsights.com`.

## Alternatives considered

- **Automatic Cloudflare edge injection.** Zero code — Cloudflare can inject the
  beacon at the edge for proxied HTML. Rejected as the primary mechanism: it's
  invisible/untracked in the repo, depends on proxy mode, and wouldn't apply to
  SW-served shells. The explicit in-app beacon is version-controlled and
  predictable.
- **Self-hosted analytics (Plausible / Matomo / GoatCounter).** Privacy-friendly
  and self-hostable, but each is another container + database + upgrade burden for
  a single-owner app — disproportionate to the need.
- **No analytics.** The status quo; rejected because the owner wants the signal
  and the privacy cost here is minimal.
