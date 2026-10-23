# boxlite-app CLI reference

Generated from the command definitions by `cli/scripts/gen-reference.ts` (CLI 0.3.8); do not edit by hand. Offline: `boxlite-app docs reference [command…]`.

## Conventions

- Global options on every command: `--json`, `--env <name>` (default: `.boxlite/link.json`, else `main`).
- The App is taken from `.boxlite/link.json`, then `BOXLITE_APP`, then the App the key belongs to. Credentials: `BOXLITE_API_KEY`, `BOXLITE_API_URL`.
- `--json`: exit 0 prints exactly one JSON document on stdout. Any other exit prints nothing on stdout and one `{"error": {…}}` object on stderr. `--follow` modes stream NDJSON, one object per line.
- Errors always carry `code`, `message` and `next` (a runnable command or a file edit), often `docs` (a `boxlite-app docs` topic) and code-specific fields.
- Human mode ends successful commands with a `next:` line when there is an obvious next step.
- Nothing printed ever contains an App key, box token or database password: output is masked (`bxl_app_…abcd`, `postgresql://user:****@host`).

## Exit codes

| exit | error code | meaning |
|---|---|---|
| 0 | | success |
| 1 | `usage`, `invalid_request`, `conflict`, `sql_error`, … | any other error; `next` says what to do |
| 2 | `unauthenticated` | BOXLITE_API_KEY missing or not accepted |
| 3 | `not_found_app` | the App does not exist |
| 3 | `not_found_env` | the environment does not exist |
| 4 | `not_found` | a deployment, table, file, schedule… does not exist |
| 5 | `forbidden` | outside the key’s scope, or not allowed here (e.g. DDL on main) |
| 5 | `write_requires_flag` | the SQL changes data and ran without --write; nothing ran: rerun with `--write` |
| 6 | `unavailable` | control plane or platform unreachable; wait 30 s and rerun (max 3 times) |
| 6 | `rate_limited` | too many requests; the CLI already waited Retry-After and retried 3 times: wait 30 s and rerun |
| 7 | `invalid_manifest` | boxlite.toml / project check failed; the body carries errors[] |
| 8 | `deploy_failed` | the deployment failed; the body carries deployment, step, cause, fix, log_tail |
| 9 | `stale_base` | someone changed the environment online since your last sync; `boxlite-app app pull` |
| 10 | `confirmation_required` | a command that asks first ran without --yes and without a terminal. Destructive ones (the body carries destroys[]): ask the user, then rerun with --yes; `apply`: just rerun with --yes |

## Types

Shapes the `--json` lines below refer to by name.

- `EnvSummary`: `{ name, status, url, access, spec_version: number | null, latest_deployment: { number, kind, status, message, created_at } | null, live_deployment: { number, kind, release, live_at } | null, box: { id, image, size } | null, database: { branch } | null, from: string | null, created_at }`
- `Deployment`: `{ number, kind: "deploy"|"apply"|"rollback", status: "queued"|"uploading"|"building"|"migrating"|"starting"|"live"|"failed"|"cancelled"|"superseded"|"rolled_back", message, by, created_at, started_at, finished_at, spec_version, base_version, snapshot_id, release, rollback_to, restore_point, steps: { name, status, ms?, detail? }[], changes, error: { step, message, log_tail? } | null, url, log_tail? }`
- `Diagnosis`: `{ cause: "missing_lockfile"|"npm_script_missing"|"module_not_found"|"build_timeout"|"build_command_failed"|"port_binding"|"health_404"|"health_failed"|"crash_on_start"|"missing_variable"|"migration_sql_error"|"migration_changed"|"invalid_manifest"|"supervisor_unreachable"|"unknown", summary, fix, file?, line?, evidence: string[] }`
- `LogLine`: `{ id, ts, source, level: "info"|"error"|…, line, deployment: number | null }`
- `AgentContext`: `{ app, env, control_plane, generated_at, status, urls: { app, health, login }, access: { level, source }, environments, live, box: { id, state, usage: { memory_total_bytes, memory_available_bytes, disk_total_bytes, disk_free_bytes } | null }, runtime, services: { name, exposed, command, static, health_path, state, health, restarts, last_exit_code, memory_bytes }[], schedules, database: { status, branch, tables: { name, columns }[], migrations }, volumes, auth, variables: { name, value | null, secret, source, resolved }[], deployments (last 5), recent_errors, next_actions: Finding[], cli: { latest_version } }`
- `Finding`: `{ id, severity: "error"|"warn"|"info", title, fix, detail?, evidence? }`

