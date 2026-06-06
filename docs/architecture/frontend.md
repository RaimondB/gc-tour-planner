# Frontend (React + Vite)

- **State.** TanStack Query for all server state. Local component state with `useState` / `useReducer`; **no** global store (Zustand/Redux) unless a concrete pain point appears.
- **Map.** A single `MapView` component wraps MapLibre. Layers (cache markers, landuse polygons, tour polyline, parking marker) are independent feature components that read query state and push sources/layers to the map ref.
- **Filter sidebar.** Owns the filter form state; pushes to the URL search params (so refresh and sharing preserve view). Debounced; calls `GET /caches` and `POST /tours/plan` via the generated client.
- **API client.** Generated from NestJS OpenAPI via `openapi-typescript-codegen` at build time. Never hand-write fetch calls.
- **Auth (M6).** Session cookie (httpOnly, `SameSite=Lax`) set by the API on login; an `AuthProvider`/`useAuth` reads `GET /auth/me` to know the current user. `api.ts` sends `credentials: "include"` and echoes the `csrf` cookie as `X-CSRF-Token` on mutations; a central 401 handler redirects to `/login`. No tokens in localStorage.
- **Routing (M6).** TanStack Router (first router in the app) splits public routes (`/login`, `/register`, `/shared/:slug`) from the protected app (today's `App.tsx` becomes the `/` route). See [design/auth-and-sharing.md](../design/auth-and-sharing.md).
