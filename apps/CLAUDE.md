## Local Dashboard And E2E Commands

- Use `npm run start` from the repository root for dashboard-only work against the shared dev API.
- Use `npm run dev:dex` from the repository root for full local Dex development. It starts Docker Postgres, Redis, Dex, and the apps workspace with OIDC pointed at Dex.
- Use `npm run e2e:local` from the repository root for local browser E2E. This is the only E2E startup entrypoint; do not use `start`, `start:dex`, or `serve-slim` directly for E2E.
- The local Dex test account is `admin@boxlite.dev` / `password`. Browser E2E should log in through Dex when redirected and should not depend on cached cookies.
- `dev:dex` and `e2e:local` require Docker Desktop and create/reuse `boxlite-local-postgres`, `boxlite-local-redis`, and `boxlite-local-dex`.
