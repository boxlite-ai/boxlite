# Code health review, 2026-10-22

This is a read-only review. It covers the working tree at `ed155ae`, including the uncommitted edits to `cli/src/commands/curl.ts`, `cli/src/generated/docs.ts`, `docs/cli-reference.md`, `.gitignore` and `cli/boxlite-app.tgz`. It also covers the console frontend, `git diff 8d280af2..micro-cloud-console -- apps/dashboard/src`, in `boxlite-micro-cloud-app`. Builds and tests ran in a scratch copy, so neither repo was touched.

**Baseline, all green:**
- `pnpm -r build` and `pnpm -r typecheck` pass.
- `pnpm -r test` passes: shared 32/32, cli 59/59, control-plane 161/161.
- `make test` passes. `go test -race` passes on darwin.
- `go vet` is clean on darwin and linux.
- staticcheck reports only 2× ST1005 on linux (`privilege_linux.go:256,563`, capitalised error strings).
- madge finds 33 cycles, all type-only, so there are no runtime import cycles.
- `pnpm -C cli build` followed by `git diff --stat` adds nothing new. `docs/cli-reference.md` and `cli/src/generated/docs.ts` match the working-tree sources, and `cli/test/reference.test.ts` enforces this.
- The committed artifact `cli/boxlite-app.tgz` is stale (see L14).

Severity:
- **High:** misleads a maintainer or an agent, or hides a bug.
- **Medium:** costs time or invites a bug.
- **Low:** tidy-up.

`CP` means `control-plane/src`, `SV` means `supervisor`, and `FE` means `apps/dashboard/src` on `micro-cloud-console`.

## Findings

### High

