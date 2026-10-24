# Error matrix · 2026-10-23T17:59:22.060Z

CP https://8080-d-76416e6f374b4352547a7a68.proxy.dev.boxlite.ai · 14/14 scenarios give the agent what it needs

| | scenario | expected | what the CLI returned | s |
|---|---|---|---|---|
| ✔ | invalid boxlite.toml is caught before upload | check exits 7 naming the field and line | exit 7 · unknown_field at boxlite.toml:7 | 0 |
| ✔ | the good version deploys | live, serving v1 | https://10107-d-76416e6f374b4352547a7a68.proxy.dev.boxlite.ai | 31 |
| ✔ | a build step fails (type error) | build_command_failed, the compiler line as evidence | exit 8 · cause build_command_failed · fix: run `node -e "console.error('src/cart.ts(3,5): error TS2322: Type string is not assignable to type number'); process.exit(2)"` locally, fix  | 11 |
| ✔ | a build script that does not exist | npm_script_missing, names the script | exit 8 · cause npm_script_missing · fix: add "build" to "scripts" in package.json, or change [runtime].build in boxlite.toml, then `boxlite-app deploy` | 6 |
| ✔ | no lockfile for npm ci | missing_lockfile | exit 8 · cause missing_lockfile · fix: run `npm install` in the project, make sure package-lock.json is not listed in .gitignore or .boxliteignore, then `boxlite-app deploy` | 5 |
| ✔ | a module that is not installed | module_not_found, names the module | exit 8 · cause module_not_found · fix: add it to dependencies (not devDependencies): `npm install left-pad-xyz` so package.json and package-lock.json include it, then `boxlite-app | 7 |
| ✔ | a hard-coded port instead of $PORT | port_binding, names both ports | exit 8 · cause port_binding · fix: listen on process.env.PORT and host 0.0.0.0 (Node: `app.listen(Number(process.env.PORT), "0.0.0.0")`; Python: `--host 0.0.0.0 --port $PORT`) | 67 |
| ✔ | a crash at startup | crash_on_start, the thrown message as evidence | exit 8 · cause crash_on_start · fix: run `node server.js` locally with PORT=3000 (`boxlite-app app dev` uses the cloud env), fix the error in its stderr shown above, then `boxli | 7 |
| ✔ | a migration with a SQL error | migration_sql_error, names the file | exit 8 · cause migration_sql_error · fix: fix the SQL in migrations/0002_bad.sql:1 (it did not apply, so editing it is safe); to try it first, `boxlite-app app env create try` (once) | 7 |
| ✔ | an applied migration edited afterwards | migration_changed, says to add a new one | exit 7 · invalid_manifest · put migrations/0001_init.sql back exactly as it was applied (e.g. `git checkout -- migrations/0001_init.sql`) and move y | 4 |
| ✔ | a request that throws | the stack reaches app logs and app context | logs: "boom-marker: cannot read the price of an empty cart" · context.recent_errors has it | 8 |
| ✔ | a crash after go-live | services shows the restart and exit code; logs have the reason | restarts 2, last exit 1, reason in logs | 7 |
| ✔ | a scheduled job that fails | schedule list shows the failure; logs have the job output | run → 500, list last_status 500, output in logs | 18 |
| ✔ | the app runs out of memory | services/context say it was killed for memory, not a plain crash | exit 137; context names memory | 14 |
