# ADR-0004 — Use Valkey instead of Redis

- **Status:** Accepted
- **Date:** 2026-05-24
- **Deciders:** Raimond Brookman (owner)

## Context

The project needs an in-memory key-value store for:

1. **BullMQ** job queue (Overpass refresh, GPX async parse, leg prefetch).
2. **Distributed locks** to dedup concurrent external API calls (thundering-herd protection around Overpass).
3. **Hot caches** in front of Postgres (recent OSRM nearest-road lookups, etc.).

Redis was the obvious default for years. In March 2024, Redis Ltd. changed Redis 7.4+ licensing to **dual SSPL / RSAL v2**. Both are non-OSI and are widely interpreted as incompatible with GPLv3 distribution (and the GPLv3 project may not be aggregated with an SSPL component without conflict).

The Linux Foundation forked Redis 7.2 as **Valkey**, retaining the **BSD-3-Clause** license. Valkey is wire-compatible with Redis (Redis client libraries — including BullMQ's `ioredis` — connect with no code changes).

## Decision

Use **Valkey** as the BullMQ backend and as the project's cache / lock store. Pin the container image to `valkey/valkey:8` (or newer LTS). Never add a runtime dep on the upstream `redis` image.

The application code references it via a single env var: `VALKEY_URL` (e.g. `redis://valkey:6379`). All client libraries continue to use `ioredis` — they are protocol-compatible.

## Alternatives considered

- **Redis 7.2 (the last BSD-3 release).** Frozen — no security fixes upstream. Untenable for production.
- **KeyDB.** Active fork but smaller community; less momentum than Valkey.
- **Dragonfly.** BSL — also a license problem for our GPLv3 distribution.
- **Postgres LISTEN/NOTIFY + a `jobs` table.** Workable but BullMQ's tooling (retries, delays, observability) is hard to give up. Defer to "if Valkey ever becomes a pain".
- **In-memory cache only (no shared store).** Breaks once we have > 1 API replica. Plan for 2+ replicas from day 1.

## Consequences

- **No code change ever needed.** `ioredis` connects to Valkey natively.
- **Slightly less ecosystem documentation** — Stack Overflow answers reference Redis. Acceptable; problems and solutions are 1:1 portable.
- **Tooling that hard-codes "Redis" in branding** (some monitoring dashboards) may look odd. Cosmetic.
- **If/when Redis Ltd. ever returns to a permissive license**, we can revisit. Until then, Valkey is the load-bearing choice.
- **CI license-checker is configured to flag SSPL / RSAL**, so an accidental `redis` package introduction will fail the build.
