# Conventions

- **Naming.** `kebab-case` filenames; `PascalCase` for React components and Nest classes; `camelCase` for variables.
- **Errors.** API throws Nest exceptions; web surfaces user-readable messages via a single error boundary + toast.
- **Logging.** Pino in the API; emits JSON in production, pretty in dev. Never log full GPX bodies or cache descriptions.
- **Migrations.** One SQL file per change, never edit a merged migration. Indexes added in the same migration as the column they support. See [../sdlc/migrations.md](../sdlc/migrations.md).
- **Tests.** Co-located in `*.spec.ts` / `*.test.ts` next to the unit under test; integration tests in `apps/api/test/integration/`; E2E in `apps/web/e2e/`. See [../sdlc/testing.md](../sdlc/testing.md).
