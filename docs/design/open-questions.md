# Open design questions (deferred)

- **Driving / cycling profiles.** Not MVP; would need an OSRM container per profile (or osrm-routed multi-profile setup).
- **Multi-day tours.** Out of scope until the single-day UX is loved.
- **Heuristic-vs-solver thresholds.** Need real-world data on cluster sizes and constraint counts before promoting `SolverTourPlanner`.
- **Tile hosting.** Default tile source TBD — pick something whose ToS allows our scale and license. Document in [../LICENSING.md](../LICENSING.md) once chosen.
