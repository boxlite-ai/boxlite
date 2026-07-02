# BoxLite Console Restyle — Execution Plan

Companion to [CLAUDE.md](./CLAUDE.md). This is the working spec for the "face-swap" rewrite:
rebuild the UI to the new ASCII/terminal design, reconnect to the **existing** data hooks
unchanged, add **zero** new server APIs.

Design source (visual/interaction spec only, NOT importable code — DCLogic prototypes):
`~/Downloads/ASCII-BOXLITE-CONSOLE-PAGE/*.dc.html`.

## Locked decisions (2026-06-19)

1. **Login** → re-skin OIDC. Keep `signinRedirect`; SSO buttons trigger OIDC; the email/password
   + signup form is visual-only / forwards to hosted login. **No backend auth API is added.**
2. **Billing** → ship the "Billing is on the way" empty state only (matches current live behavior).
   The rich usage/plans/invoices design is deferred (maps to currently-hidden Spending/Wallet/Limits).
3. **Org switcher** → standalone control in the top Nav (all hooks are org-scoped; must not drop it).
4. **Undesigned pages** → rebuild needed active pages (Admin, OrganizationSettings, EmailVerify) in the
   new design language; the 13 hidden pages stay hidden.

## New design language

- Font **IBM Plex Mono** everywhere, 13px base. Corners **square (radius 0)**. Dotted/dashed dividers.
- Tokens (dark): bg `#13161B` · card `#1A1D24` · term `#0D0F13` · fg `#FFF` · dim `#8C919C` ·
  border `#2A2F3A` · accent `#00B0F0` · up `#5ad67d`.
- Tokens (light): bg `#FFF` · card `#F3F4F6` · term `#F5F7FA` · fg `#13161B` · dim `#6B7079` ·
  border `#E2E5EA` · accent `#00B0F0`.
- Status: RUNNING `#5ad67d` · IDLE `#e0b341` · STOPPED/ERROR `#e0564a`.
- Theme persisted to localStorage `boxlite-theme` (system/light/dark) — unify with `ThemeContext`.
- Motifs: ASCII activity strips (4-level blue), ASCII orb (plan cards), live-ticking numbers,
  scanline animation, `▸` prefixes. Nav is a **top horizontal bar** (replaces the shadcn sidebar).

## Page → feature → hooks map (contract preserved)