## Commands

### `boxlite-app init`

write boxlite.toml, .boxlite/link.json, .gitignore entries and an AGENTS.md block in the current directory (never overwrites)

Usage: `boxlite-app init [options]`

| option | description | default |
|---|---|---|
| `--app <name>` | App name (default: the App the key belongs to) |  |
| `--no-agents-md` | do not write the BoxLite block into AGENTS.md |  |

- Network: talks to the control plane
- `--json`: `{ app, env, base_version, api_url, created: string[], unchanged: string[] }`
- Exit codes: 0, 1, 2, 3, 6

### `boxlite-app check`

validate boxlite.toml and the project locally (no network); exit 7 on errors

Usage: `boxlite-app check [options]`

| option | description | default |
|---|---|---|
| `--online` | also ask the control plane (/plan) and merge its errors |  |

- Network: local only
- `--json`: `{ ok: true, errors: [], warnings: { rule, message }[] }; on errors (exit 7, stderr): { error: { code: "invalid_manifest", errors: { file, line?, rule, message }[], warnings } }`
- Exit codes: 0, 1, 7

### `boxlite-app plan`

show what apply/deploy would change in this environment (exit 9 when boxlite.toml is stale)

Usage: `boxlite-app plan [options]`

| option | description | default |
|---|---|---|
| `--force` | plan even when the local base version is behind the environment (the online changes would be overwritten) |  |

- Network: talks to the control plane
- `--json`: `{ app, environment, base_version, latest_version, stale, changes (configuration): { kind: "+"|"~"|"-"|"online_only", path, from?, to? }[], errors: CheckError[], warnings: CheckWarning[], upload: { files, bytes } (the whole snapshot), code: { files, bytes, new_files, new_bytes } (what a deploy would upload) }`
- Exit codes: 0, 1, 2, 3, 6, 7, 9

### `boxlite-app apply`

provision the resources in boxlite.toml (database, migrations, volumes, auth, variables) without uploading code

Usage: `boxlite-app apply [options]`

| option | description | default |
|---|---|---|
| `-y, --yes` | do not ask for confirmation |  |
| `--force` | apply even when the local base version is behind the environment: overwrites changes made online; only when the user asks |  |
| `-m, --message <text>` | description shown in the deployment list |  |

- Network: talks to the control plane
- `--json`: `Deployment (kind "apply", status "live" = applied) & { applied: true, serving: boolean | null (false until a deploy has shipped code; null when it could not be checked) }; nothing to do: { applied: false, changes: [] }`
- Exit codes: 0, 1, 2, 3, 6, 7, 8, 9, 10

### `boxlite-app deploy`

upload the project, build and start it on the environment, and follow the deployment until it is live or failed

Usage: `boxlite-app deploy [options]`

| option | description | default |
|---|---|---|
| `-m, --message <text>` | deployment message |  |
| `--detach` | return as soon as the deployment is queued |  |
| `--force` | deploy even when the local base version is behind the environment: overwrites changes made online; only when the user asks |  |
| `--dry-run` | check + plan + upload size; upload and deploy nothing |  |
| `-v, --verbose` | stream build and start log lines as they arrive |  |
| `-y, --yes` | accepted for symmetry with apply; deploy never prompts |  |

- Network: talks to the control plane
- `--json`: `Deployment (status "live") & { build_warnings: { id, title, fix, evidence }[] }; --dry-run: { dry_run: true, app, environment, base_version, latest_version, stale, changes, errors, warnings, upload: { files, bytes, new_files, new_bytes } }; failure (exit 8, stderr): { error: { code: "deploy_failed", deployment, step, cause, fix, file?, line?, evidence, log_tail } }`
- Exit codes: 0, 1, 2, 3, 6, 7, 8, 9

```sh
boxlite-app deploy -m "add deals board"
boxlite-app deploy --dry-run --json
boxlite-app deploy --verbose
```

### `boxlite-app login`

save the App key once so later shells need no BOXLITE_API_KEY: from BOXLITE_API_KEY, or a pipe with --stdin (never an argument)

Usage: `boxlite-app login [options]`

| option | description | default |
|---|---|---|
| `--stdin` | read the key from stdin |  |

- Network: talks to the control plane
- `--json`: `{ app, api_url, key_last4, saved_to }`
- Exit codes: 0, 1, 2, 3, 6

```sh
BOXLITE_API_URL=https://cp.example BOXLITE_API_KEY=bxl_app_… boxlite-app login
```

### `boxlite-app logout`

