# Architecture

This document describes the system shape: services, repo layout, module responsibilities, and how data flows. Concrete schemas, algorithms, and API payloads live in [../design/](../design/index.md). The _why_ behind each major choice lives in the ADRs.

## Parts

- [System context](system-context.md) — top-level component diagram + external data sources
- [Repository layout](repo-layout.md) — monorepo tree and what goes where
- [Backend (NestJS)](backend.md) — module responsibilities + layering rule
- [Frontend (React + Vite)](frontend.md) — state, map wrapper, API client, auth
- [Data flow — happy paths](data-flow.md) — upload, filter, plan, save
- [Background work + deployment](background-and-deploy.md) — BullMQ queues, docker-compose services, prod differences
- [Non-goals](non-goals.md) — what we intentionally do NOT build
