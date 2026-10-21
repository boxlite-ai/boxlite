---
name: boxlite-app
description: Build a complete web app from the user's one-line request and run it on BoxLite Cloud as a BoxLite App — database, file storage, login, deploys, rollback. Use when the user hands you a BoxLite App prompt (it contains BOXLITE_API_KEY=bxl_app_… and an App name) or asks to build/deploy/update an app on BoxLite.
---

# Build an app on BoxLite Cloud

The user created an **App** in the BoxLite console and pasted you its prompt. That prompt gave you two values; export them in every shell you use and never print the key back:

```sh
export BOXLITE_API_URL=…   # from the prompt
export BOXLITE_API_KEY=…   # bxl_app_…, scoped to this one App
```

The key can only touch this App. You do not need any other BoxLite credential, Docker, Git, or a cloud account. You talk to the platform only through the `boxlite-app` CLI.

Your job is finished when the app the user asked for is **live at its URL and you have verified it yourself**. The user should not need to do anything between pasting the prompt and opening the link.

## 0. Install and orient (once per session)

```sh
npm install -g "$BOXLITE_API_URL/cli/boxlite-app.tgz"   # or: npx -y "$BOXLITE_API_URL/cli/boxlite-app.tgz" …
boxlite-app whoami            # the App this key belongs to, its environments, and whether the CLI is current
boxlite-app app context       # services, schema, migrations, variables, recent deploys and errors, and what to do next
```

