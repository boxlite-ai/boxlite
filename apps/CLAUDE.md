## Local Dashboard And E2E Commands

Run these from `apps/` (the nx workspace root), **not** the repository root.

The dashboard always calls a same-origin `/api` path; Vite proxies `/api` to the
selected backend, so the browser never makes a cross-origin (CORS-gated) request
and no backend has to allow-list `localhost`. The proxy target is chosen by the
command and read by `apps/dashboard/vite.config.mts` via `DASHBOARD_API_PROXY_TARGET`
(see the `API_TARGETS` map in `apps/scripts/start-dashboard.mjs`). Auth follows the
selected API: login uses whatever OIDC issuer that API's `/api/config` reports.

- `npm run start` / `npm run start:dev` — dashboard against the **dev API** (default).
- `npm run start:local` — dashboard against a **local API** (`/api` → `http://localhost:3001`).
- `npm run start:prod` — dashboard against the **prod API**. Guarded: requires
  `--yes-prod`, and prod is unconfigured until the prod stage exists.
- `npm run start -- --api=<url>` — proxy `/api` to **any** API URL (staging, a PR preview, …).
- `npm run start:mock` — MSW mocks; no backend, no login.
- `npm run dev:dex` — full local Dex development. Starts Docker Postgres, Redis, Dex,
  and the apps workspace with OIDC pointed at Dex.
- `npm run e2e:local` — the only E2E startup entrypoint; do not use `start`,
  `start:dex`, or `serve-slim` directly for E2E.
- The local Dex test account is `admin@boxlite.dev` / `password`. Browser E2E should
  log in through Dex when redirected and should not depend on cached cookies.
- `dev:dex` and `e2e:local` require Docker Desktop and create/reuse
  `boxlite-local-postgres`, `boxlite-local-redis`, and `boxlite-local-dex`.