| New design | Existing page/components | Reused hooks (unchanged) |
|---|---|---|
| Login.dc | LandingPage.tsx | react-oidc-context `signinRedirect` |
| Nav.dc | Dashboard.tsx shell | ThemeContext, useAuth (sign out), useSelectedOrganization (+ org switcher), quickstart flag |
| Boxes page.dc | Boxes.tsx + BoxTable + CreateBoxDialog | useBoxes, useCreateBoxMutation, useStart/Stop/DeleteBoxMutation, useCreateSshAccessMutation; stat cards → analytics usage (graceful-degrade if `analyticsApiUrl` unset) |
| Box detail.dc | components/boxes/* (BoxDetails, BoxTerminalTab) | useBoxQuery (transition poll), start/stop/delete/recover, useTerminalSessionQuery, SSH mutations. NOTE: new design shows only spec panel + shell terminal, so the old logs/metrics/traces/spending tabs (BoxContentTabs) are NOT rendered anymore — their components/hooks still exist and can be re-added if wanted. |
| API keys.dc | Keys.tsx + ApiKeyTable + CreateApiKeyDialog | useApiKeysQuery, useCreateApiKeyMutation, useRevokeApiKeyMutation |
| Quickstart.dc | Onboarding / OnboardingGuideDialog | useCreateApiKeyMutation (run-step is decorative) |
| Billing.dc (empty) | Billing.tsx | none (static) |
| Usage and billings.dc / Billing.standalone.dc | (deferred) Spending/Wallet/Limits | analytics + billing hooks — NOT in this pass |

## Progress

- ✅ **P0 done & verified** (mock render): index.css token map, IBM Plex Mono, square corners,
  `brand` blue, theme key `boxlite-theme` (default dark). All 41 `components/ui/*` re-skinned via token swap.
- ✅ **P1 done & verified**: `components/Sidebar.tsx` rewritten as the Nav.dc top bar (logo · Boxes ·
  Billing · Admin[if perm] · Search⌘K · API Keys · Guide progress · **standalone org switcher** ·
  profile menu with appearance/docs/discord/sign out). All command/onboarding wiring preserved.
  Org switcher lists orgs + calls `onSelectOrganization`; verified via Playwright.
- ✅ **P2 done & verified** (Boxes core): `pages/Boxes.tsx` rebuilt to the `Boxes page.dc.html` layout
  (Fleet header + 3 stat cards w/ LIVE pulse, fed real box-derived data: running/total/vCPU) ·
  `components/BoxTable/index.tsx` rewritten as the design table (▸ name, status dot+label at exact
  hex, CPU/RAM/DISK quota, relative Created, row actions play/pause/recover + terminal + more-menu) ·
  `components/Box/CreateBoxDialog.tsx` rebuilt as the New Box modal (name, image dropdown, segmented
  CPU/Mem/Disk, live price/hr). All wired to existing handlers + useCreateBoxMutation; verified via Playwright.
  Note: bulk-select & column-sort are not in the new design, so they're dropped from this view (handlers preserved in Boxes.tsx).
- ✅ **P4 done & verified** (API Keys): `pages/Keys.tsx` design header + table; `components/ApiKeyTable.tsx`
  rebuilt as the design grid (Name/Key/Permissions/Created/Last Used/Expires + trash revoke + div empty
  state + "25 per page" footer); `components/CreateApiKeyDialog.tsx` rebuilt as the Create modal (name,
  expires preset dropdown, Boxes-API-access info) + one-time reveal modal (blue key box + Copy). Full
  create→reveal flow verified against the real useCreateApiKeyMutation (returns mock key).
- ✅ **P6 Billing done & verified**: `pages/Billing.tsx` rebuilt to `Billing.dc.html` empty state
  (centered "Billing is on the way" + 4 metering-dimension cards with seg-wave animation + Back to Fleet).
  Added `seg-wave` keyframe to index.css.
- ✅ **Login done** (compiled; mock auto-auths so not screenshot-verifiable here): `pages/LandingPage.tsx`
  rebuilt to `Login.dc.html` (SIGN IN/SIGN UP tabs, Google/GitHub SSO, email/password, show/hide, remember,
  signup confirm). Every action calls OIDC signinRedirect — no new auth API.
- ✅ **P3 done & verified** (Box detail): `components/boxes/BoxDetails.tsx` render rewritten to
  `Box detail.dc.html` (breadcrumb · identity strip with status badge + image chip + start/stop/recover/
  ssh/more/refresh · left spec readout GENERAL/RESOURCES/LIFECYCLE/TIMESTAMPS with dotted leaders · right
  SHELL panel embedding the real BoxTerminalTab). All hooks/handlers (useBoxQuery poll, ws sync,
  start/stop/recover/delete, SSH dialogs, onboarding) preserved. Verified via Playwright.
- ✅ **P5 done & verified** (Quickstart): `components/OnboardingGuideDialog.tsx` rebuilt as the
  `Quickstart.dc.html` 3-step wizard (stage rail · step1 real key creation via apiKeyApi.createApiKey ·
  step2 language tabs + install cmd · step3 run animation · "Box is live." confetti finale). Marks
  onboarding progress + boxlite-quickstart-done. Verified via Playwright.

**ALL designed surfaces complete** (Login · Nav · Boxes+NewBox · Box detail+terminal · API Keys+create/reveal ·
Quickstart · Billing). Every page is pixel-rebuilt to the .dc.html design and wired to the unchanged
hooks/mutations/providers.

- ✅ **P7 done** (undesigned active pages reshelled in the new language):
  - `pages/OrganizationSettings.tsx` — mono header + bordered details card (name+Save, id+copy, default region). Verified.
  - `pages/EmailVerify.tsx` — mono centered status card (loading/success/error). Compiled.
  - `pages/Admin.tsx` — page chrome reshelled (mono header, bordered segmented view-switch, brand search);
    heavy data-dense sub-views (AdminStatusStrip/Overview/People/Fleet/TelemetryDrawer) kept on the new
    tokens. 403-gated in mock (redirects), so not screenshot-verifiable here; compiles + gate works.

**Restyle complete.** Outstanding (non-blocking): full end-to-end verification against a real dev API
(login flow, terminal session, org switch reload, billing/analytics-gated paths) + Storybook refresh.
Verification screenshots saved at repo root (p0–p7 *.png).

## Phases

- **P0 — Design-system foundation.** New token set + `boxlite-theme` unified into ThemeContext;
  rewrite `index.css` + `tailwind.config.js`; re-skin `components/ui/*` (keep Radix behavior):
  button, dialog, table, input, badge, tabs, dropdown-menu, card, tooltip, sonner, etc.
- **P1 — Shell.** Dashboard.tsx sidebar → top Nav (theme switch, sign out, Guide, **org switcher**).
  Preserve Outlet, routing, and the full provider nesting order.
- **P2 — Boxes (core).** Fleet list + stat cards + New Box modal + inline start/stop/ssh/delete.
- **P3 — Box detail.** Spec readout + real terminal panel (useTerminalSessionQuery + existing
  BoxTerminal*) + lifecycle. (Design = spec + shell only; logs/metrics/traces/spending tabs dropped from the UI.)
- **P4 — API Keys.** Table + create modal + one-time key reveal.
- **P5 — Quickstart/Onboarding.** 3-step guide wired to key creation.
- **P6 — Billing.** Empty-state page only.
- **P7 — Finish.** New-language shells for Admin / OrganizationSettings / EmailVerify; hidden pages
  stay hidden. Full `start:mock` regression + real dev-API verification; update Storybook.

## Invariants (every phase)

Org scoping · transition polling + socket.io realtime · cache invalidation via reused mutations ·
provider nesting order. Develop on `npm run start:mock` (from `apps/`); verify against dev API.
