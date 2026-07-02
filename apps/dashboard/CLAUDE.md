# CLAUDE.md — apps/dashboard

> Scope note: this file is auto-loaded for work under `apps/dashboard`. The repo-root
> [CLAUDE.md](../../CLAUDE.md) (Workflow / Code Style, hook-audited) still applies on top.
> For local run commands see [apps/CLAUDE.md](../CLAUDE.md).

## Project Background

`apps/dashboard` is the **only** frontend in the BoxLite monorepo — the web console for the
BoxLite compute platform (lightweight stateful VMs / "Boxes"). All other `apps/*` are Go/Rust
backend services and are **out of scope** for frontend work.

Stack: **Vite + React + TypeScript + Tailwind + shadcn/ui (Radix)**, nx workspace, yarn.
Data: **TanStack React Query**. Auth: **OIDC** (`react-oidc-context`). Realtime: **socket.io**
+ **Svix**. Server APIs are consumed via the OpenAPI-generated `@boxlite-ai/api-client` /
`@boxlite-ai/analytics-api-client` packages — the dashboard never hand-writes HTTP.

## The Current Goal — "Face-Swap" UI Rewrite (branch `feat/dashboard-floating-restyle`, PR #820)

**Completely rebuild the dashboard UI/UX and visual design language, while adding ZERO new
server APIs or endpoints.** Tear out the presentation layer and rebuild it; reconnect the new
UI to the **existing** data hooks, unchanged. The server contract is frozen.

This is only safe because the codebase has a clean seam: UI never touches HTTP directly — it
goes through React Query hooks, which go through one `ApiClient`, which wraps generated clients.

```
server API ─(same-origin /api, Vite proxy)─ @boxlite-ai/*-api-client (OpenAPI, generated)
   └─ src/api/apiClient.ts  ←token← providers/ApiProvider (OIDC)
        └─ hooks/queries/* (19) + hooks/mutations/* (27)   ← FUNCTIONAL CONTRACT
             └─ pages/* + components/*                       ← THE "FACE" — rebuild this
```

## PRESERVE vs REBUILD — the hard boundary

| Layer | Paths | Action |
|---|---|---|
| Generated API clients | `@boxlite-ai/api-client`, `@boxlite-ai/analytics-api-client` | **Never touch** |
| API wrapper | `src/api/apiClient.ts`, `src/billing-api/`, `src/services/webhookService.ts` | **Preserve** |
| Data hooks (the contract) | `src/hooks/queries/*`, `src/hooks/mutations/*`, `src/hooks/queries/queryKeys.ts` | **Preserve** — new UI imports these as-is |
| Auth / config / context | `src/providers/*`, `src/contexts/*` | **Preserve** (incl. nesting order, see below) |
| Routing & boot | `src/enums/RoutePath.ts`, `src/App.tsx`, `src/main.tsx` | **Preserve structure**; route visibility may change |
| Mock target (MSW) | `src/mocks/*` | **Preserve** — backend-free dev (`npm run start:mock`) |
| Design system | `tailwind.config.js`, `src/index.css`, `src/components/ui/*`, `.storybook/`, ui stories | **Rebuild** |
| Business UI | `src/pages/*` (27), `src/components/*` (~200, except contexts/providers logic) | **Rebuild** |

Rule of thumb: if a file decides **what data to fetch / how state flows / who you are**, preserve it.
If it decides **how it looks**, rebuild it.

## Non-negotiable behavioral constraints (must survive the rewrite)

1. **Org scoping** — nearly every hook depends on `useSelectedOrganization()` and passes
   `organizationId` to the API. The new UI MUST keep a current-organization selector and thread
   the org id through. Dropping it breaks every data call.
2. **Realtime & polling** — keep: `useBoxQuery` 3s polling while a box is transitioning;
   socket.io (`/api/socket.io/`) box/runner/volume events; Svix webhook portal. Don't strip
   subscriptions when replacing components.
3. **Provider nesting order is load-bearing** (each depends on the one above). Preserve:
   `Query → Theme → Config(/api/config + OIDC) → PostHog → [/dashboard] Api → Organizations →
   SelectedOrganization → Regions → NotificationSocket → CommandPalette → Banner`.
4. **Cache invalidation lives in the mutations** — reuse the existing mutation hooks and you
   inherit correct invalidation for free (e.g. create/delete → invalidate list; tier/wallet →
   also usage.overview; coupon → wallet+tier+usage). Do not re-implement writes in components.

## Functional contract surface (domains the UI must keep wiring up)

Boxes (core: `useBoxes`, `useBoxQuery`, `useTerminalSessionQuery`; create/start/stop/delete/
recover/ssh mutations) · API Keys · Organizations · Billing/Wallet/Invoices/Tiers (via
`BillingApiClient`, owner-scoped helpers in `billingQueries.ts`) · Volumes · Audit · Regions ·
Runners · Webhooks (Svix) · Analytics/Usage (needs `config.analyticsApiUrl`) · Users.

## Current visibility

Only **9 pages are active**; 13 are redirected to `/boxes` via `HIDDEN_DASHBOARD_ROUTES` in
`App.tsx` (Images, Volumes, Limits, BillingSpending, BillingWallet, Members, Roles, AuditLogs,
Regions, Runners, Experimental, Webhooks, WebhookEndpointDetails). Their hooks/components still
exist. Active: Landing · Dashboard (shell/nav) · **Boxes** (list + detail + fullscreen terminal +
lifecycle + SSH + onboarding — the core) · Keys · Billing · Admin · OrganizationSettings ·
EmailVerify · Logout.

## Recommended rebuild path

1. Develop against `npm run start:mock` (MSW, no backend, no login) for fast UI iteration.
2. Rebuild bottom-up: design tokens (`tailwind.config.js` + `index.css`) → `components/ui/*`
   primitives → business `components/*` → `pages/*` → `Dashboard.tsx` shell. **The hook layer
   stays untouched throughout.**
3. Prioritize the Dashboard shell + the full Boxes experience — ~80% of visible value.
4. Keep the 13 hidden pages hidden during the main restyle; un-hide + restyle them afterwards.

## Dev commands

Run from `apps/` (nx root): `npm run start:mock` (MSW, recommended for restyle) ·
`npm run start` (dev API) · Storybook for the design system. See [apps/CLAUDE.md](../CLAUDE.md).