| id | area | file:line | finding | concrete fix |
|---|---|---|---|---|
| H1 | errors / agent | `CP/routes/deployments.ts:59` | The queue-full `next` is `` `boxlite-app deployments N --follow` ``. `cli/src/guidance.ts:22` rewrites it to `boxlite-app app deployments N --follow`, which fails with `unknown option '--follow'` (exit 1). | Change it to `` `boxlite-app app deployment ${n} --follow` `` (singular, with the `app` group). |
| H2 | errors / agent | `shared/src/diagnose.ts:105` | The `migration_sql_error` fix says to test with `boxlite-app app sql --file …` on a non-main env. Migrations are DDL, and `routes/db.ts:119` refuses DDL without `write` (exit 5). SKILL.md:123 tells agents to apply this fix verbatim. | Change it to `` `boxlite-app app env create try` then `boxlite-app app sql --write --env try --file <dir><file>` ``. |
| H3 | CLI / agent | `cli/src/commands/curl.ts:180` | `app open --print-url` prints `next: give this one-time link to the user`. SKILL.md:149 says never to do that, because the link is dead within a minute. | Change the `next` to "open it yourself now; give the user `url` from `boxlite-app app status --json` and tell them to use **Open app** in the console". |
| H4 | CLI / agent | `cli/src/commands/app.ts:143` | `app clone` (SKILL.md:27, the "update an existing app" path) clones `latest_deployment`. Applies, including every console edit, carry no `snapshot_id`, so after any apply clone fails with `deployment #N has no source snapshot` (`routes/deployments.ts:220`). After a failed deploy it clones the broken source instead. | Default to the newest deployment with a snapshot, preferring the live one, and update the help text "(default: latest)" to match. |
| H5 | SKILL drift | `agent/SKILL.md:140-141` | SKILL says an anonymous protected page "returns the login redirect" and "must answer 302 (HTML)". `app curl` sends `accept: */*` (`curl.ts:68`), and `enduser-auth.ts:397` redirects only when Accept contains `text/html`, so agents always get 401. The comment at `curl.ts:61` is wrong for the same reason. | SKILL: "`app curl /x` → 401; add `-H 'Accept: text/html'` to see the 302 to `/.boxlite/auth/login`". Fix the curl.ts comment. |
| H6 | SKILL drift | `agent/SKILL.md:42`, `shared/src/agent-context.ts:170` | Both say "ask the user to add [the secret] in the console". The console can only list and reference org secrets (`routes/console.ts:495`). Setting one needs `PUT /admin/secrets/…` with the admin token (`routes/apps.ts:46`). | Say "ask an org admin to create org secret `<org/name>`", or add a console route that sets the value. |
| H7 | errors / agent | `CP/routes/deployments.ts:92` | The `stale_base` `next` says "run `boxlite-app plan` again, or pass --force". `plan` exits 9 again on a stale base, which loops. `--force` overwrites the user's online edits. SKILL.md:122 says to `app pull`. | Change the `next` to "`boxlite-app app pull`, review the diff, redeploy". |
| H8 | SKILL drift | `agent/SKILL.md:122` | The exit-code list is incomplete. Exit 5 also means `write_requires_flag` ("add `--write`"), 6 also means `rate_limited`, and 1 (usage, sql_error, conflict, `--fail` http_error) is not listed. Exit 10 also comes from `apply` with no TTY (`cli/src/context.ts:186`), where "ask the user first" is wrong. | Add these meanings. Also add `write_requires_flag` and `rate_limited` to `EXIT_MEANING` (`cli/scripts/gen-reference.ts:23-34`); their rows at `cli-reference.md:25,27` are blank. Add `exits: [10]` to `apply`. |
| H9 | SKILL drift | `agent/SKILL.md:40` | Schedules "call a path on your web service", but the scheduler sends `POST` (`CP/scheduler.ts:75`), so a GET-only handler returns 404. | Say "POSTs to `target`". |
| H10 | SKILL drift | `agent/SKILL.md:39,77` | `[auth]` is presented as the way to get per-user data. Access defaults to `private` (`shared/src/manifest.ts:341`), and `proxy.ts:308` gates before identity, so signed-in non-owners are refused. `org` behaves like `private`. | Add: "others, signed in or not, reach the app only once access is public; ask the user". |
| H11 | agent context | `CP/routes/apps.ts:112` | `GET /v1/apps/:app/context` (App-key reachable) still tells agents "Apps are served under a path prefix; use relative links or X-Forwarded-Prefix". Each env now has its own origin. | Delete the legacy markdown renderer (`routes/apps.ts:93-148`) and serve `cli/src/render/context-markdown.ts`'s output, or drop the endpoint. |
| H12 | errors | `cli/src/guidance.ts:20-24` | `COMMAND_FIXES` regex-rewrites CP hints that name commands or env vars that don't exist: `env list`, `logs`, `deployments`, `status`, `BOXLITE_APP_KEY` (`routes/util.ts:14`, `resources.ts:293`, `routes/deployments.ts:73`, `routes/plan.ts:54`, `auth.ts:85`). Console and raw-API callers get the broken text, and the patch hid H1 from maintainers. | Fix the strings at the source, delete `COMMAND_FIXES`, and add T1. |
| H13 | errors | `CP/server.ts:75-84`; `cli/src/cli.ts:89` | The global `onError` turns every unknown error (SQLite constraint, port exhaustion at `origins.ts:152`) into 500 `{code:'internal', message: err.message}`. That leaks internal text and has no `next`. The CLI then says "rerun with BOXLITE_DEBUG=1", which prints nothing, because a server 500 arrives as a `MicrocloudError` and the stack is only printed for other errors. | Return a fixed message plus a request id, and log the stack under that id. Set `next` to "`boxlite-app doctor`; quote request id X". Only print the BOXLITE_DEBUG hint for client-side errors. |
| H14 | duplication / bug | `CP/routes/util.ts:60-77`; `CP/routes/console.ts:37-38,416-419`; `CP/resources.ts:68` | `readManifest` runs the shared rules only on TOML text. Object manifests, which is what the CLI (`apply.ts:30`, `deploy.ts:126`) and the console send, are only zod-shape-checked, so `apply` accepts manifests `check` rejects. The console has its own rules that disagree. `VAR_NAME` allows lowercase, but shared `VARIABLE_NAME_RE` (`shared/src/types.ts:19`) does not, so a console-set `foo` lands in boxlite.toml via `app pull` and fails `check`. `PLATFORM_VARS` exists only in the console, so boxlite.toml can override `DATABASE_URL`/`BOXLITE_APP_URL` (`runtimeEnv` merges user vars last). | Export `validateManifest(obj, env)` from `shared/src/manifest.ts`, with the reserved-name rule, and call it in the object branch. Delete the console copies. |
| H15 | bug | `CP/routes/console.ts:411` | The console's `applyConfig` (variable edits) reads `store.spec(env.id)`, the latest version. After a failed deploy that is the failed spec, written at `orchestrator.ts:257` before the build. So "Set variable" re-applies the broken config and uses its version as `base_version`. Plan and deploy use `effectiveSpecVersion` (`routes/plan.ts:31`). | Use `store.spec(env.id, store.effectiveSpecVersion(env.id))`. Replace the hand-built `manifestFor` (`console.ts:376-394`) with an exported `spec.ts` `manifestOf`. |
| H16 | bug | `CP/routes/console.ts:547` | The console logs endpoint maps every stored level to `error` or `info`. `warn` lines, such as auth's blocked-user sign-in (`enduser-auth.ts:507,574,577,595`), become `info`, so the FE "Warnings" filter (`FE/tabs/LogsTab.tsx:150,196`) hides them. The same file keeps `warn` at `:319`. | Pass the level through, using one shared level mapper (see `services/logs.ts` below). |
| H17 | SV bug | `SV/internal/proc/reaper.go:78-89` | Exit statuses nobody subscribed to stay in `unclaimed` until 1024 accumulate. The comment says they are "dropped on the next sweep", which is false. When a pid is reused, `Subscribe` (`:98`) hands the new child the stale status at once. A service then looks crashed and is respawned while the real process keeps running untracked, or a build step is treated as finished. | Add `Reaper.Start(cmd)` that holds `r.mu` across `cmd.Start()` and registers the waiter. Delete `unclaimed`, and discard true orphans. Add a test for a child that exits immediately. |
| H18 | SV bug | `SV/internal/deploy/deploy.go:231,598-614` | `Boot(ctx)` ignores `ctx`: `spawn` and `spawnNoLock` pass `context.Background()`. So `<-ctx.Done()` in reconcile (`:290`) never fires, SIGTERM doesn't stop builds, and an activation can set `m.live` after `Shutdown` (`:298`) cleared it. The `Wait` comment (`:311`) is wrong as a result. | Store a base ctx and cancel in `Manager` and derive every task from it. `Shutdown` should cancel, then `wg.Wait()`, then stop live. |
| H19 | SV bug | `SV/internal/cp/client.go:123-157`, `deploy.go:353,368` | The snapshot download and extraction run with no deadline; `BuildTimeout` starts after them. A stalled download holds `busy` forever, so every later deploy, activate or rollback gets 409 until the Box restarts. | Create the build ctx before the download, and set `ResponseHeaderTimeout` on the transport. |
| H20 | SV dead code | `SV/internal/gateway/files.go:35,307-375`; `gateway.go:119` | `mountsFromControlPlane`, `mountsCache` and `isOn` are dead, because `main.go:232` always replaces them via `SetMounts`. They could not work anyway: they read `BOXLITE_BOX_TOKEN`, which is unset (`main.go:106`). `TestMountsComeFromTheControlPlaneSpec` tests this dead copy, while the real `main.go:113 mountsFrom` has no test. `SetMounts` also mutates a package global. | Delete lines 307-375. Make mounts a `Server` constructor option, and move `mountsFrom` to `cp.Client.VolumeMounts(ctx)` with a test. |
| H21 | FE drift | `FE/components/apps/CreateAppDialog.tsx:117`, `EnvironmentSwitcher.tsx:173`, `AppDetails.tsx:58` | The dialogs preview the URL as `${cp}/${name}/` and `${cp}/${app}--${env}/`. Envs now get their own origin (`CP/origins.ts:119`), so the preview promises a URL that never exists. The comment at AppDetails:58 says the same old thing. | Drop the preview, or return an origin template from `/console/api/session`. Delete the comment. |
| H22 | FE comments | `FE/App.tsx:56`, `FE/enums/RoutePath.ts:22` | These say "the Apps surface is a design mock served by MSW … hidden outside mock mode". The fixtures are gone (835d5346) and the gate is `isAppsConsole`/`isAppsPreviewEnabled`. | Rewrite both comments to describe the real gate. |
| H23 | dead / misleading | `CP/routes/console.ts:34-35`; `CP/platform.ts:53` | `console` and `auth` are added to `RESERVED_NAMES` as an import-time side effect of the console route module. Anything that imports only `platform.ts`, such as a unit test or a future worker, sees a smaller reserved set. This misled the docs pass for this review. | Put both names in the `RESERVED_NAMES` literal in `platform.ts` and delete the mutation. |
| H24 | docs | `docs/contracts.md:273,280,287,296,302,307,406` | The cookie names and paths predate `__Host-`. On https they are `__Host-bxl_access`, `__Host-bxl_session`, `__Host-bxl_login` (now `Path=/`) and `__Host-bxl_console` (now `Path=/`). Test sessions return `cookie_name: "__Host-bxl_session"` (`enduser-auth.ts:704`). | Rewrite §3 cookies; see the docs drift list. |
| H25 | docs | `docs/decisions.md:9,10,11,12,13,15` | Six dated entries read as current but describe replaced designs: the single gateway header, path-prefix URLs, global blobs, the `BEGIN READ ONLY` + first-keyword SQL guard, volumes "pending login", and `?__key`. | Append "superseded by <date entry>" to each, and add the missing `__Host-` cookie decision. |
| T1 | tests | (missing) | Nothing checks that `` `boxlite-app …` `` strings in CP/shared `next`/`fix` text parse against `buildProgram()`. This is how H1, H2 and H12 shipped. | Add a test that greps every `next`/`fix` literal and runs commander's parse on each command (no action). |
| T2 | tests | (missing) | Admin-only routes have no auth tests: `POST /v1/apps`, `DELETE /v1/apps/:app[?purge=1]`, `POST /v1/apps/:app/restore`, `/admin/*`. Nothing sends a missing token, a bad token or an App key to them. | Add negative tests to `cli-extras.test.ts` or a new `admin.test.ts`. |

