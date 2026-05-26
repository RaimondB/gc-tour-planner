# Frontend (React + Vite)

- **State.** TanStack Query for all server state. Local component state with `useState` / `useReducer`; **no** global store (Zustand/Redux) unless a concrete pain point appears.
- **Map.** A single `MapView` component wraps MapLibre. Layers (cache markers, landuse polygons, tour polyline, parking marker) are independent feature components that read query state and push sources/layers to the map ref.
- **Filter sidebar.** Owns the filter form state; pushes to the URL search params (so refresh and sharing preserve view). Debounced; calls `GET /caches` and `POST /tours/plan` via the generated client.
- **API client.** Generated from NestJS OpenAPI via `openapi-typescript-codegen` at build time. Never hand-write fetch calls.
- **Auth.** JWT cookie set by API on login; React reads `GET /auth/me` to know the current user. No tokens in localStorage.
