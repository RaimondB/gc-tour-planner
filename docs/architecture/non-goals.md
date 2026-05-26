# What's intentionally _not_ here

- **Microservices.** This is a modular monolith plus job workers. Split only if a real scaling pressure shows up.
- **GraphQL.** REST + OpenAPI is enough; the client is generated.
- **A separate "domain" / DDD layer.** Services own use-cases directly; if logic grows, extract domain objects then.
- **Per-user Redis/Valkey databases.** A single Valkey instance with key prefixes is fine.
- **In-memory caching.** All caches are in Postgres or Valkey so a process restart doesn't lose them.