forget the saved key of this App (--all: every saved key)

Usage: `boxlite-app logout [options]`

| option | description | default |
|---|---|---|
| `--all` | forget every saved key |  |

- Network: local only
- `--json`: `{ removed: boolean }`
- Exit codes: 0, 1

### `boxlite-app whoami`

the key’s App and scope, the environment, the control plane, and whether a newer CLI exists

Usage: `boxlite-app whoami`

- Network: talks to the control plane
- `--json`: `{ app, env, actor, key: { last4, created_at } | null, scope, control_plane, api_url, environments: { name, status, url }[], linked: { link_file, app, matches_key }, cli: { version, latest_version, update_available, update_command } }`
- Exit codes: 0, 1, 2, 6

### `boxlite-app doctor`

run every local and online check and list the problems, worst first, each with a fix

Usage: `boxlite-app doctor`

- Network: talks to the control plane
- `--json`: `{ ok: boolean (no error-severity problems), app, env, cli: { version, latest_version }, problems: { id, severity: "error"|"warn"|"info", title, fix, detail?, evidence? }[], checks: { id, status: "ok"|"problem"|"skipped", detail }[] }`
- Exit codes: 0, 1

```sh
boxlite-app doctor
boxlite-app doctor --json | jq ".problems[0].fix"
```

### `boxlite-app docs`

the agent guide and the CLI reference, offline: docs | docs <topic> | docs reference [command…] | docs all

Usage: `boxlite-app docs [topic...]`

- Network: local only
- `--json`: `no topic: { topics: { topic, title }[] }; topic: { topic, title, markdown }`
- Exit codes: 0, 1, 4

```sh
boxlite-app docs
boxlite-app docs runtime
boxlite-app docs reference app logs
```

### `boxlite-app feedback`

report a platform problem (a bug, a missing capability, docs that reality contradicts) to the BoxLite team

Usage: `boxlite-app feedback <message...> [options]`

| option | description | default |
|---|---|---|
| `--command <cmd>` | the command that misbehaved |  |

- Network: talks to the control plane
- `--json`: `{ id, received_at, next }`
- Exit codes: 0, 1, 2, 6

```sh
boxlite-app feedback --command "boxlite-app deploy" "deploy stayed at box for 10 minutes; app status showed the Box running"
```

### `boxlite-app app status`

environments, URLs and latest deployments

Usage: `boxlite-app app status`

- Network: talks to the control plane
- `--json`: `{ name: string, created_at: string, env: string, url: string (of env), envs: EnvSummary[] }`
- Exit codes: 0, 1, 2, 3, 6

### `boxlite-app app context`

everything about the environment: URLs, services, schema, migrations, volumes, sign-in, variables, deployments, errors, next actions

Usage: `boxlite-app app context [options]`

| option | description | default |
|---|---|---|
| `--format <fmt>` | markdown \| json | `markdown` |

- Network: talks to the control plane
- `--json`: `AgentContext (see shared/src/agent-context.ts)`
- Exit codes: 0, 1, 2, 3, 6

```sh
boxlite-app app context
boxlite-app app context --json | jq .next_actions
```

### `boxlite-app app deployments`

recent deployments of the environment

Usage: `boxlite-app app deployments [options]`

| option | description | default |
|---|---|---|
| `--limit <n>` | how many (default 20) |  |

- Network: talks to the control plane
- `--json`: `Deployment[] (newest first)`
- Exit codes: 0, 1, 2, 3

### `boxlite-app app deployment`

one deployment: steps, error with classified cause; --logs: full timeline with step timestamps and every log line

Usage: `boxlite-app app deployment <n> [options]`

| option | description | default |
|---|---|---|
| `--follow` | follow a running deployment until it finishes (exit 8 if it fails) |  |
| `--logs` | full timeline: steps with timestamps and durations, build and start log, final status |  |
| `-v, --verbose` | with --follow: stream log lines |  |
| `--cancel` | cancel a queued or building deployment |  |

- Network: talks to the control plane
- `--json`: `Deployment & { diagnosis: Diagnosis | null }; --logs: { deployment, steps: { name, status, detail, ms, started_at, finished_at }[], logs: LogLine[], truncated, diagnosis }`
- Exit codes: 0, 1, 2, 3, 4, 8

```sh
boxlite-app app deployment 7 --logs
boxlite-app app deployment 7 --follow
```

### `boxlite-app app rollback`

switch the environment back to the release of deployment N (one of the last 3 on the Box)

Usage: `boxlite-app app rollback <n> [options]`

