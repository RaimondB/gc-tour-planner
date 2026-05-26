# Requirements — Persistence + sharing (M6)

Saved tours, read-only sharing links, authentication. All gated on M6.

- **FR-P1.** Authenticated users can **save** a planned tour (name, cache ids, start/parking, totals, geom, score breakdown).
- **FR-P2.** Saved tours list per user; open / rename / delete.
- **FR-P3.** Generate a **read-only sharing link** (opaque slug) — anonymous viewer can see map + list without auth.
- **FR-P4.** Auth: email + argon2 password **and** Google OAuth. JWT in httpOnly SameSite=Lax cookie + CSRF token.