### Medium

| id | area | file:line | finding | concrete fix |
|---|---|---|---|---|
| M1 | dead code | `CP/auth.ts:110-131`, `CP/enduser-auth.ts:52-53` | `SESSION_COOKIE='bxl_cp_session'`, `signSession` and `verifySession` are from the path-prefix era and have zero callers. `sessionCookieName(_app, _env)` ignores its params and has zero callers; the comment calls it "kept for callers". | Delete them. |
| M2 | dead-in-waiting | `CP/resources.ts:252-348`, `CP/supervisor.ts:16,30,75-100`, `CP/platform.ts:44`, `CP/main.ts:15-16`, `CP/routes/sv.ts:74-76` | Protocol-1 supervisor compat is still in place: `legacyHealth`, `upgradeOutdatedSupervisors` run at every boot, and `gateway_secret` is duplicated in `/sv/v1/spec`. Every running Box was restarted onto protocol 2 by this code, and no code says when to remove it. | Remove it once `SELECT … WHERE services` shows no protocol-1 Box. Until then, add a `// remove after <date>` marker on each site. |
| M3 | dead-in-waiting | `CP/blobs.ts:89-131`, `CP/server.ts:55` | `migrateLegacyBlobs` (global → per-App blobs) runs on every boot, guarded by a marker file. | Delete it after one deploy, along with the leftover `DATA_DIR/blobs/<sha>` files. |
| M4 | dead-in-waiting | `CP/routes/proxy.ts:342-369`, `CP/server.ts:168`, `CP/console-access.ts:96` | `legacyRedirect` for path-prefix URLs, plus `__key` scrubbing, is labelled "(one release)". | Set a removal date. When it is removed, `app.all('*')` needs a real JSON `notFound`. |
| M5 | dead-in-waiting / perf | `CP/dbreader.ts:37,168-186` | `prepareBranching` calls `listBranches` and then `getRole` for every branch before each branch creation, only to remove SQL-created readers from the first F5 fix. That is a permanent N+1 against Neon for a one-time cleanup. `migrateAll` already handles it at boot. | Drop `prepareBranching` from the branch-create path once `migrateAll` has run everywhere, or record "clean" per project in `cp_settings`. |
| M6 | naming | `CP/db.ts:40,280`, `CP/routes/apps.ts:26`, `CP/routes/envs.ts:30` | The column `envs.gateway_secret` holds the forwarding secret, while the wire calls it `forward_secret` and docs say "forward_secret (`envs.gateway_secret`)". Every reader has to translate. | Add migration 7 to rename it to `forward_secret`, and drop `gateway_secret` from `/sv/v1/spec` together with M2. |
| M7 | dead DB | `CP/db.ts:16`, `CP/resources.ts:99` | `apps.neon_host` is written and never read. | Stop writing it. Leave the column, since sqlite drop is optional. |
| M8 | dead DB | `CP/db.ts:139-145`, `CP/routes/cli-extras.ts:152` | `db_snapshots` is insert-only; no code reads it, so the "before db reset" snapshot is unlisted anywhere. | Either list it in `app db` restore output, or delete the table and the insert. |
| M9 | schema | `CP/console-access.ts:27-36`, `CP/server.ts:86`, `CP/routes/console.ts:90,260` | The `console_access` table is created outside `MIGRATIONS` and has no FK. Rows are orphaned when an env is deleted from the CLI or an app is purged; only the console path cleans up. `AccessLog` is also constructed twice. | Move it into migration 7 with `REFERENCES envs(id) ON DELETE CASCADE`, and share one `AccessLog` via `ctx`. |
| M10 | dead code | `CP/routes/console.ts:100-107`; knip | `deleteAppNow` has no callers and a duplicated doc comment. knip also lists 29 unused exports, including `parsePrefix`, `verifyAccess`, `FORWARD_HEADER`, `CONTROL_HEADER`, `redactUrl`, `blobRefs`, `liveState`, `maskKey`, `currentKey`, `networkError`, `appUrlFor` and `staleError`. They are used only inside their own files. | Delete `deleteAppNow`, and drop `export` from the rest so the public surface of each module is honest. |
| M11 | config | `CP/routes/console.ts:132`, `CP/console-views.ts:232`, `CP/config.ts:20` | `CONSOLE_DIR` and `PROMPT_TEMPLATE_PATH` are read from `process.env` outside `loadConfig`, so `Config` is not the full list of knobs. The `sessionSecret` comment says "app-proxy access cookie", but it also signs the console session and OAuth state. | Add `consoleDir` and `promptTemplatePath` to `Config`, and fix the comment. |
| M12 | boundaries | `CP/dbreader.ts:205-212` | `bindDbReaders` takes `appdb: object` and duck-types `bindReaders`. A typo there silently disables the read-only role. | Type it as `AppDatabase` with an optional method, or wire it in `realDeps`. |
| M13 | duplication | `CP/spec.ts:59-74`, `CP/routes/console.ts:376-394`, `cli/src/toml-edit.ts:39-64` | Spec→Manifest is written three times with different rules; for example, toml-edit maps `port===true` to 3000. | Export one `specToManifest` from `spec.ts`; the CLI keeps only TOML formatting. |
| M14 | duplication | `CP/routes/proxy.ts:202-212,302-310` vs `:387-405` | The HTTP and WebSocket paths each carry a copy of the access gate and upstream-header filter. The WS path never wakes a sleeping Box. | Extract `appGate()` and `upstreamHeaders()` and use them in both. |
| M15 | duplication | `CP/migrations.ts:6,17,23`, `CP/orchestrator.ts:442,597`, `CP/spec.ts:164`, `CP/routes/db.ts:152` vs `shared/src/migrations.ts:37-56` | The CP sorts migrations with `localeCompare` and dedupes by filename. Shared sorts numerically and dedupes by number. `0002_a` plus `0002_b` passes apply, and the order diverges past 9999. `MIGRATION_FILE_RE_CP` copies the shared regex. | Use the shared `compareMigrations` and `validateMigrationSet` everywhere. |
| M16 | duplication | `CP/platform.ts:9-14,23,55`, `CP/routes/apps.ts:48` | `BOX_SIZES`, `SUPPORTED_AUTH_PROVIDERS`, `NAME_RE` and an inline secret-ref regex copy `shared/src/types.ts` (`SIZES`, `AUTH_PROVIDERS`, `APP_NAME_RE`, `SECRET_REF_RE`). | Import them from shared. |
| M17 | duplication | `CP/errors.ts:2-35`, `shared/src/errors.ts:2-48`, `cli/src/api.ts:197` | There are two error classes and three code tables that disagree: `conflict`, `sql_error` and `invalid_request` have no exit code, and `confirmation_required` has no HTTP status. Envelopes are hand-built at `server.ts:80,83,97`, `proxy.ts:141,364`, `enduser-auth.ts:399`, `limits.ts:172` and `cli-extras.ts:48`. | Add one shared `ERROR_CODES: {code: {status, exit}}`, plus `errorResponse()` and `parseErrorBody()`. |
| M18 | duplication | `CP/enduser-auth.ts:380-389`, `CP/routes/proxy.ts:115,337`, `CP/console-auth.ts:44,47,111,123`, `CP/origins.ts:96` | There are three cookie stacks: hand-rolled serialise/parse with no URI-decoding, hono `setCookie`/`getCookie`, and a filter. "Is this origin https" is derived 7 times. | Create `http/cookies.ts` with `hostCookieName`, `isSecureOrigin`, `read` and `write`. |
| M19 | duplication | `CP/routes/proxy.ts:39-55`, `CP/console-auth.ts:22-38`, `CP/enduser-auth.ts:94-111` (+ dead `auth.ts:111-131`) | There are four hand-rolled HMAC token formats. | Create `http/signed-token.ts` with a domain tag per use. |
| M20 | duplication | `CP/resources.ts:241-250`, `CP/origins.ts:212-234`, `CP/neon.ts:69-89`, `cli/src/api.ts:243-272`, `cli/src/follow.ts:24-48`, `cli/src/commands/curl.ts:97-115` (new, uncommitted) | Retry and backoff are written six ways, and two of them retry 4xx. | Create one `retry(fn, {attempts, delayMs, backoff, retryable})` in `CP/http.ts` and one in the CLI's transport. |
| M21 | duplication | `CP/views.ts:36-51` vs `CP/console-deployment.ts:96-103`, `CP/routes/cli-extras.ts:95-134`, `CP/console-views.ts:196-205` | The "own + release" log merge exists 3 times. There are two env-status vocabularies: the CLI can say `live` (no Box needed) while the console says `draft`. `views.ts` hard-codes `ACTIVE_STATUSES`. | Create `services/logs.ts` and a shared `env-status.ts` (see structure proposal). |
| M22 | duplication | `CP/routes/console.ts:39,41,572-576,622-625`, `CP/routes/db.ts:12,27-35,43`, `CP/routes/cli-extras.ts:162`, `CP/console-views.ts:482-492` | `quoteIdent`, the table-list query and db_url parsing each appear twice or more. The console builds `information_schema` SQL through `/db/sql` instead of calling `/db/schema/:table`. | Create `services/db.ts`. |
| M23 | duplication | `cli/src/api.ts:8-168,543-672`, `cli/src/output.ts:114` | The CLI re-declares about 30 wire types that the CP also declares (`db.ts:319-392`, `views.ts`, `console-deployment.ts`, `enduser-auth.ts:620`). They drift silently. | Create `shared/src/wire.ts`, following the existing `AgentContext` pattern. |
| M24 | boundaries | `CP/console-views.ts:253-293` | It calls the BoxLite HTTP API directly with a module-global cache, which bypasses `ctx.boxlite.listVolumes` (test fakes don't apply) and duplicates volume naming (`resources.ts:183,369`). `liveState` (`:343-359`) writes `services` without `services_at`. | Use `ctx.boxlite`, add a `volumeName()` helper, and write through `orchestrator.onSupervisorStatus`. |
| M25 | boundaries | `CP/routes/console.ts:26-31` vs `:184,198,220-228,282-289,536-562` | The header says console writes go through `/v1` in-process, but key rotation, sleep, the app lists and logs use raw SQL. `/apps/:id/activity` (`:564`) has no caller. | Route them through service functions (structure proposal), and delete `/activity`. |
| M26 | boundaries | `CP/resources.ts:23-39`, `CP/origins.ts:119-130` | `appUrl(app, env)` looks like a formatter, but via `origins.envUrl` it allocates a port, writes the DB and starts a listener, on every GET. | Split it into `ensureOrigin(env)` for writes and `envUrl(env)` as a pure read. |
| M27 | layering | `CP/scheduler.ts:7`, `CP/enduser-auth.ts:12`, `CP/console-auth.ts:8`, `CP/orchestrator.ts:7` | Domain modules import route files (`routes/proxy.ts`, `routes/util.ts`), and the deploy engine imports the whole OAuth module just for `ensureUserMirror`. | Make the moves listed in the structure proposal. |
| M28 | errors | `CP/server.ts:79-80` | Any upstream 403 (BoxLite, Neon, supervisor) becomes `forbidden` (exit 5, "outside key scope") with no `next`, and upstream URLs and bodies are echoed to App-key holders. | Map it to `unavailable`, log the details on the server, and send a fixed message. |
| M29 | errors | `CP/errors.ts:6,17` | `next` is optional: 59 `fail()` calls have none (e.g. `auth.ts:62-102`, `routes/db.ts:68-188`, `envs.ts:24-60`). Only the CLI fills defaults in (`guidance.ts:defaultNext`), so console and API users get nothing. Some `next` values are prose or operator-only ("set NEON_API_KEY and restart", `neon.ts:70,92`; `boxlite.ts:59`; `appdb.ts:104,176`). | Move `defaultNext` to shared and apply it in `toBody`, then make `next` required for new codes. |
| M30 | errors | `CP/appdb.ts:129-133` | Every pg error becomes `sql_error` ("fix the SQL"), including `ECONNRESET` and SQLSTATE 08/57. | Map classes 08 and 57, and errors with no SQLSTATE, to `unavailable`. |
| M31 | errors | `cli/src/commands/env.ts:19` | `getSpec().catch(() => null)` swallows auth, 5xx and network errors, so the destructive-delete brief omits the volumes. | Treat only 404 as "no spec". |
| M32 | errors | `CP/resources.ts:408-418`, `CP/routes/proxy.ts:190-230` | A failed `startBox` (quota, 403) or a `missing` Box is only `console.error`'d. Visitors see "Starting…" forever, and the wake is retried every 30 s. | Store the wake error, show an error page, and write it to the env `system` log. |
| M33 | timeouts | `CP/neon.ts:69-87` | Up to 12 retries at 60 s each, so one call can take about 13 minutes. Timeouts and 5xx are retried for non-idempotent POSTs (`createProject`, `createBranch`), which can orphan resources. These calls run inside request handlers (`routes/db.ts:31`, `envs.ts:43`). | Retry POSTs only on 423/429, give the whole call a deadline of about 60 s, and look up by name before re-creating. |
| M34 | timeouts | `CP/routes/proxy.ts:221`, `CP/scheduler.ts:57,75`, `cli/src/api.ts:249`, `CP/oauth-providers.ts:64-110` | There is no explicit timeout on proxy forwarding (undici default 300 s), on sequential scheduler runs (one slow app delays every schedule), on CLI API calls (300 s × 3 attempts), or on OAuth token and profile fetches. | Add `AbortSignal.timeout`: 30 s for the scheduler and the CLI's non-SSE calls, 10 s for OAuth. Run schedules concurrently. |
| M35 | SV security | `SV/internal/gateway/files.go:94,287` | `os.OpenRoot(mount)` and `ownerOf` follow symlinks in the mount path itself. If app code can swap the mount path or an app-owned parent, the root gateway reads and writes wherever it points. | Open the mount with `openat2(RESOLVE_NO_SYMLINKS|O_PATH|O_DIRECTORY)`, build the Root from that fd, and check the owner via the fd. |
| M36 | SV | `SV/internal/gateway/files.go:129` | `root.Open` has no `O_NONBLOCK`, so a FIFO planted in a volume hangs each GET and its OS thread. `static.go:84` already handles this. | Use `OpenFile(name, O_RDONLY|O_NONBLOCK, 0)` and keep the regular-file check. |
| M37 | SV | `SV/internal/state/state.go:161-168`, `SV/internal/privilege/privilege_linux.go:385` | Check-then-open race: `Lstat(app)`, then `OpenRoot(app)` (which follows symlinks), then `chown`. | Use `OpenRoot(AppHome).OpenRoot("app")` and check through the Root. |
| M38 | SV | `SV/internal/proc/run.go:69` | `wg.Wait()` on the output pumps is unbounded. A daemonised grandchild keeps the pipes open, so `RunAs` outlives `BuildTimeout`. | Wait a bounded time (5 s) after the group kill, then close the pipes. |
| M39 | SV | `SV/internal/cp/client.go:192` | It drains the body before `checkStatus` reads it, so `HTTPError.Body` is always empty for `/sv/v1/status` and `/sv/v1/logs`. | Call `checkStatus` first, then drain. |
| M40 | SV comments | `SV/internal/deploy/deploy.go:279-281` | The comment says the CP answers 404 before the first deploy. `routes/sv.ts:80-81` returns 200 with `spec:null`, so the branch is dead. A 401 (revoked token) is logged as "unreachable". | Fix the comment and handle 401 explicitly. |
| M41 | SV duplication | `SV/internal/deploy/deploy.go:112` vs `SV/internal/privilege/privilege.go:73`; `main.go:147`, `privilege_linux.go:295`, `files.go:369` | There are two env filters with different rules (only `ServiceEnv` strips `SUDO_*`) and three truthy-string parsers. | Keep one filter and one `envBool` helper. |
| M42 | SV errors | `SV/internal/deploy/deploy.go:429,471,627`; `privilege_linux.go:55-56` | `Store.Update` errors are discarded, including when saving secrets. A failed `Atoi` yields uid/gid 0, so services would run as root. | Log through `hub.Systemf`, and return `ok=false` on a parse error. |
| M43 | FE | `FE/components/apps/AppDetails.tsx:276` | `busy={mutation.isPending || isFetching}` disables the Access menu on every 1.5 s refetch during a deploy (`useAppsQuery.ts:34,68`), so clicks get dropped. | Use `mutation.isPending` only. |
| M44 | FE | `FE/tabs/OverviewTab.tsx:250` | "Restart all" sends N parallel POSTs with N toasts. The CP restarts all when no name is given (`CP/routes/console.ts:278`). | Make one `run({kind:'restart'})` call. |
| M45 | FE dead | `FE/lib/apps/feature.ts:26-33`, `FE/App.tsx:190`, `FE/components/Sidebar.tsx` | The `localStorage['apps-preview']` gate shows Apps on the normal dashboard, where `/console/api` doesn't exist and a 401 redirects to a missing `/console/login`. | Gate on `isAppsConsole()` only. |
| M46 | FE dead | `FE/components/apps/viz.tsx:161-208`, `FE/lib/apps/types.ts:357-362`, `FE/components/apps/AppDetails.tsx:78-83`, `public/mock/app-shots/*.jpg` | `LivePreview`, `AppPreview`, the mock-era tab redirects and the screenshots are unused. | Delete them. |
| M47 | FE errors | `FE/components/apps/spec.tsx:100-107` | `copyText` doesn't await `clipboard.writeText` and always returns true, so every caller shows "Copied" even when the copy fails. | Make it async, return the result, and toast on failure. |
| M48 | FE | `FE/tabs/AuthTab.tsx:103-105`, `FE/hooks/queries/useAppsQuery.ts:193-199` | User search filters the first 200 users client-side. The CP supports `?search=` (`CP/routes/console.ts:511`). | Send `search` (debounced) in the query key and params. |
| M49 | FE duplication | `FE/components/apps/AppDetails.tsx:115-132`, `useAppAction.ts:21-38`, and 8 more | The same mutate/toast/error block is written about 10 times. The delete flow differs between the list (`pages/Apps.tsx:99-129`, no type-to-confirm, hard-coded "7 days") and the detail page. | Use a generic `useAction(mutateAsync)` and one `useConfirm` delete flow, with retention days from `/session`. |
| M50 | FE | `FE/components/apps/AppTable.tsx:137` | "Open app" shows when the first deploy failed (`lastDeploy` set, nothing live). | Add `live` to the summary view (`CP/console-views.ts:201`). |
| M51 | FE contract | `FE/components/apps/VolumeFiles.tsx:69` | It detects an empty volume root by matching the text `/does not exist/` from `CP/volume-files.ts:51`. | Have the CP return an empty listing, or a distinct code. |
| M52 | FE | `FE/tabs/DatabaseTab.tsx:631,658-666` | "Export CSV" exports only the visible 20 rows. "Query in SQL console" escapes only `'`, while the CP browse filter also escapes `\ % _` (`CP/routes/console.ts:617`). | Rename it "Export page" or add a CP export endpoint, and share the escaping. |
| M53 | docs | `docs/security-review.md` (whole table), e.g. `:22` | The findings table has no status column. F7 (`?__key`, "`proxy.ts proxyHandler`") and F1 are fixed, and `proxyHandler` no longer exists, but the doc still reads as open risk. | Add `status` (fixed in <commit> / open) and update the function references. |
| M54 | docs | `docs/agent-brief.md:4,9,47,53-56` | It still says "`<CP>/<app>/` path prefix", "no need for `?__key=`", and end-user login "not started", with path-scoped cookies. | Rewrite or delete it; it is a one-day brief that is now history. |
| T3 | tests | `CP/test/helpers.ts:19,68,127,194` | The real HTTP clients (`requestJson`, `HttpBoxliteClient`, `HttpNeonClient`, `HttpSupervisorClient`, `OAUTH_PROVIDERS`) have no tests; everything uses fakes. So the Content-Length-0 fix (`http.ts:22`, the prod 411), Neon retry, 404-as-null and timeouts are unguarded. | Add tests against a local `http.createServer`. |
| T4 | tests | `CP/test/sqlguard.test.ts`, `CP/test/sql-matrix.ts` | The guard is never run against real Postgres in CI (`scripts/neon-sqlguard-smoke.ts` is manual). The matrix misses `SELECT … FOR UPDATE`, `nextval()`, `pg_advisory_lock()`, `EXPLAIN ANALYZE DELETE`, and a SECURITY DEFINER wrapper created by a migration. | Add the cases. Run the smoke script against a throwaway Neon branch in a nightly job. |
| T5 | tests | (missing) | Untested: wake/sleep edge cases (failing `startBox`, a `missing` Box, the 30 s dedupe); scheduler failures; CP sqlite v0→latest migration; a failing or edited app migration (`appdb.ts:210,216`); `MAX_FILE_BYTES`, `MAX_SNAPSHOT_BYTES` and chunked `VOLUME_FILE_MAX`; the reaper early-exit path; FIFO and symlinked mounts; a stalled snapshot download. | Add one behaviour test per item. |
| T6 | tests | `CP/test/appdb.test.ts:87-107`, `CP/test/dbreader.test.ts:48-56,81`, `CP/test/db.test.ts:22,57,131`, `CP/test/enduser-auth.test.ts:225,234`, `SV/internal/deploy/deploy_test.go:581,584` | These tests assert exact SQL text, `set_config` parameters, Neon call order, or log message text. Refactors break them while real regressions pass. | Assert end state instead: the role is read-only, the timeouts are in effect, the row is mirrored. |
| T7 | tests | (FE) | There are no unit tests for the new pure FE modules (`lib/apps/sql.ts`, `cron.ts`, `format.ts`, `parseDotenv`, the `client.ts` error mapping). `e2e/console.spec.mjs` doesn't cover env create/delete, .env import, key rotation, upload, block/sign-out, DB restore, or the Warnings filter, which would have caught H16. | Add vitest tests for the pure modules and extend the spec. |

### Low

| id | area | file:line | finding | concrete fix |
|---|---|---|---|---|
| L1 | dead code | `cli/package.json` | The `ignore` dependency is unused by the CLI; it is used via `shared`. | Remove it. |
| L2 | dead code | `SV/internal/state/state.go:184,246`; `SV/internal/release/release.go:26,204,247`; `SV/internal/proc/run.go:18`; `SV/internal/proc/reaper.go:29` | The `logs` dir is created and never used, and `AppDir()` has no callers. `Extract`, `List`, `Prune` and `proc.Run` are wrappers used only by tests. The `Reaped` comment claims it feeds the boot log, which it doesn't. | Delete them, or move them to `_test.go`. |
| L3 | SV structure | `SV/internal/privilege/privilege_other.go` | `Logf`, `Result` and `ErrAlreadyRunning` are declared in both build-tagged files. `marshal` and `sudoersRule` live in the neutral file but are used only on linux (staticcheck U1000 on darwin). | Move the shared declarations to `privilege.go` and the linux-only ones to `privilege_linux.go`. |
| L4 | SV | `SV/internal/gateway/files.go:109,270` | Errors are matched by the string `"escapes from parent"`, and one is invented with that text to reach the 403 branch. | Use an `errOutsideVolume` sentinel with `errors.Is`. |
| L5 | SV | `SV/main.go:235,245,98` | There is no `IdleTimeout`, `err != http.ErrServerClosed` should use `errors.Is`, and the "X is required" error depends on map order. | Fix all three. |
| L6 | SV | `SV/internal/gateway/gateway.go:184,283-289` | `rewrite` reloads the target that `ServeHTTP` already checked, so it can dial port 0 during a flip. `?tail=0` returns everything. | Pass the target via the request context, and reject `tail<=0`. |
| L7 | SV | `SV/internal/gateway/static.go:36,73` | `hasDotSegment` blocks `/.well-known/*` (security.txt, assetlinks). | Allow the `.well-known` segment. |
| L8 | SV contract | `SV/internal/api/types.go` `LogLine.Deployment`, `CP/routes/sv.ts:23,112` | The supervisor sends `0` for "no deployment", and the CP stores 0 instead of null. | Use `*int` with omitempty, or map 0 to null on the CP. |
| L9 | SV | `SV/internal/cp/shipper.go:42,47` | Dropped log lines are only counted and never reported. `enqueue` copies 5000 lines per new line during an outage. | Emit a periodic system line and use a ring buffer. |
| L10 | SV | `SV/internal/privilege/privilege_linux.go:513,600-669` | The sudoers restore ignores errors and forces mode 0440. The launcher downloads and runs the supervisor as root, trusting TLS only, with no version floor. | Check the error and keep the original mode. Pin a checksum or minimum version from the CP spec. |
| L11 | duplication | `CP/config.ts:62`, `CP/enduser-auth.ts:491`, `CP/routes/proxy.ts:61`; nine limit clamps (`routes/apps.ts:72`, `deployments.ts:133`, `db.ts:90`, `cli-extras.ts:114`, `console.ts:540,613`, `db.ts:663`, `enduser-auth.ts:646`); `routes/logs.ts:30` unbounded | Secret generation and `limit` clamping are copy-pasted. | Use `newSecret()` everywhere, and add a `limitParam(v, def, max)` next to `intParam`. |
| L12 | duplication | `CP/agent-context.ts:22`, `CP/routes/cli-extras.ts:78`, `CP/console-views.ts:419`, `CP/routes/apps.ts:127`; `CP/orchestrator.ts:675` | `exposedService` is reimplemented 4 times (one copy uses a truthy `static` check), and `formatMb` copies shared `formatBytes`. Two different functions are both named `safeNext` (`enduser-auth.ts:119`, `console-auth.ts:94`). | Keep one of each, and rename one `safeNext`. |
| L13 | redaction | `CP/routes/console.ts:319,503-506,543-550`, `CP/console-deployment.ts:110-115` | The console API returns raw log lines and failure evidence; redaction only happens in the CLI's output stream. An app that logs its `DATABASE_URL` shows the password in the console, even though `console-views.ts:500` deliberately hides it. | Run `shared/redact` on console log and evidence output. |
| L14 | artifacts | `cli/boxlite-app.tgz` | A build artifact is committed, and it predates the uncommitted `curl.ts` retry, so the bundle lacks it. `deploy/deploy-cp.sh:32` rebuilds it anyway. | Untrack it and add it to `.gitignore`. |
| L15 | exit codes | `shared/src/errors.ts:2-15`, `cli/src/cli.ts:84` | `conflict`, `sql_error`, `invalid_request`, `usage`, `checksum_mismatch`, `upload_incomplete` and `not_supported_yet` all exit 1, the same as `internal`. | Give `conflict` and `usage` their own codes and document them. |
| L16 | comments | `CP/console-auth.ts:12`, `CP/routes/proxy.ts:272` | The console-auth comment says the cookie is "scoped to /console" (it is `Path=/`). The `keyGate` doc comment sits above `isResponse`. | Fix both. |
| L17 | errors | `CP/routes/db.ts:117` | The DDL-on-main hint says `boxlite-app apply` without `--yes`, which exits 10 for an agent. | Add `--yes` to the hint, or "ask the user". |
| L18 | body limits | `CP/routes/cli-extras.ts:204-207` | The volume PUT checks `content-length`, then calls `arrayBuffer()`, so a chunked body is buffered in full. No route has a JSON body limit. | Count bytes while streaming, and add hono `bodyLimit`. |
| L19 | FE dead | `FE/components/apps/SubNav.tsx:194`, `Workbench.feature`, `spec.tsx:172` `Dot`, `lib/apps/format.ts:82` `VISIBILITY_GLYPH`, `DatabaseTab.tsx:747`; unused fields `slug`, `resources`, `createdFrom` (`CP/console-views.ts:378,523`) | Dead exports, props and view fields. | Delete them on both sides. |
| L20 | FE | `FE/hooks/queries/queryKeys.ts:13-22`, `FE/components/Sidebar.tsx:145`, `FE/components/apps/confirm.tsx:29-35` | The `organizationId` param always receives `'console'`, and `'admin'` is hard-coded although `/session` returns the user. A second `confirm()` orphans the first promise. | Rename the param, read the user from `/session`, and reject or queue the second confirm. |
| L21 | FE constants | `FE/components/apps/VolumeFiles.tsx:23`, `DeploymentDetail.tsx:200`, `DatabaseTab.tsx:389,525`, `VariablesTab.tsx:41-42`, `deleteCopy.tsx:7` | Copies of CP limits: upload max, 5000 lines, 1000 rows, the 6 h restore window, the variable-name regexes, 7-day retention. | Return them from `/console/api/session`. |

## Structure proposal

These are moves only, with no behaviour change; each bullet can be its own PR, under 400 lines. Paths are under `control-plane/src`.

1. **`services/` for logic that both route sets call.** `routes/*.ts` (CLI, `/v1`) and `routes/console/*` should both call these; neither should embed SQL.
   - `services/apps.ts`:
     - `createApp` from `routes/apps.ts:13-31`.
     - `rotateKey` from `routes/console.ts:220-228`.
     - `listApps` and `listDeletedApps` (replacing the SQL at `console.ts:184,198`).
   - `services/envs.ts`:
     - `createEnv` and `deleteEnv` from `routes/envs.ts:20-76`, taking over the `console_access` cleanup at `console.ts:260` and the teardown copy at `lifecycle.ts:55-66`.
     - One `assertIdle` guard (from `lifecycle.ts:14`, `envs.ts:61`, `deployments.ts:58`).
   - `services/deployments.ts`: `prepare` from `routes/plan.ts:24-59`, and `createDeployment` from `routes/deployments.ts:44-128`.
   - `services/config-edit.ts`:
     - The console variable edits from `routes/console.ts:367-421`, using the effective spec (fixes H15).
     - `spec.ts`'s `manifestOf`, exported as `specToManifest`.
   - `services/db.ts`:
     - The handler bodies of `routes/db.ts:23-193`, plus `cli-extras.ts:142-157`.
     - The console query building at `console.ts:571-629`.
     - db_url parsing from `console-views.ts:481-493`.
     - `quoteIdent` and the table-list query.
   - `services/logs.ts`:
     - `Store.logs` with a level filter (replacing `cli-extras.ts:95-117`).
     - One `deploymentLogs()` (replacing `views.ts:36-43`, `console-deployment.ts:96-103`, `cli-extras.ts:126-134`).
     - `parseSince` (from `routes/logs.ts:12-19`).
     - One level mapper (fixes H16).
   - `services/env-status.ts`: one status vocabulary, replacing `views.ts:45-51` and `console-views.ts:196-205`.
2. **Split `routes/console.ts` (650 lines) into `routes/console/`.** Use the existing section markers:
   - `static.ts` (109-153).
   - `apps.ts`, `envs.ts`, `config.ts`, `auth.ts`, `logs.ts`, `db.ts` (183-644), each a thin adapter over `services/*`.
   - Move the `RESERVED_NAMES` additions into `platform.ts` (H23).
3. **Split `routes/proxy.ts` (436 lines) into `proxy/`.** It is the proxy engine, not a route file:
   - `proxy/access.ts`: tickets and access tokens (32-84).
   - `proxy/forward.ts`: forwarding and rewriting (86-121, 162-265).
   - `proxy/app-origin.ts`: the gate (267-340) with one `appGate()` and `upstreamHeaders()` (M14).
   - `proxy/upgrade.ts`: WebSocket (371-436).
   - `routes/legacy.ts`: path-prefix redirects (342-369), to delete per M4.
   - `scheduler.ts` and `main.ts` then import from `proxy/`, not `routes/`.
4. **Split `enduser-auth.ts` (706 lines) into `enduser/`:**
   - `config.ts` (32-78).
   - `state.ts` (80-111).
   - `paths.ts` (113-160).
   - `identity.ts`: the RS256 key and JWT (162-218).
   - `users.ts`: the repository and management API (220-325, 618-706).
   - `mirror.ts` (327-367): the only module `orchestrator.ts` imports.
   - `flow.ts`: the proxy hook and OAuth routes (412-616).
5. **Add `http/` for shared HTTP helpers:**
   - `cookies.ts`: `hostCookieName`, `isSecureOrigin`, read and write (M18).
   - `signed-token.ts` (M19; delete `auth.ts:110-131`).
   - `pages.ts`: `escapeHtml` from `routes/util.ts:86` and the four HTML shells.
   - `retry.ts` (M20).
6. **Split `orchestrator.ts` (692 lines):**
   - `migrator.ts` (464-498).
   - `snapshot-check.ts` (563-601).
   - `job.ts` (603-673).
   - The read-only release queries (408-427) go to `services/releases.ts`.
7. **Split `resources.ts` (420 lines):**
   - `env-urls.ts` (23-39), with `ensureOrigin` split from the pure `envUrl` (M26).
   - `runtime-env.ts` (57-74).
   - `db-provisioner.ts` (76-132).
   - `volumes.ts` (350-373) plus `volumeName()`.
   - `box-wake.ts` (375-419).
   - `supervisor-compat.ts` (252-348), kept separate so M2 is one file delete.
8. **Split `db.ts`:**
   - `db-schema.ts`: `MIGRATIONS`, plus `console_access` with an FK (M9).
   - `rows.ts`: the row types.
   - `Change` and `MigrationFile` move to `shared/src/wire.ts`.
9. **CLI:**
   - `cli/src/http.ts`: transport, retry and error mapping from `api.ts:170-298`.
   - `shared/src/wire.ts`: the DTOs from `api.ts:8-168,543-672` and `output.ts:114` (M23).
   - Move `MakeCtx` from `cli.ts` to `commands/types.ts`, and `Io` to `io.ts`. This removes the type cycles.
10. **Supervisor:**
    - Mount lookup becomes a `gateway.Server` option, fed by `cp.Client.VolumeMounts`.
    - One env filter, either in `privilege` or in a new `internal/envfilter`.
    - The platform-neutral `privilege` declarations go in `privilege.go`.

## Docs drift

### `agent/SKILL.md` (agents follow this; every item is high)
1. `:122`: the exit list is missing `write_requires_flag` (5), `rate_limited` (6) and exit 1, and exit 10 from `apply` with no TTY (H8).
2. `:123`: it applies the `migration_sql_error` fix verbatim, and that fix lacks `--write --env` (H2).
3. `:140-141`: anonymous protected pages give 401 through `app curl`, not 302 (H5).
4. `:42`: secrets cannot be added in the console (H6).
5. `:40`: schedules are `POST` (H9).
6. `:39,77`: `[auth]` doesn't open a private app to other people (H10).
7. `:27`: the `app clone` update path fails after any apply (H4).
8. `:149` vs CLI `app open` `next` (H3); `:122` exit 9 vs the CP `stale_base` `next` (H7).
9. `:29`: it links `../docs/cli-reference.md`, which 404s when served as `/agent.md`. Keep only `boxlite-app docs reference`.
10. `:95`: the app URL example has a trailing `/`, but `BOXLITE_APP_URL` has none (`CP/resources.ts:30`).
11. `:107`: the injected-env list omits `BOXLITE_APP` (`CP/resources.ts:65`).
12. `:102`: it doesn't say that `X-BoxLite-User-Email` is URI-encoded when non-ASCII (`CP/enduser-auth.ts:444`).
13. `:50`: `init` also appends to `.gitignore` and rewrites the AGENTS.md block; the doc says "never overwrites".

### `docs/cli-reference.md` (generated)
14. It is current with the working tree: the build produces no diff, and `reference.test.ts` enforces it.
15. The exit table rows for `write_requires_flag` and `rate_limited` (`:25,27`) have empty meanings.
16. `apply` doesn't list exit 10 (`:103`).

### `docs/contracts.md`
17. `:273,280,287,296,302,307,406`: the cookies are `__Host-…` on https. `bxl_login` and `bxl_console` are now `Path=/`, and the test-session `cookie`/`cookie_name` use the prefixed name (H24).
18. `:192-193,207,341,344`: `gateway_secret` is described as a live field. Mark it "protocol-1 only, to be removed" (M2/M6).
19. `:197`: the status phases are missing `built`, which the same doc uses at `:219-220,246`.
20. `:382`: "`/sv/v1/logs` never 4xx" is wrong. It returns 400 for more than 5000 lines, a `source` over 64 chars or a `level` over 16 chars (`CP/routes/sv.ts:16-26`).
21. `:89`: `snapshot_id?` is required for `deploy` and optional only for `apply` (`CP/routes/deployments.ts:21,30`).
22. `:29`: the example has `"port": true`, but the CP emits integers only.
23. The §1 error table and the db/sql list (`:356-365,370`) are missing `write_requires_flag` (403, exit 5), `internal` (500), `not_supported_yet` (422) and the online rule `app_mismatch` (`CP/spec.ts:191`).
24. These endpoints are undocumented:
    - `DELETE /v1/apps/{app}[?purge=1]` and `POST /v1/apps/{app}/restore`, both admin only (`CP/server.ts:127-141`).
    - `GET /cli/version`, `GET /auth/start`, `GET /auth/callback/{provider}` and `GET /auth/jwks.json`, which are missing from the unauthenticated list (`:369`).
    - Most of `/console/api/*` (`CP/routes/console.ts:92-639`). §4.2 lists only "additions".
    - Also, §4.2 writes `{app}` while §3 writes `{id}`.
25. `:15,390`: the name rules don't mention that names may not end in `-` (`CP/platform.ts:61`). The `console` reservation is real, but it only exists as a side effect of importing `routes/console.ts` (H23).
26. Config: `ENV_PORT_MIN`/`ENV_PORT_MAX`, `CONSOLE_DIR`, `PROMPT_TEMPLATE_PATH`, `NEON_*` and `BOXLITE_API_*` are undocumented. `:262` gives `PORT` 8080 and `CONSOLE_PORT` 8081, which are deploy values (`deploy/deploy-cp.sh:59-61`); the code defaults are 8787 and port+1.

### `docs/decisions.md`
27. These entries are superseded but read as current (H25):
    - `:9`: one gateway header. Now `X-BoxLite-Control` and `X-BoxLite-Gateway` are split; see the F3 entry.
    - `:10`: path-prefix URLs. Now one origin per env (`:16`).
    - `:11`: content-addressed blobs. Now per-App blobs (`CP/blobs.ts:16`).
    - `:12`: `BEGIN READ ONLY` "rather than parsing". Now libpg-query parsing, the `boxlite_reader` role and `write_requires_flag`.
    - `:13`: volumes "pending login". Managed volumes are implemented.
    - `:15`: `?__key`. Removed; replaced by end-user OAuth and the console login.
28. The `__Host-` cookie decision (commit 1c3e756) has no entry.

### `README.md`
README.md was being edited by someone else during this review. Their uncommitted edit fixed the Node version and added `e2e/` and `docs/architecture.md` (the new `docs/architecture.md` was not reviewed). Still open:
29. `:11` says `agent/` holds "agent.md + skill". It holds `SKILL.md` (served as `/agent.md`) and `prompt-template.md`.
30. The layout table is missing `shared/` and `console-dist/`.
31. The new pointer line calls `docs/polish-backlog.md` "findings … and their status". Point to this file for code-level issues too.

### Other docs
32. `docs/agent-brief.md:4,9,47,53-56`: the path-prefix URLs, `?__key` and "end-user login not started" are all stale (M54).
33. `docs/security-review.md`: there is no status column. F1 and F7 are fixed, and F7 cites the removed `proxyHandler` (M53).
34. Code strings that act as docs:
    - `CP/routes/apps.ts:112`: the path-prefix advice in the agent context (H11).
    - `CP/auth.ts:85`: `BOXLITE_APP_KEY` should be `BOXLITE_API_KEY`.
    - `CP/console-auth.ts:12`: "scoped to /console".
    - `SV/internal/deploy/deploy.go:279`: the "404 before first deploy" comment.
    - `SV/internal/proc/reaper.go:79`: the "dropped on the next sweep" comment.
    - `FE/App.tsx:56` and `FE/enums/RoutePath.ts:22`: the "mock" comments.