| option | description | default |
|---|---|---|
| `--with-database` | also restore the database to its state before the first later migration (destructive) |  |
| `-y, --yes` | confirm --with-database |  |

- Network: talks to the control plane
- Destructive: prints what it destroys; needs `--yes` (without it: exit 10 `confirmation_required` in `--json` mode or without a terminal)
- `--json`: `Deployment (kind "rollback")`
- Exit codes: 0, 1, 2, 3, 4, 8, 10

### `boxlite-app app logs`

service, build, schedule and system logs, filtered

Usage: `boxlite-app app logs [options]`

| option | description | default |
|---|---|---|
| `--source <name>` | a service name, or build \| system \| schedule |  |
| `--level <level>` | error (stderr and failures) \| warn (warnings and errors) \| info (everything) |  |
| `--since <when>` | duration back from now (90s, 10m, 2h, 2d) or an ISO timestamp |  |
| `--until <when>` | end of the window, same formats as --since |  |
| `--grep <regex>` | only lines matching this regular expression (case-insensitive) |  |
| `--deployment <n>` | only lines of deployment N |  |
| `--limit <n>` | max lines (default 200) |  |
| `--follow` | stream new lines until Ctrl-C (NDJSON with --json) |  |

- Network: talks to the control plane
- `--json`: `{ id, ts, source, level, line, deployment }[] (oldest first); with --follow one such object per line (NDJSON)`
- Exit codes: 0, 1, 2, 3

```sh
boxlite-app app logs --source web --level error --since 10m
boxlite-app app logs --grep "timeout|ECONN" --since 2h
boxlite-app app logs --deployment 7
boxlite-app app logs --follow --json
```

### `boxlite-app app curl`

request a path of the deployed app with the App key (works for private apps); --as signs in a test user; redirects are shown, not followed

Usage: `boxlite-app app curl <path> [options]`

| option | description | default |
|---|---|---|
| `-X, --request <method>` | HTTP method (default GET, or POST with -d) |  |
| `-d, --data <body>` | request body; @file reads it from a file; JSON bodies get Content-Type: application/json |  |
| `-H, --header <header>` | extra request header "Name: value" (repeatable) |  |
| `--as <email>` | act as this signed-in end user (a 15 minute test session) |  |
| `--role <role>` | with --as: owner (someone who manages the App in the console) or user (default); the app sees it as X-BoxLite-User-Role |  |
| `--fail` | exit 1 (code http_error) when the status is 400 or above |  |
| `--expect <statuses>` | exit 1 (code http_unexpected) unless the status is one of these, e.g. 302 or 200,201 |  |
| `--body` | print only the response body (with --json, the parsed JSON) |  |
| `--raw-headers` | show Set-Cookie values (redacted by default) |  |

- Network: talks to the control plane
- `--json`: `{ url, method, status, ok (2xx or 3xx), redirect: string | null, expected?, as_expected?, ms, timing: { test_session_ms, request_ms }, headers (Set-Cookie values redacted), body_json (a JSON body) | body (text), truncated: boolean, as: { email, role, expires_at } | null }; --body: the body alone`
- Exit codes: 0, 1, 2, 3, 4, 6

```sh
boxlite-app app curl /healthz
boxlite-app app curl /api/items -X POST -d '{"title":"x"}' --as qa@example.com --json
boxlite-app app curl /app --fail
boxlite-app app curl /admin --as owner@example.com --role owner
boxlite-app app curl /.boxlite/auth/login --expect 302
boxlite-app app curl /api/leaderboard --body --json
```

### `boxlite-app app open`

open the app in a browser through a one-time link (works once, expires after 60 s; never hand it to the user): opens the browser on a terminal, else prints it

Usage: `boxlite-app app open [options]`

| option | description | default |
|---|---|---|
| `--print-url` | print the link instead of opening a browser |  |
| `--as <email>` | open it signed in as this test user (a 15-minute test session, like app curl --as): for checking signed-in pages in a browser |  |
| `--role <role>` | with --as: owner or user (default) |  |
| `--path <path>` | where the link lands, e.g. /app/select (default /) |  |

- Network: talks to the control plane
- `--json`: `{ url: string, expires_at: string | null, opened: boolean, as: { email, role } | null }`
- Exit codes: 0, 1, 2, 3

```sh
boxlite-app app open --print-url --as qa@example.com --path /app --json
```

### `boxlite-app app services`

service states, health, restarts

Usage: `boxlite-app app services`

