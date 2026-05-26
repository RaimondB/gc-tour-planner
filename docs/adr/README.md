# Architecture Decision Records

We use lightweight ADRs (Michael Nygard style) to record decisions whose _why_ is non-obvious from the code.

**When to write an ADR:** any decision a future contributor (or future-you) would reasonably challenge — choice of framework, choice of license, choice of algorithm class, replacing a popular tool with a less popular one. Don't write one for naming, formatting, or routine refactors.

**Naming:** `NNNN-short-kebab-slug.md`, NNNN sequential and never reused.

**States:** `Proposed` → `Accepted` / `Rejected` → `Superseded by ADR-XXXX`. Never delete or rewrite a superseded ADR — write a new one that references it.

| #                                          | Title                                              | Status   |
| ------------------------------------------ | -------------------------------------------------- | -------- |
| [0001](0001-stack-choices.md)              | Tech stack (TypeScript + NestJS + React + PostGIS) | Accepted |
| [0002](0002-planner-strategy-interface.md) | Pluggable `TourPlannerStrategy`                    | Accepted |
| [0003](0003-license-gplv3.md)              | License: GPL-3.0-or-later                          | Accepted |
| [0004](0004-valkey-over-redis.md)          | Use Valkey instead of Redis                        | Accepted |
| [0005](0005-timefold-solver-sidecar.md)    | Timefold as the solver-backed `TourPlannerStrategy` | Accepted |
| [0006](0006-docs-restructure-and-sync-policy.md) | Docs restructure into per-area subdirectories + sync policy | Accepted |
