---
name: boxlite-app
description: Build a complete web app from the user's one-line request and run it on BoxLite Cloud as a BoxLite App — database, file storage, login, deploys, rollback. Use when the user hands you a BoxLite App prompt (it contains BOXLITE_API_KEY=bxl_app_… and an App name) or asks to build/deploy/update an app on BoxLite.
---

# Build an app on BoxLite Cloud

The user created an **App** in the BoxLite console and pasted you its prompt. That prompt gave you two values, `BOXLITE_API_URL` and `BOXLITE_API_KEY` (`bxl_app_…`, scoped to this one App). Hand them to the CLI once with `boxlite-app login`, right after installing it (§0): that is the only command the key ever appears in. Never print it back or put it in a command, file or variable afterwards.

The key can only touch this App. You do not need any other BoxLite credential, Docker, Git, or a cloud account. You talk to the platform only through the `boxlite-app` CLI.

Your job is finished when the app the user asked for is **live at its URL and you have verified it yourself**. The user should not need to do anything between pasting the prompt and opening the link.

## 0. Install and orient (once per session)

```sh
npm install -g "<BOXLITE_API_URL>/cli/boxlite-app.tgz"
BOXLITE_API_URL=<url> BOXLITE_API_KEY=<key> boxlite-app login   # once: saves the key (readable by you only); later shells need neither
boxlite-app whoami            # the App this key belongs to, its environments, sign-in that works, and whether the CLI is current
boxlite-app app context       # services, schema, migrations, variables, recent deploys and errors, and what to do next
```

A `BOXLITE_API_KEY` that your shell profile sets to a BoxLite platform key (`blk_…`, for the BoxLite SDKs) is not an App key: the App CLI ignores it and uses the App key you saved with `login`.

If `context` shows a live deployment, this is an **update**: run `boxlite-app app clone <app>` into an empty directory (it downloads the code that is live; if its `next:` line says to, run `boxlite-app app pull` to pick up changes made online since), or work in the user's existing project directory if it has `.boxlite/link.json`. Then go to step 3.

Everything the CLI can do is documented offline: `boxlite-app docs` lists the topics of this guide, and `boxlite-app docs reference [command…]` prints every command with its flags, `--json` shape and exit codes. With `--json`, a successful command prints exactly one JSON document on stdout; a failed one prints `{"error": {"code", "message", "next", …}}` on stderr. `next` is always a command to run or a file to edit.

## 1. Decide what the app needs

Read the user's sentence and decide, before writing code:

| If the app… | Declare | Notes |
|---|---|---|
| stores anything that must survive a restart (records, accounts, settings) | `[database]` + `migrations/` | Postgres. Never install a database inside the app. |
| stores user-uploaded files or generated files | `[[volume]]` | A directory mounted into the app. Never keep uploads on local disk. |
| has "my", "only me", per-user data, an admin, or anything private | keep `[auth]` (it is on by default) | Platform login with the providers `boxlite-app whoami` lists as working (zero setup). Remove `[auth]` only for a fully anonymous site. Sign-in does not let other people in: access is `private` by default (`org` behaves the same), so only the owner (console **Open app**) and you (the App key) get through, signed in or not. Others reach the app only once access is `public`: set it when their request says people who are not signed in may open it, otherwise ask (§6). |
| runs something on a timer ("every morning", "daily digest") | `[[schedule]]` | Sends `POST <path>` (header `X-BoxLite-Schedule: <name>`) to your web service, so the handler must accept POST; it wakes the app. |
| is only a frontend (no server logic, no database) | one `[[service]]` with `static = "dist/"` | No server needed; the platform serves the files. |
| receives webhooks (Stripe, GitHub, …) | `public_paths = ["/webhooks/*"]` at the top of `boxlite.toml` | The app stays private; only those paths are open. Check the provider's signature in the handler; never open `/` or `/*` this way (that is `access = "public"`, which needs the user's say-so). |
| needs a third-party API key the user mentioned | an App secret plus a `[secrets]` reference | If the user gave you the value: `printf %s "$VALUE" \| boxlite-app app secrets set stripe` (stdin only), then `boxlite-app app secrets ref STRIPE_SECRET_KEY app/stripe`. Otherwise ask the user for it, and say why. An existing org secret is referenced as `org/<name>`. Never put a secret value in a file, a variable or a command argument. |