- Network: talks to the control plane
- `--json`: `{ name, state, restarts, last_exit_code, health, pid, memory_bytes }[]`
- Exit codes: 0, 1, 2, 3

### `boxlite-app app restart`

restart one service or all of them

Usage: `boxlite-app app restart [service]`

- Network: talks to the control plane
- `--json`: `{ restarted: string[] }`
- Exit codes: 0, 1, 2, 3, 4

### `boxlite-app app access`

show or set who can reach the app: access | access set private|org|public | access clear (back to boxlite.toml)

Usage: `boxlite-app app access [action] [value] [options]`

| option | description | default |
|---|---|---|
| `-y, --yes` | required to set public |  |

- Network: talks to the control plane
- Destructive: prints what it destroys; needs `--yes` (without it: exit 10 `confirmation_required` in `--json` mode or without a terminal)
- `--json`: `{ access: "private"|"org"|"public", source: "manifest"|"online" }`
- Exit codes: 0, 1, 2, 3, 10

```sh
boxlite-app app access
boxlite-app app access set public --yes
```

### `boxlite-app app pull`

rewrite boxlite.toml from the environment spec (old file kept as boxlite.toml.bak)

Usage: `boxlite-app app pull`

- Network: talks to the control plane
- `--json`: `{ file: "boxlite.toml", version: number, backup: string | null }`
- Exit codes: 0, 1, 2, 3, 4

### `boxlite-app app export`

print the environment spec as JSON

Usage: `boxlite-app app export`

- Network: talks to the control plane
- `--json`: `Spec (contracts §0)`
- Exit codes: 0, 1, 2, 3, 4

### `boxlite-app app clone`

download the source of a deployment into ./<app>/ and link it

Usage: `boxlite-app app clone <app> [options]`

| option | description | default |
|---|---|---|
| `--deployment <n>` | deployment number (default: the deploy whose code is live, else the newest deploy with source) |  |

- Network: talks to the control plane
- `--json`: `{ app: string, env: string, deployment: number, dir: string }`
- Exit codes: 0, 1, 2, 3, 4, 5

### `boxlite-app app env create`

create an environment from another one

Usage: `boxlite-app app env create <name> [options]`

| option | description | default |
|---|---|---|
| `--from <env>` | source environment | `main` |
| `--with-data` | copy the database data too (default: schema only) |  |

- Network: talks to the control plane
- `--json`: `EnvSummary`
- Exit codes: 0, 1, 2, 3

### `boxlite-app app env delete`

delete an environment with its Box, database branch and volumes (destructive)

Usage: `boxlite-app app env delete <name> [options]`

| option | description | default |
|---|---|---|
| `-y, --yes` | confirm |  |

- Network: talks to the control plane
- Destructive: prints what it destroys; needs `--yes` (without it: exit 10 `confirmation_required` in `--json` mode or without a terminal)
- `--json`: `{ deleted: string }`
- Exit codes: 0, 1, 2, 3, 5, 10

### `boxlite-app app schedule list`

schedules with next run and last result

Usage: `boxlite-app app schedule list`

- Network: talks to the control plane
- `--json`: `{ name, cron, target, next_run: string | null, last_run: string | null, last_status: number | null }[]`
- Exit codes: 0, 1, 2, 3

### `boxlite-app app schedule run`

trigger a schedule now (POST to its target, like the scheduler does)

Usage: `boxlite-app app schedule run <name>`

- Network: talks to the control plane
- `--json`: `{ name: string, status: number, ms: number, starting: boolean }`
- Exit codes: 0, 1, 2, 3, 4

### `boxlite-app app sql`

run SQL against the environment database (read-only unless --write); query, --file, or stdin (`-`)

Usage: `boxlite-app app sql [query] [options]`

| option | description | default |
|---|---|---|
| `-f, --file <path>` | read the SQL from a file |  |
| `--write` | allow statements that modify data (DDL only on non-main environments) |  |
| `--explain` | return the query plan instead of rows |  |

- Network: talks to the control plane
- `--json`: `{ columns: string[], rows: unknown[][], row_count: number, elapsed_ms: number, truncated: boolean }`
- Exit codes: 0, 1, 2, 3, 4, 5

```sh
boxlite-app app sql "select count(*) from deals"
boxlite-app app sql --file q.sql --json
cat q.sql | boxlite-app app sql -
```

### `boxlite-app app db sql`

the same as `app sql`: run SQL (read-only unless --write); query, --file, or stdin (`-`)

Usage: `boxlite-app app db sql [query] [options]`