If `context` shows a live deployment, this is an **update**: run `boxlite-app app clone <app>` into an empty directory (or work in the user's existing project directory if it has `.boxlite/link.json`), then go to step 3.

Everything the CLI can do is documented offline: `boxlite-app docs` lists the topics of this guide, and `boxlite-app docs reference [command…]` prints every command with its flags, `--json` shape and exit codes (the same text as [`docs/cli-reference.md`](../docs/cli-reference.md) in the platform repo). With `--json`, a successful command prints exactly one JSON document on stdout; a failed one prints `{"error": {"code", "message", "next", …}}` on stderr. `next` is always a command to run or a file to edit.

## 1. Decide what the app needs

Read the user's sentence and decide, before writing code:

| If the app… | Declare | Notes |
|---|---|---|
| stores anything that must survive a restart (records, accounts, settings) | `[database]` + `migrations/` | Postgres. Never install a database inside the app. |
| stores user-uploaded files or generated files | `[[volume]]` | A directory mounted into the app. Never keep uploads on local disk. |
| has "my", "only me", per-user data, an admin, or anything private | keep `[auth]` (it is on by default) | Platform Google/GitHub login, zero setup. Remove `[auth]` only for a fully anonymous site. |
| runs something on a timer ("every morning", "daily digest") | `[[schedule]]` | Calls a path on your web service; it wakes the app. |
| is only a frontend (no server logic, no database) | one `[[service]]` with `static = "dist/"` | No server needed; the platform serves the files. |
| needs a third-party API key the user mentioned | `[secrets]` reference | Ask the user to add it in the console; never put secret values in files. |

Pick the stack you are best at that fits in one directory. Defaults that work well here: **Node 22 + a small server (Express/Hono/Fastify) serving a built frontend**, or plain server-rendered pages. Python 3.12 works too (`image = "python"`).

## 2. Initialise the project

```sh
mkdir -p <app> && cd <app>
boxlite-app init          # writes boxlite.toml + .boxlite/link.json; never overwrites
```

Edit `boxlite.toml`. A complete example:

```toml
[app]
name = "crm"

[runtime]
image = "node"                    # node | python | base
size  = "small"                   # nano | small | medium | large
build = ["npm ci", "npm run build"]   # runs in the cloud on every deploy

[[service]]
name    = "web"
command = "node server.js"
port    = 3000                    # the platform sets PORT; this is only a hint
health  = "/healthz"              # must return 2xx when ready

[database]
migrations = "migrations/"        # 0001_init.sql, 0002_….sql — the only way to change tables

[[volume]]
name  = "uploads"
mount = "/data/uploads"

[auth]                            # on by default; delete it for a fully anonymous site
providers = ["github", "google"]
protect   = ["/app/*"]            # optional: paths that require login

[[schedule]]
name   = "daily-summary"
cron   = "0 9 * * *"              # UTC
target = "web:/jobs/daily-summary"

[variables]
LOG_LEVEL = "info"
```

## 3. Runtime rules your code must follow

These are hard requirements. Most failed deploys break one of them.

1. **Listen on `process.env.PORT` on `0.0.0.0`.** Never hardcode the port, never bind `127.0.0.1`/`localhost`.
2. **The app owns its origin.** Each environment is served at the root of its own origin (`BOXLITE_APP_URL`, e.g. `https://<port>-d-<hex>.proxy.dev.boxlite.ai/`), so ordinary root-absolute links (`/api/items`, `/assets/app.js`) and any framework's defaults work. Never hardcode or guess that URL: build absolute links (emails, third-party callbacks) from `process.env.BOXLITE_APP_URL`, and read it for your own checks from `boxlite-app app context --json | jq -r .urls.app`.
3. **Health endpoint** at the `health` path returning 2xx quickly (no DB call needed). Traffic switches only after it passes.
4. **Exit on SIGTERM** within 10 s.
5. **Logs to stdout/stderr.** That is all `boxlite-app app logs` can see.
6. **Persistent data only in the database or a volume path.** Local disk is wiped on every deploy and rebuild.
7. **Database:** connect with `process.env.DATABASE_URL` (SSL is in the URL; with `pg` use `new Pool({ connectionString: process.env.DATABASE_URL })`). Change tables only by adding a new numbered file in `migrations/`; never edit an applied migration. On `main`, `boxlite-app app sql` refuses DDL.
8. **Login** (`[auth]`, on by default): link to `/.boxlite/auth/login?next=/app` and `/.boxlite/auth/logout?next=/` (`next` is a path inside the app). The platform handles OAuth: the browser briefly leaves your origin for the provider and comes back to `next` signed in. Never implement callbacks or sessions yourself, and never set cookies whose name starts with `bxl_` or that carry a `Domain` attribute (the platform drops them).
   - Signed-in requests carry `X-BoxLite-User-Id` (uuid), `X-BoxLite-User-Email`, `X-BoxLite-User-Name` (URI-encoded: `decodeURIComponent`) and `X-BoxLite-User-Provider`. No header = anonymous. The platform strips these from what browsers send, so trust them. Scope every per-user query by the user id.
   - `[auth].protect` paths need login: browsers are redirected to the login page, API calls get 401 JSON. For other pages decide yourself, and use `/.boxlite/auth/me` (JSON or 401) from the frontend.
   - Optional: `X-BoxLite-Identity` is an RS256 JWT (5 min) with the same user, for when you forward identity to another service. Verify its signature against `${BOXLITE_APP_URL}/.boxlite/auth/jwks.json` **and check that `aud` equals `BOXLITE_APP_URL` exactly**. Every app's tokens are signed with the same key, so a token with another `aud` belongs to another app and must be refused.
   - With `[database]`, users also appear in `boxlite.users(id, email, name, provider, created_at, last_login_at)`. For row-level security run `SET LOCAL boxlite.user_id = '<id>'` in the transaction and write policies with `boxlite.current_user_id()`.
9. **Frontend build output** (`dist/`, `build/`) is produced in the cloud by `[runtime].build`; do not commit or rely on uploading it. Commit a lockfile (`package-lock.json`, `uv.lock`) so the cloud build matches yours.
10. Environment variables available at runtime: `PORT`, `BOXLITE_APP_URL`, `BOXLITE_ENV`, `DATABASE_URL` (if `[database]`), everything in `[variables]` and `[secrets]`. Volumes are plain directories at their `mount` path.

## 4. The loop

```sh
boxlite-app check             # local, instant: fix every error it lists (file:line, rule)
boxlite-app plan              # what will change online
boxlite-app apply --yes       # create database / volumes / login now (no code upload)
boxlite-app app dev           # run locally against the real cloud database; writes .env.local
boxlite-app deploy -m "what changed"   # upload → cloud build → migrate → start → health → live
```

- Run `check` after every edit to `boxlite.toml` or `migrations/`. Its JSON form is `boxlite-app check --json`.
- New table or column: `boxlite-app app db migration new <name>` creates the next numbered file; `boxlite-app app db diff` shows which files are applied, pending or (never do this) edited after applying.
- `boxlite-app deploy --dry-run` runs check and plan and sizes the upload without deploying.
- `deploy` streams progress (`--verbose` adds the build output) and returns only when the deployment is live or failed. Exit codes: 0 ok · 2 bad key · 3 app/env missing · 4 not found · 5 outside key scope · 6 platform unavailable (wait 30 s, rerun, max 3 times) · 7 manifest invalid (fix and retry) · 8 deploy failed · 9 someone changed the app online (`boxlite-app app pull`, review, redeploy) · 10 a destructive command needs `--yes` (ask the user first).
- A failed deploy prints the failed step, the last 50 log lines, a cause (`missing_lockfile`, `port_binding`, `health_404`, `crash_on_start`, `migration_sql_error` with file and line, `build_timeout`, …) and the fix. Apply the fix and deploy again. The previous version keeps serving meanwhile. Use `boxlite-app app rollback <N>` only if the user asks or the live app is broken and you cannot fix it quickly.
- Stuck or unsure what is wrong: `boxlite-app doctor` checks the key, the project, the last deployment, crash-looping services, the database, pending migrations, sign-in and reachability, and lists the problems worst first, each with its fix.
- Debug a running app: `boxlite-app app logs --source web --level error --since 10m` (also `--grep <regex>`, `--deployment <N>`, `--follow`), `boxlite-app app services`, `boxlite-app app deployment <N> --logs` (timeline with every log line).
- Files on a volume: `boxlite-app app volume ls uploads:/`, `boxlite-app app volume cp ./seed.png uploads:/seed.png`. Live variables: `boxlite-app app vars list` (secrets masked).

## 5. Verify before you report

Never report success from the deploy exit code alone. Check what the user asked for:

```sh
boxlite-app app curl /healthz --fail                       # private apps too: the CLI authenticates with the App key
boxlite-app app curl / --json | jq -r .body | head -c 400  # the real page, not an error page
boxlite-app app curl /api/items -X POST -d '{"title":"x"}' --as qa@example.com --json   # as a signed-in user
boxlite-app app sql "select count(*) from <table>" --json  # data actually written
```

- `app curl` only ever talks to this environment's own URL, shows redirects instead of following them, and prints status, headers and body (`--json`: `{status, headers, body, body_json?}`). Do not paste the App key into curl yourself.
- Exercise every feature the user named, through HTTP, the way a browser would (create, list, edit, delete; upload then fetch the file; a protected page returns the login redirect when anonymous).
- Login-only flows: `--as qa@example.com` signs in a 15-minute test user, so your service gets that user's `X-BoxLite-User-*` headers. Without it, a protected page must answer 302 (HTML) or 401 (API).
- If a check fails, fix and redeploy. Report only when all pass.

## 6. Report to the user

One short message:

- The URL. For a private app, `boxlite-app app open --print-url` gives a one-time sign-in link you can hand over; never put the App key in a link.
- What you built, in their words, and what you verified (list).
- Anything only they can decide, phrased as a question: making the app public (`boxlite-app app access set public --yes` — only when they say "public"), adding a third-party key, a custom domain.

Do not mention internal steps, retries, or platform terms (Spec, Release, Box, tunnel).

## Rules

- Never print, log, commit, or echo `BOXLITE_API_KEY`, `DATABASE_URL`, or any secret. Never pass them as command-line arguments. (The CLI masks them in its own output, but your shell commands are yours.)
- Never change the access level to `public` unless the user said so.
- Never delete an environment, database, or volume unless the user asked.
- Destructive commands (`app env delete`, `app db restore`, `app db reset`, `app rollback --with-database`, `app access set public`) refuse without `--yes` and print exactly what they would destroy. Show that list to the user and rerun with `--yes` only after they agree.
- Stay inside this App; do not try other BoxLite APIs.