Who may open the app and what needs signing in are two separate settings; settle both now, not after the deploy:

- **Access** (`access` in `boxlite.toml`): `private` (default: only the owner and you), `org`, or `public` (anyone with the URL). Signing in never gets anyone past a private app.
- **Sign-in** (`[auth]`, `[auth].protect`): which pages or actions need an account, once someone can open the app.

If the request means other people will use it (players, customers, a team) and does not say who, ask the user in your first reply which access they want, together with anything else you need from them, so the first deploy already has it. Never set `public` without their say-so.

Pick the stack you are best at that fits in one directory. Defaults that work well here: **Node 22 + a small server (Express/Hono/Fastify) serving a built frontend**, or plain server-rendered pages. Python 3.12 works too (`image = "python"`).

## 2. Initialise the project

```sh
mkdir -p <app> && cd <app>
boxlite-app init --app <app>   # <app> is the prompt's "App:" line; writes boxlite.toml (only if missing) + .boxlite/link.json; adds its lines to an existing .gitignore and keeps a BoxLite block in AGENTS.md
```

Edit `boxlite.toml`. A complete example:

```toml
public_paths = ["/webhooks/*"]    # optional, before any [table]: paths anyone may reach even when the app is private (a payment provider's or GitHub's webhook). Verify the provider's signature there.

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

[auth]                            # on by default; delete it for a fully anonymous site. Sign-in only: who may reach the app at all is the access level (private by default)
providers = ["github"]          # only providers `boxlite-app whoami` lists as working here
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
2. **The app owns its origin.** Each environment is served at the root of its own origin (`BOXLITE_APP_URL`, e.g. `https://<port>-d-<hex>.proxy.dev.boxlite.ai`, no trailing slash), so ordinary root-absolute links (`/api/items`, `/assets/app.js`) and any framework's defaults work. Never hardcode or guess that URL: build absolute links (emails, third-party callbacks) from `process.env.BOXLITE_APP_URL`, and read it for your own checks from `boxlite-app app context --json | jq -r .urls.app`.
3. **Health endpoint** at the `health` path returning 2xx quickly (no DB call needed). Traffic switches only after it passes.
4. **Exit on SIGTERM** within 10 s.
5. **Logs to stdout/stderr.** That is all `boxlite-app app logs` can see.
6. **Persistent data only in the database or a volume path.** Local disk is wiped on every deploy and rebuild.
7. **Database:** connect with `process.env.DATABASE_URL` (SSL is in the URL; with `pg` use `new Pool({ connectionString: process.env.DATABASE_URL })`). Change tables only by adding a new numbered file in `migrations/`; never edit an applied migration. `boxlite-app app sql` runs read-only unless you pass `--write`, and on `main` it refuses DDL even then.
8. **Login** (`[auth]`, on by default): link to `/.boxlite/auth/login?next=/app` and `/.boxlite/auth/logout?next=/` (`next` is a path inside the app). The platform handles OAuth: the browser briefly leaves your origin for the provider and comes back to `next` signed in. Never implement callbacks or sessions yourself, and never set cookies whose name starts with `bxl_` or that carry a `Domain` attribute (the platform drops them).
   - Providers: list only those `boxlite-app whoami` shows under "Sign-in that works here" (`init` writes exactly those), and build the login page with only those buttons. Any other provider (`google`, `microsoft`, `apple`, `x`, `facebook`) works once the user adds their own OAuth app for it in the console (Auth › Sign-in methods); if the user wants one, say so instead of listing it. X never shares an email address and Apple or Facebook users may withhold it, so key users by id, never by email.
   - `email` (a 6-digit code mailed to the visitor, no OAuth app) sends through the App's own SMTP account. Use it when the user wants email login or has no GitHub/Google users. Ask the user for the account (host, port, username, password, from address), then `printf %s "$SMTP_PASSWORD" | boxlite-app app auth email set --host <host> --port 587 --username <user> --from "<App> <no-reply@domain>" --password-stdin`, check it with `boxlite-app app auth email test --to <their address>`, and add `"email"` to `providers`. The login page then shows the address form itself; `--as` test sessions work as for any provider.
   - Signed-in requests carry `X-BoxLite-User-Id` (uuid), `X-BoxLite-User-Email` (URI-encoded when it is not plain ASCII), `X-BoxLite-User-Name` (always URI-encoded) and `X-BoxLite-User-Provider`; read the email and name with `decodeURIComponent`. No header = anonymous. The platform strips these from what browsers send, so trust them. Scope every per-user query by the user id.
   - `X-BoxLite-User-Role` is `owner` when the visitor manages this App in the BoxLite console (the user who asked you for the app, and their teammates), else `user`; `/.boxlite/auth/me` returns it as `role`. Gate an admin or back-office area on it: never ask the user for their account name, never hardcode an email or id. Check both sides with `boxlite-app app curl /admin --as owner@example.com --role owner` and `--as someone@example.com`.
   - `[auth].protect` paths need login: a `GET` that accepts `text/html` (a browser) is redirected (302) to `/.boxlite/auth/login`, everything else gets 401 JSON. For other pages decide yourself, and use `/.boxlite/auth/me` (JSON or 401) from the frontend.
   - Optional: `X-BoxLite-Identity` is an RS256 JWT (5 min) with the same user, for when you forward identity to another service. Verify its signature against `${BOXLITE_APP_URL}/.boxlite/auth/jwks.json` **and check that `aud` equals `BOXLITE_APP_URL` exactly**. Every app's tokens are signed with the same key, so a token with another `aud` belongs to another app and must be refused.
   - With `[database]`, users also appear in `boxlite.users(id, email, name, provider, created_at, last_login_at)`. For row-level security run `SET LOCAL boxlite.user_id = '<id>'` in the transaction and write policies with `boxlite.current_user_id()`.