| option | description | default |
|---|---|---|
| `-f, --file <path>` | read the SQL from a file |  |
| `--write` | allow statements that modify data (DDL only on non-main environments) |  |
| `--explain` | return the query plan instead of rows |  |

- Network: talks to the control plane
- `--json`: `{ columns: string[], rows: unknown[][], row_count: number, elapsed_ms: number, truncated: boolean }`
- Exit codes: 0, 1, 2, 3, 4, 5

```sh
boxlite-app app db query "select count(*) from deals"
```

### `boxlite-app app db info`

connection and size summary (no password)

Usage: `boxlite-app app db info`

- Network: talks to the control plane
- `--json`: `{ status: "ready" | "unknown" | "none", host?, database?, user?, branch?, size_bytes? }`
- Exit codes: 0, 1, 2, 3

### `boxlite-app app db schema`

tables and columns; with a table also indexes, constraints and a row estimate

Usage: `boxlite-app app db schema [table]`

- Network: talks to the control plane
- `--json`: `{ tables: { name, columns: { name, type, nullable, default }[] }[] } | { name, columns, indexes, constraints, row_estimate }`
- Exit codes: 0, 1, 2, 3, 4

### `boxlite-app app db rows`

print rows of a table as a table

Usage: `boxlite-app app db rows <table> [options]`

| option | description | default |
|---|---|---|
| `--where <expr>` | SQL filter expression |  |
| `--limit <n>` | max rows | `50` |
| `--offset <n>` | skip rows |  |

- Network: talks to the control plane
- `--json`: `{ columns, rows, row_count, elapsed_ms, truncated, limit, offset }`
- Exit codes: 0, 1, 2, 3, 4

### `boxlite-app app db proxy`

a local Postgres port for psql, ORMs and scripts, authenticated with the App key (read-only unless --write); no password is ever shown

Usage: `boxlite-app app db proxy [options]`

| option | description | default |
|---|---|---|
| `--port <n>` | local port (0 = any free port) | `5432` |
| `--write` | log in as the database owner (DDL is still refused on main) |  |

- Network: talks to the control plane
- `--json`: `NDJSON stream: { event: "listening", app, env, host, port, role: "reader" | "owner", database_url }`
- Exit codes: 0, 1, 2, 3, 4

```sh
boxlite-app app db proxy
boxlite-app app db proxy --port 15432 --write
```

### `boxlite-app app db export`

download the database: one table as CSV, or schema + data as SQL (streamed)

Usage: `boxlite-app app db export [options]`

| option | description | default |
|---|---|---|
| `--table <name>` | one table (required for CSV) |  |
| `--format <fmt>` | csv \| sql (default: csv with --table, else sql) |  |
| `-o, --output <file>` | write to a file instead of stdout |  |

- Network: talks to the control plane
- `--json`: `{ file, format: "csv" | "sql", table: string | null, bytes } (needs -o)`
- Exit codes: 0, 1, 2, 3, 4

```sh
boxlite-app app db export --table deals -o deals.csv
boxlite-app app db export --format sql -o dump.sql
```

### `boxlite-app app db import`

append the rows of a CSV file (header = column names) to a table, all or nothing; snapshot first

Usage: `boxlite-app app db import <file> [options]`

| option | description | default |
|---|---|---|
| `--table <name>` | the table the rows go into |  |
| `-y, --yes` | confirm (always required on main) |  |

- Network: talks to the control plane
- Destructive: prints what it destroys; needs `--yes` (without it: exit 10 `confirmation_required` in `--json` mode or without a terminal)
- `--json`: `{ table, rows, columns: string[], snapshot }`
- Exit codes: 0, 1, 2, 3, 4, 10

```sh
boxlite-app app db import deals.csv --table deals --yes
```

### `boxlite-app app db migrations`

applied / pending / changed per migration file (local files vs the database when run in the project)

Usage: `boxlite-app app db migrations`

- Network: talks to the control plane
- `--json`: `{ file, status: "applied" | "pending" | "changed" | "missing_locally", deployment, applied_at }[]`
- Exit codes: 0, 1, 2, 3

### `boxlite-app app db diff`

local migrations vs what the database applied; exit 7 if an applied file was edited

Usage: `boxlite-app app db diff`

- Network: talks to the control plane
- `--json`: `{ file, status: "applied" | "pending" | "changed" | "missing_locally", deployment, applied_at }[]`
- Exit codes: 0, 1, 2, 3, 7

### `boxlite-app app db migration new`

create the next NNNN_<name>.sql file locally

