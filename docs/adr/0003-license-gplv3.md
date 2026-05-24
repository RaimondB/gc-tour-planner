# ADR-0003 — License: GPL-3.0-or-later

- **Status:** Accepted
- **Date:** 2026-05-24
- **Deciders:** Raimond Brookman (owner)

## Context

The project is open-source from day 1 (public GitHub repo under `RaimondB`). We needed to pick a license before bootstrap.

Constraints:

- The owner wants modifications to stay open. A permissive license (MIT/Apache-2.0) allows closed-source forks, which he does not want for this project.
- We depend on **PostGIS** (GPL-2.0+), which is GPLv3-compatible. We do _not_ statically link PostGIS, but we operate it as a tightly-coupled runtime.
- We depend on **OSM data** (ODbL 1.0), which is share-alike for derivative databases.
- We may eventually integrate **Groundspeak partner APIs** under their ToS — orthogonal to source-code license but worth noting.
- No corporate constraint or contributor-license-agreement requirement.

## Decision

License the project under **GPL-3.0-or-later** (`SPDX-License-Identifier: GPL-3.0-or-later`).

- `LICENSE` at repo root contains the full GPLv3 text.
- Every source file (TS/JS/SQL in `apps/` and `packages/`) gets a header:
  ```
  // Copyright (C) 2026 Raimond Brookman and contributors
  // SPDX-License-Identifier: GPL-3.0-or-later
  ```
- Contributor expectation: by submitting a PR you agree your contribution is licensed under GPL-3.0-or-later. No CLA.
- CI runs a license-checker step on `pnpm-lock.yaml` that fails on incompatible licenses (SSPL, RSAL, BUSL, Commons Clause, CC-BY-NC, …).

## Alternatives considered

- **MIT / Apache-2.0.** Maximum adoption, but allows closed-source forks. Owner explicitly does not want this for this project.
- **AGPLv3.** Adds the "network use = distribution" clause — meaningful for a hosted SaaS. The owner is not running a SaaS at MVP; AGPL chills contributions for a personal/community-hosted tool. We can re-evaluate if a hosted offering becomes the primary use case.
- **MPL-2.0 / LGPL.** Weak copyleft, file-level. Less aligned with the owner's "keep derivatives open" intent.
- **Dual-license.** Adds maintenance overhead with no benefit at MVP.

## Consequences

- **Cannot use SSPL-licensed Redis** — use Valkey instead. Recorded in [ADR-0004](0004-valkey-over-redis.md).
- **Cannot bundle Groundspeak's copyrighted icons** — use Material Symbols or text chips.
- **Any third-party JS dep with an incompatible license is a CI failure.** This will catch issues early but means picking deps requires a license check.
- **Operators of forks** must release their modifications under GPLv3 if they distribute (including most container-based deployment patterns where Dockerfiles are the distribution mechanism).
- **Acceptable trade-off** — the project is a personal/community tool; the owner prefers a smaller contributor base that respects copyleft over a larger one that doesn't.