9. **Frontend build output** (`dist/`, `build/`) is produced in the cloud by `[runtime].build`; do not commit or rely on uploading it. Commit a lockfile (`package-lock.json`, `uv.lock`) so the cloud build matches yours.
10. Environment variables available at runtime: `PORT`, `BOXLITE_APP_URL`, `BOXLITE_APP` (the App name), `BOXLITE_ENV`, `DATABASE_URL` (if `[database]`), everything in `[variables]` and `[secrets]`. Those platform names (`DATABASE_URL`, `PORT`, anything starting with `BOXLITE_`) cannot be `[variables]` or `[secrets]` names (`check` rule `reserved_variable`). Volumes are plain directories at their `mount` path.

## 4. The loop

```sh
boxlite-app check             # local, instant: fix every error it lists (file:line, rule)
boxlite-app plan              # what will change online
boxlite-app apply --yes       # create database / volumes / login now (no code upload)
boxlite-app app dev --env qa  # run locally against a cloud database (qa's, so experiments stay out of main); writes .env.local (DATABASE_URL = a local proxy, no password)
boxlite-app deploy -m "what changed"   # upload → cloud build → migrate → start → health → live
```

- Run `check` after every edit to `boxlite.toml` or `migrations/`. Its JSON form is `boxlite-app check --json`.
- New table or column: `boxlite-app app db migration new <name>` creates the next numbered file; `boxlite-app app db diff` shows which files are applied, pending or (never do this) edited after applying.
- Database tools that need a real Postgres connection (psql, an ORM's studio, a seed script): `boxlite-app app db proxy` opens `127.0.0.1:5432` (`--port <n>` if that is taken) and prints the DATABASE_URL to use; it runs until Ctrl-C, so start it in the background. It is read-only; `--write` logs in as the owner (on `main` schema changes are still refused: use a migration). Any user name works and there is no password: the CLI authenticates with the App key. `app dev` starts the same proxy as the owner for the app it runs.
- Bulk data: `boxlite-app app db export --table <t> -o t.csv` (one table as CSV) or `boxlite-app app db export --format sql -o dump.sql` (schema and data); `boxlite-app app db import rows.csv --table <t> --yes` appends a CSV whose first line names the columns, all rows or none, with a snapshot taken first. Importing changes the user's data: on `main` ask first.
- `boxlite-app deploy --dry-run` runs check and plan and sizes the upload without deploying.
- `deploy` streams progress (`--verbose` adds the build output) and returns only when the deployment is live or failed.
- Exit codes (every command; the error's `code` says which case it is):
  - 0 ok.
  - 1 anything else: a usage error, `sql_error`, `conflict` (for example five deployments already queued, or a name that already exists), `http_error` from `app curl --fail`. Do what `next` says.
  - 2 bad or missing key · 3 App or environment missing · 4 not found.
  - 5 `forbidden` (outside the key's scope, or DDL on main: use a migration), or `write_requires_flag`: the SQL changes data and nothing ran; rerun it with `--write` if you meant to write.
  - 6 `unavailable` or `rate_limited`: wait 30 s and rerun, at most 3 times.
  - 7 manifest invalid: fix every error listed, then rerun · 8 deploy failed (see below).
  - 9 `stale_base`: someone changed the app online (console, another agent) since your boxlite.toml was synced. Run `boxlite-app app pull` (your file is kept as boxlite.toml.bak), review `diff boxlite.toml.bak boxlite.toml`, re-apply your own edits, then deploy again. Rerunning `plan` alone exits 9 again, and `--force` overwrites the user's online changes: never use it unless the user asks you to discard them.
  - 10 `confirmation_required`: the command asks first and you gave no `--yes` (agents have no terminal). For a destructive command, show the user what it destroys and rerun with `--yes` only after they agree; for `apply`, just rerun with `--yes`.
- A failed deploy prints the failed step, the last 50 log lines, a cause (`missing_lockfile`, `port_binding`, `health_404`, `crash_on_start`, `missing_variable`, `migration_sql_error` with file and line, `build_timeout`, …) and the fix, whose commands run as written. Apply the fix and deploy again. The previous version keeps serving meanwhile. Use `boxlite-app app rollback <N>` only if the user asks or the live app is broken and you cannot fix it quickly.
- If the platform is at fault (a command misbehaves, this guide contradicts what happens, or a capability you need is missing), report it once with `boxlite-app feedback "<what happened, what you expected>" --command "<the command>"`, then carry on with a workaround. Never report bugs in the app's own code.
- An `info` next action that is right as it is (a public site the user asked for, a variable that only looks like a credential): `boxlite-app app ack <id> "<why>"` keeps it out of next_actions for the next session; it comes back if it changes. Warnings and errors cannot be acknowledged: fix them.
- Stuck or unsure what is wrong: `boxlite-app doctor` checks the key, the project, the last deployment, crash-looping services, the database, pending migrations, sign-in and reachability, and lists the problems worst first, each with its fix.
- Debug a running app: `boxlite-app app logs --source web --level error --since 10m` (also `--grep <regex>`, `--deployment <N>`, `--follow`), `boxlite-app app services` (state, restarts and memory of each service), `boxlite-app app deployment <N> --logs` (timeline with every log line). `boxlite-app app context` also reports the Box's memory and disk, and its next actions say when either is nearly used up and what to change.
- Files on a volume: `boxlite-app app volume ls uploads:/`, `boxlite-app app volume cp ./seed.png uploads:/seed.png`, and to clean up what your checks left behind, `boxlite-app app volume rm uploads:/test.png --yes` (a folder with `--recursive`). Live variables: `boxlite-app app vars list` (secrets masked).

## 5. Verify before you report

Never report success from the deploy exit code alone. Check what the user asked for, and keep test data out of the user's app: checks that create data run in a throwaway environment, which you delete afterwards.

```sh
boxlite-app app env create qa                 # its own URL, database branch (schema, no rows), volumes and users
boxlite-app deploy --env qa -m "verify"
boxlite-app app curl /healthz --env qa --expect 200
boxlite-app app curl /api/items --env qa -X POST -d '{"title":"x"}' --as qa@example.com --expect 201 --body --json
boxlite-app app sql "select count(*) from <table>" --env qa --json
boxlite-app app env delete qa --yes            # removes everything the checks created
boxlite-app deploy -m "what changed"           # then main; on main, only read-only checks:
boxlite-app app curl / --expect 200
```

- `app curl` only ever talks to this environment's own URL, shows redirects instead of following them, and prints status, headers and body (`--json`: `{status, ok, redirect, headers, body_json | body}`; Set-Cookie values are redacted). `--expect 200` (or `302`, `200,201`) exits 1 on any other status, so a check fails loudly; `--body` prints just the body. Do not paste the App key into curl yourself.
- Exercise every feature the user named, through HTTP, the way a browser would (create, list, edit, delete; upload then fetch the file; a protected page refuses an anonymous request).
- Login-only flows: `--as qa@example.com` signs in a 15-minute test user, so your service gets that user's `X-BoxLite-User-*` headers. Without it, `boxlite-app app curl /app` on a protected page answers 401 (`app curl` does not ask for HTML); add `-H 'Accept: text/html'` to see what a browser gets, a 302 to `/.boxlite/auth/login`.
- Anything with a screen to look at (a game, a canvas, a multi-step UI) is not verified by HTTP alone: open it in your browser tool and use it. `boxlite-app app open --print-url --as qa@example.com --path /play --json` gives a one-time link already signed in as the test user (`--role owner` for owner-only pages). Check what the user will see: layout, the flows they named, and the browser console for errors.
- If a check fails, fix and redeploy. Report only when all pass.
- If checks had to run on `main`, clean up after yourself: the rows (`boxlite-app app sql --write "delete from <table> where …"`), the files (`boxlite-app app volume rm uploads:/<file> --yes`), and the test users (`boxlite-app app auth users purge-test --yes`), so the user starts with an empty app unless they asked for sample data.

Before you report, keep what the next session on this App must know and cannot read from the code: the owner's preferences and answers, why something is built the way it is, what is left to do. `boxlite-app app remember "<one fact or decision>"` (never a secret: it is refused); the next agent sees them in `boxlite-app app context`, and `boxlite-app app recall <words>` searches them.

## 6. Report to the user

One short message:

- The app's permanent URL (`url` in `boxlite-app app status --json`; add `--env <name>` for a test version you hand over). Never hand over a one-time link from `app open --print-url`: it expires a minute after you create it and works once, so it is dead by the time the user reads your message. A private app opens for its owner with **Open app** in the BoxLite console, and its URL shows a page that says so; tell the user that in one sentence. Never put the App key in a link.
- What you built, in their words, and what you verified (list).
- Anything only they can decide, phrased as a question: making the app public when their request did not say who may open it (until then nobody but the owner can use it, signed in or not), having an admin add a third-party key, a custom domain.

Do not mention internal steps, retries, or platform terms (Spec, Release, Box, tunnel).

## Rules

- Never print, log, commit, or echo `BOXLITE_API_KEY`, `DATABASE_URL`, or any secret. Never pass them as command-line arguments. (The CLI masks them in its own output, but your shell commands are yours.)
- Make the app `public` (`boxlite-app app access set public --yes`) only when the user said so. A request that people who are not signed in, or anyone with the link, can open or browse the app is them saying so: set it public as part of the build and name it in your report. Otherwise leave it private and ask.
- Never delete an environment, database, or volume unless the user asked. The one exception is an environment you created yourself for verification (§5), which you delete when your checks are done.
- Destructive commands (`app env delete`, `app db restore`, `app db reset`, `app rollback --with-database`) refuse without `--yes` and print exactly what they would destroy. Show that list to the user and rerun with `--yes` only after they agree; deleting your own verification environment (§5) needs no question. `app access set public` also asks for `--yes`; the rule above says when the user's request already gave it.
- Stay inside this App; do not try other BoxLite APIs.