Usage: `boxlite-app app db migration new <name>`

- Network: local only
- `--json`: `{ file: string, sha256: string }`
- Exit codes: 0, 1

### `boxlite-app app db snapshot`

take a database snapshot (a named, restorable point in time)

Usage: `boxlite-app app db snapshot [options]`

| option | description | default |
|---|---|---|
| `-m, --message <text>` | what this snapshot is for |  |

- Network: talks to the control plane
- `--json`: `{ id, message, ts, created_at, by }`
- Exit codes: 0, 1, 2, 3, 4

### `boxlite-app app db snapshots`

list snapshots

Usage: `boxlite-app app db snapshots`

- Network: talks to the control plane
- `--json`: `{ id, message, ts, created_at, by }[]`
- Exit codes: 0, 1, 2, 3

### `boxlite-app app db restore`

restore the database to a point in time or a snapshot (destructive)

Usage: `boxlite-app app db restore [options]`

| option | description | default |
|---|---|---|
| `--to <iso8601>` | point in time |  |
| `--snapshot <id>` | snapshot id |  |
| `-y, --yes` | confirm |  |

- Network: talks to the control plane
- Destructive: prints what it destroys; needs `--yes` (without it: exit 10 `confirmation_required` in `--json` mode or without a terminal)
- `--json`: `{ restored_to: string, preserved_as: string }`
- Exit codes: 0, 1, 2, 3, 4, 10

### `boxlite-app app db reset`

drop every table of a non-main environment (snapshot first); migrations re-run on the next apply (destructive)

Usage: `boxlite-app app db reset [options]`

| option | description | default |
|---|---|---|
| `-y, --yes` | confirm |  |

- Network: talks to the control plane
- Destructive: prints what it destroys; needs `--yes` (without it: exit 10 `confirmation_required` in `--json` mode or without a terminal)
- `--json`: `{ reset: string, dropped_tables: string[], snapshot: string }`
- Exit codes: 0, 1, 2, 3, 4, 5, 10

### `boxlite-app app vars list`

live variables of the environment with their source; secrets masked; unpublished local edits flagged

Usage: `boxlite-app app vars list`

- Network: talks to the control plane
- `--json`: `{ name, value: string | null, secret: boolean, source: string, resolved: boolean, local_change: "added" | "changed" | "removed" | null }[]`
- Exit codes: 0, 1, 2, 3

### `boxlite-app app vars set`

set KEY=VALUE pairs in boxlite.toml

Usage: `boxlite-app app vars set <pairs...>`

- Network: local only
- `--json`: `{ file, env, set: Record<string, string>, comments_dropped: boolean }`
- Exit codes: 0, 1

### `boxlite-app app vars unset`

remove variables from boxlite.toml

Usage: `boxlite-app app vars unset <names...>`

- Network: local only
- `--json`: `{ file, env, unset: string[], comments_dropped: boolean }`
- Exit codes: 0, 1

### `boxlite-app app vars import`

import KEY=VALUE lines from a dotenv-style file into boxlite.toml

Usage: `boxlite-app app vars import <file> [options]`

| option | description | default |
|---|---|---|
| `--dry-run` | print what would change without writing |  |

- Network: local only
- `--json`: `{ file, env, set | would_set: Record<string, string>, comments_dropped?: boolean }`
- Exit codes: 0, 1

### `boxlite-app app secrets set`

store an App secret from stdin, e.g. printf %s "$KEY" | boxlite-app app secrets set stripe (referenced as app/stripe)

Usage: `boxlite-app app secrets set <name>`

- Network: talks to the control plane
- `--json`: `{ name: "app/<name>", updated_at, created: boolean }`
- Exit codes: 0, 1, 2, 3, 4

```sh
printf %s "$STRIPE_SECRET_KEY" | boxlite-app app secrets set stripe
```

### `boxlite-app app secrets list`

secret names usable as references: the App's own (app/…) and its organization's (org/…); never values

Usage: `boxlite-app app secrets list`

- Network: talks to the control plane
- `--json`: `{ app: { name, updated_at }[], org: { name, updated_at }[] }`
- Exit codes: 0, 1, 2, 3

### `boxlite-app app secrets rm`

delete an App secret

Usage: `boxlite-app app secrets rm <name> [options]`

| option | description | default |
|---|---|---|
| `-y, --yes` | skip the confirmation |  |

- Network: talks to the control plane
- `--json`: `{ deleted: "app/<name>" }`
- Exit codes: 0, 1, 2, 3, 4

### `boxlite-app app secrets ref`

