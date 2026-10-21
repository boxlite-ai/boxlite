# Polish backlog

Findings from real runs, newest last. Each line: finding → owner area → status.

- Sign-in events are not logged: `app logs --source auth` is empty after a real GitHub login → CP enduser-auth → fixed
- `?__key=` is the only way to open a private app; agents had to tell users to paste it → proxy gate + console "Open app" → in progress (console)
- `app db schema` printed raw JSON → CLI → fixed
- apply deployments had no description → CLI → fixed
- plan label lost the dot in `migrations/0001_init.sql` → CLI → fixed
- pg printed an sslmode deprecation warning into every app's logs → CP neon URI → fixed (verify-full)
- Deployment list showed a kind column although the PRD says no types → CLI → fixed
- End users could reach `/.boxlite/sv/*` through the proxy (gateway secret is added by the proxy) → proxy → fixed (404)
- `auth test-session` was referenced in SKILL.md before it existed → CP/CLI → fixed
- A failed deploy made the agent's next deploy "stale" (exit 9) because the failed spec counted as the env's state → CP plan/deploy uses the effective spec version → fixed (regression test in orchestrator.test.ts)
- CLI refused every command in an unlinked directory although the key names the app; a wrong key reported not_linked instead of exit 2 → CLI → in progress
- `app status --json` has no box id, so agents can't correlate with BoxLite for debugging → CP env summary → open
- `app context` misses table names → CLI context rewrite → in progress
- Security review F1–F10 (docs/security-review.md) → per-app origins, supervisor isolation, SQL roles/blobs/limits → in progress
- Proxy forwarded `__Host-bxl_*` platform cookies to apps (strip rule only matched `bxl_*`) → proxy appCookies → fixed
- Platform cookies on sibling origins could be shadowed by a `Domain=` cookie from another app (cookie tossing) → `__Host-` prefix on https → fixed for app origins; console cookie in progress
- Supervisor volume files handler checked symlinks then opened by path (TOCTOU as root) → all I/O through os.Root → fixed
- Box launcher accepted any supervisor binary the CP served (no signature) → ed25519 release signing, key off the CP → fixed
- Console "Sleep now" was undone by the next page refresh: the 5 s status cache still said running, so the detail view probed health through the tunnel and woke the Box (apps never sleep while someone watches the console → cost) → resources.sleep() records the stop → fixed, regression test proven to fail without the fix
- A port briefly held during a CP restart left that app on 502 until a manual restart → listeners retry EADDRINUSE for 3 min → fixed
- The SQL reader role (created by SQL) made Neon refuse schema-only branches, so `env create --from main` broke → reader becomes a Neon-managed role used by direct connection → in progress
- `status` reported the newest spec version even after a failed deploy, so agents re-based on a version that never took effect → effective version in status and rollback → fixed
- Acceptance round 1 (3 real agents, 0 interventions, all live in 2:47–4:24): findings below
- Signed-in `/.boxlite/auth/me` was forwarded to the app: @hono/node-server swaps the global Response, so `Response.json()` results failed `instanceof Response` in the proxy → `isResponse()` shape check → fixed; real-listener regression test proven to fail without the fix
- Agents handed users one-time `app open` links that expire in 60 s → SKILL.md: report the permanent URL; owner opens private apps from the console → fixed
- A DELETE without --write answered "cannot execute DELETE in a read-only transaction / fix the SQL", so an agent concluded it could not clean its test rows → refused before execution with `write_requires_flag` and the exact `--write` command; 25006 fallback hint → fixed
- SKILL.md never told agents to remove their test data → section 5 cleanup rule → fixed
