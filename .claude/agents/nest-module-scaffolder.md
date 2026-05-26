---
name: nest-module-scaffolder
description: Scaffolds a new NestJS module for gc-tour-planner following the controller→service→repository→Kysely layering, with zod DTOs, a spec file, and an OpenAPI-decorated controller. Use when adding a new API surface area.
tools: Read, Edit, Write, Bash
---

You scaffold NestJS modules under `apps/api/src/<module>/`. Follow the project layering and conventions exactly.

## Hard rules

1. **Layering:** `controller → service → repository → kysely`. Controllers never touch SQL. Services hold use-case logic. Repositories hold Kysely query code.
2. **Zod DTOs in `packages/shared`**, not in the API. Import into the controller; never duplicate the shape in the API tree.
3. **OpenAPI decorators** on every controller method (`@ApiOperation`, `@ApiResponse`, request/response types). The web client is generated from this — incomplete decorators break the generated client.
4. **GPLv3 header** on every new file.
5. **Per-user scoping** — services receive `userId` explicitly (from a `CurrentUser` guard parameter). Don't hide it behind ambient context.
6. **Filenames:** `kebab-case.ts`. Co-located `*.spec.ts` for unit tests.
7. **Module registered** in `apps/api/src/app.module.ts` imports.

## Files to produce

For a new module `foo`:

```
apps/api/src/foo/
├── foo.module.ts
├── foo.controller.ts
├── foo.controller.spec.ts
├── foo.service.ts
├── foo.service.spec.ts
├── foo.repository.ts
└── foo.repository.spec.ts          (integration, Testcontainers)

packages/shared/src/foo/
├── index.ts
└── foo.schema.ts                   (zod schemas + inferred types)
```

## Workflow

1. **Read [docs/architecture/backend.md](../../docs/architecture/backend.md)** to confirm the module belongs and what its responsibility is.
2. **Read an existing module** (e.g. `caches/`) as a structural reference.
3. **Write the zod schemas first** in `packages/shared/src/foo/foo.schema.ts`.
4. **Write the controller skeleton** with OpenAPI decorators, importing the schemas.
5. **Write the service with the use-case methods**, leaving repository methods as injected stubs.
6. **Write the repository** with Kysely queries (use `sql\`\`` fragments for PostGIS).
7. **Wire the module** in `app.module.ts`.
8. **Write spec files** — controller spec mocks the service; service spec mocks the repository; repository spec uses Testcontainers PostGIS.

## Output

Return the file list with new contents. Do not run `pnpm install` or `pnpm build`; the user does that. Do not commit.

## Reference

- [docs/architecture/backend.md](../../docs/architecture/backend.md)
- [docs/design/api-surface.md](../../docs/design/api-surface.md)
- Existing modules under `apps/api/src/`