map NAME to a secret in boxlite.toml, e.g. STRIPE_SECRET_KEY app/stripe (or org/openai)

Usage: `boxlite-app app secrets ref <name> <ref>`

- Network: local only
- `--json`: `{ file, env, secrets: Record<string, string>, comments_dropped: boolean }`
- Exit codes: 0, 1

### `boxlite-app app volume ls`

list volumes, or the files under <volume>[:<path>]

Usage: `boxlite-app app volume ls [target]`

- Network: talks to the control plane
- `--json`: `no target: { name, mount, mode }[]; directory: { volume, path, type: "dir", entries: { name, type, size, mode, modified_at }[] }; file: { volume, path, type: "file", size }`
- Exit codes: 0, 1, 2, 3, 4

```sh
boxlite-app app volume ls
boxlite-app app volume ls uploads:/avatars
```

### `boxlite-app app volume cp`

copy one file between this machine and a volume: cp <local> <volume>:<path> | cp <volume>:<path> <local>

Usage: `boxlite-app app volume cp <src> <dst> [options]`

| option | description | default |
|---|---|---|
| `--force` | overwrite an existing file at the destination |  |

- Network: talks to the control plane
- `--json`: `{ direction: "upload" | "download", volume, path, local, bytes, replaced? }`
- Exit codes: 0, 1, 2, 3, 4

```sh
boxlite-app app volume cp ./seed/logo.png uploads:/logo.png
boxlite-app app volume cp uploads:/exports/report.csv ./
```

### `boxlite-app app volume rm`

delete a file on a volume, or a folder with --recursive: rm <volume>:<path>

Usage: `boxlite-app app volume rm <target> [options]`

| option | description | default |
|---|---|---|
| `-r, --recursive` | delete a folder and everything in it |  |
| `-y, --yes` | skip the confirmation |  |

- Network: talks to the control plane
- `--json`: `{ volume, path, removed: "file" | "directory" }`
- Exit codes: 0, 1, 2, 3, 4

```sh
boxlite-app app volume rm uploads:/test-cover.png --yes
boxlite-app app volume rm uploads:/tmp --recursive --yes
```

### `boxlite-app app dev`

fetch the environment's variables into .env.local and run every service locally against the cloud database (DATABASE_URL is a local db proxy, no password)

Usage: `boxlite-app app dev [options]`

| option | description | default |
|---|---|---|
| `--as <email>` | act as this end user (sets BOXLITE_DEV_USER) |  |
| `--build` | run runtime.build first |  |
| `--db-port <n>` | local port of the database proxy behind DATABASE_URL (default: any free port) |  |

- Network: talks to the control plane
- `--json`: `NDJSON stream: { source: string, line: string } per output line`
- Exit codes: 0, 1, 2, 3, 7

### `boxlite-app app auth status`

providers, protected paths, login URL and user count

Usage: `boxlite-app app auth status`

- Network: talks to the control plane
- `--json`: `{ enabled, providers: { name, status: "ready" | "not_configured" }[], protect: string[], login_url, users }`
- Exit codes: 0, 1, 2, 3

### `boxlite-app app auth redirect-uris`

OAuth callback URLs the platform uses

Usage: `boxlite-app app auth redirect-uris`

- Network: talks to the control plane
- `--json`: `{ provider, redirect_uri, status }[]`
- Exit codes: 0, 1, 2, 3

### `boxlite-app app auth users`

list users; or: users signout|block|unblock <email>, users purge-test (remove the test users --as made), users export (CSV)

Usage: `boxlite-app app auth users [action] [email] [options]`

| option | description | default |
|---|---|---|
| `--search <text>` | filter by email or name |  |
| `-y, --yes` | skip the confirmation (purge-test) |  |

- Network: talks to the control plane
- `--json`: `AuthUser[] ({ id, email, name, provider, first_seen, last_seen, blocked, active_sessions })`
- Exit codes: 0, 1, 2, 3, 4

### `boxlite-app app auth test-session`

sign in a test user for 15 minutes and print its cookie (for curl checks)

Usage: `boxlite-app app auth test-session [options]`

| option | description | default |
|---|---|---|
| `--email <email>` | test user email, e.g. qa@example.com |  |
| `--role <role>` | owner (manages the App in the console) or user (default); sent as X-BoxLite-User-Role |  |

- Network: talks to the control plane
- `--json`: `{ cookie, cookie_name, expires_in: "15m", expires_at, role: "owner" | "user", user }`
- Exit codes: 0, 1, 2, 3
