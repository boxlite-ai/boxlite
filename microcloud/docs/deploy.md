# Deploying the Micro-cloud App platform

How to bring the whole thing up in a fresh environment: the control plane, the console, the CLI
agents install, and the supervisor every App Box runs. One script does it; this page is what to
prepare, what to run, and how to check it worked.

## What gets deployed

```
                      BoxLite (dev or prod) ────────────── Neon (Postgres per App environment)
                             │
   ┌─────────────────────────┴─────────────────────────┐
   │ Box "microcloud-cp"  (4 CPU, 8 GB, never stops)    │
   │   control plane  :8080  API, agent.md, CLI .tgz,   │      App Boxes, one per App environment,
   │                         supervisor binaries        │ ───▶ created by the control plane; each runs
   │   console        :8081  /console/                  │      the supervisor and the App's services
   │   App origins    :10001-10999 (one per environment)│
   └────────────────────────────────────────────────────┘
```

Each port is a BoxLite tunnel URL (`https://<port>-<box>.proxy.<zone>`); the control plane opens
its own tunnels for 8081 and the App origins. State lives in `/home/boxlite/cp/data` on that Box
(SQLite, keys, sessions) and survives redeploys.

## 1. Prerequisites

Accounts and keys (ask the team lead; never paste them into chat or commit them):

| What | Why | Where it goes |
|---|---|---|
| BoxLite API key (`blk_live_…`) of the organization to run in | creates the control plane's Box and every App Box | `.env.local` `BOXLITE_API_KEY` |
| Neon API key and organization id | one Postgres branch per App environment | `.env.local` `NEON_API_KEY`, `NEON_ORG_ID` |
| GitHub OAuth app (optional) | "Continue with GitHub" for the console and for Apps | `.env.local` `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` |

The BoxLite organization needs room for Boxes: the control plane takes one, every App environment
one more (dev's default limit is 20). Deleted Apps keep theirs for 7 days unless purged.

Tools on the machine you deploy from:

| Tool | Version | Check |
|---|---|---|
| Node | ≥ 22.13 | `node -v` |
| pnpm | 11 (`corepack enable`) | `pnpm -v` |
| yarn | 4 (for the console, `corepack enable`) | `yarn -v` |
| Go | 1.26 | `go version` |
| `boxlite` CLI | ≥ 0.10 | `boxlite --version` |
| curl, python3, tar | any | |

## 2. Get the code

```sh
git clone https://github.com/boxlite-ai/boxlite.git && cd boxlite
git checkout micro-cloud-app
(cd microcloud && pnpm install)      # control plane, CLI, shared, e2e
(cd apps && yarn install)            # the console (apps/dashboard)
```

`microcloud/` is the platform; `apps/dashboard` holds the console's Apps pages. The deploy script
builds the console from `apps/` by itself.

## 3. Configure

```sh
cd microcloud
cp deploy/env.example .env.local    # then fill in the keys from step 1
```

Optional, once per build machine: `make -C supervisor release-key`. With that key the supervisor
binaries are signed and App Boxes refuse unsigned updates. The private key stays on that machine.

To run a second control plane next to an existing one, set `CP_BOX=<your-name>` in `.env.local`;
to target another BoxLite environment, `CP_BOXLITE_REST` and `CP_BOXLITE_CLI_URL` (see
`deploy/env.example`).

## 4. Deploy

```sh
sh deploy/deploy-cp.sh
```

It builds the supervisor, control plane, CLI and console, creates the Box on the first run (later
runs reuse it, and the URL stays the same), uploads the bundle, restarts the server and waits for
`/healthz`. It ends with:

```
live: https://8080-<box>.proxy.<zone>
console: https://8081-<box>.proxy.<zone>/console/
```

The first run also writes two files next to `.env.local`, both gitignored and both needed for
every later deploy: `.cp-admin-token` (the console's admin login) and `.cp-session-secret`.
Keep them; losing the session secret signs everyone out.

Faster redeploys: `CP_ONLY=1` (control plane and agent guide only, about a minute),
`SKIP_CONSOLE=1`, `SKIP_CLI=1`.

Never run the script with `sh -x`: the trace prints the keys from `.env.local`.

## 5. First use

1. Open the console URL and sign in with the contents of `.cp-admin-token`
   (or "Continue with GitHub" once the OAuth app is set up).
2. If you configured GitHub: register `<live URL>/auth/callback/github` as the OAuth app's
   callback URL.
3. **New app** → name it → **Copy prompt** → paste it into a coding agent with one sentence of
   what to build. The agent installs the CLI from `<live URL>/cli/boxlite-app.tgz`, reads
   `<live URL>/agent.md`, and deploys on its own.

## 6. Check it

From `microcloud/`, against the new control plane (each suite creates and purges its own App):

```sh
CP_URL=<live URL> node e2e/run-live.mjs          # the agent's whole journey, about 10 min
CP_URL=<live URL> node e2e/errors-live.mjs       # every failure says its cause and fix
CP_URL=<live URL> node e2e/console.spec.mjs      # the console, page by page (Playwright)
CP_URL=<live URL> node e2e/python-live.mjs       # a Python App
```

The console suite drives a real browser: once, `(cd e2e && npx playwright-core install chromium)`.
`e2e/email-live.mjs` needs the dev SMTP sink below. Unit tests: `pnpm -r test` and
`make -C supervisor test`.

## Optional features

- **Email code sign-in** works with each App owner's own SMTP account (docs/email-sign-in.md).
  The script starts a local SMTP sink on the Box and allows it as the one private sender
  (`SMTP_DEV_SINK`); that is for testing and harmless elsewhere.
- **Custom domains** stay off until the BoxLite proxy in front can resolve them
  (docs/custom-domains.md): then set `CUSTOM_DOMAIN_TARGET` and `CUSTOM_HOST_RESOLVER_TOKEN`.

## When something is wrong

| Symptom | Look at |
|---|---|
| deploy stops at "CP did not come up" | it prints the end of `cp.log`; more: `boxlite --url <CLI URL> exec <box> -- tail -100 /home/boxlite/cp/cp.log` |
| creating an App fails with 429 "box creation limit" | the organization is out of Boxes: purge test Apps (`DELETE <live URL>/v1/apps/<name>?purge=1`, admin token) |
| agents get "App key not recognised" | a `BOXLITE_API_KEY` in their shell holds another key; the CLI says so since 0.3.11 |
| the console shows old pages after a deploy | the console was skipped: deploy without `SKIP_CONSOLE` / `CP_ONLY` |

Where the code is explained: `docs/architecture.md` (start here), `docs/contracts.md` (wire
formats), `docs/decisions.md` (why).
