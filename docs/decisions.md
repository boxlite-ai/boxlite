# Decisions (prototype)

Dated, newest last. Each line: decision — why.

- 2026-10-21 Control plane runs in one BoxLite Box on dev, using only the public /v1 API — proves the agent flow without platform changes.
- 2026-10-21 One Box per environment; build happens in place inside that Box (no separate build Box) — one fewer moving part; release dirs `releases/<N>` + `current` symlink give instant rollback for the last 3.
- 2026-10-21 Deploy = supervisor build → CP migrates → supervisor activate — matches PRD 4.2: a failed build never touches the database.
- 2026-10-21 Supervisor is pulled by the Box `cmd` on every start and cached in $HOME — `cmd` re-runs as PID 1 on start (measured), $HOME persists, /tmp does not.
- 2026-10-21 Every request into an app Box must carry `X-BoxLite-Gateway` — the Box tunnel is public; without this anyone with the tunnel URL bypasses access control.
- 2026-10-21 App URLs are `<cp>/<app>/` path prefixes — no wildcard domain yet (user decision); agent.md requires relative URLs.
- 2026-10-21 CP state in SQLite (`node:sqlite`) under $HOME of the CP Box; blobs content-addressed on disk — no extra service to run.
- 2026-10-21 SQL read-only by wrapping in `BEGIN READ ONLY` rather than parsing — the database enforces it; DDL on main blocked by first-keyword check.
- 2026-10-21 Volumes need a key with volume permissions; the existing dev key has only write/delete:boxes (measured) — new key pending user login in the browser.
- 2026-10-21 Read-only mounts of org volumes are out (the /v1 DTO rejects read_only) — `check`/`plan` report not_supported_yet.
- 2026-10-21 Login: platform Google/GitHub only, waiting for the OAuth app from the user; until then `private` access uses the App key once via `?__key=` to set a cookie.
- 2026-10-21 One origin per app env: `https://<port>-d-<cp box hex>.proxy.dev.boxlite.ai/` (CP Box registers a tunnel per env port; measured to work, Host is passed through) — security review F1: a shared origin let any hosted app's JS drive the console with the admin cookie. Also removes the path prefix, the agents' most common breakage.
- 2026-10-21 Console on its own origin, separate from the API origin and every app origin.
- 2026-10-21 No App key in URLs: console "Open app" uses one-time tickets; agents verify private apps with `Authorization: Bearer <App key>`, which the proxy checks and strips (F7).
- 2026-10-21 Supervisor runs as root, app services as `boxlite` without sudo; gateway forwarding secret and control secret are separate (F2, F3).
- 2026-10-21 boxlite keeps exactly one sudo right: `/usr/local/sbin/microcloud-sv ""` (the launcher, a copy of the supervisor binary, root-owned) — every Box start re-runs `cmd` as boxlite and needs root once; the launcher ignores its environment, downloads new supervisor versions as root and execs the root-owned cached copy, so nothing boxlite controls is ever run as root (contracts 2.1).
- 2026-10-21 Root-only state lives in `/home/boxlite/.microcloud-root/` (0700 root), not `/var/lib` — `$HOME` is the only path measured to persist; root reaches it and the boxlite-owned release tree only through open `os.Root` handles, because boxlite owns `/home/boxlite` and can rename anything in it.
- 2026-10-21 Protocol-1 Boxes are restarted, not replaced — keeps their releases (rollback) and needs no redeploy. Residual risk until such a Box is replaced (any image/size/volume change, or deleting and redeploying the env): its `cmd` still execs `~/.microcloud/sv` as boxlite first, so app code that plants a binary there and makes the download fail runs as PID 1 with the Box env (box token); and a box token read before the upgrade stays valid for the Box's life.
- 2026-10-21 Volumes are deleted by the BoxLite ids the CP recorded at creation (`env_volumes`), never by name; a same-named volume the CP did not create is a `conflict` (F10).
