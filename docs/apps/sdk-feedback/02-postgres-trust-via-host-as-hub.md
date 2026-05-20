# [SDK Bug?] PostgreSQL rejects host-as-hub connections with "no password supplied" even when `pg_hba.conf` explicitly uses `trust`

> Issue source: dogfood discovery via `apps/infra-local/poc/multi_service.py` (Phase I) (2026-05-20)
> Status: needs triage — could be BoxLite issue OR postgres+gvproxy interaction
> Priority: P2 (blocks pg-as-a-service in dogfood orchestrator; redis path proven working)
> Discovered by: lile (michael.li@polygala.ai)
> Depends on: SDK Feedback #01 (since the workaround uses Mac LAN IP)

---

## Summary

When a BoxLite client box connects over TCP to a PostgreSQL service running in another BoxLite box (via Mac LAN IP host-as-hub workaround for SDK Feedback #01), the server **rejects the connection with `fe_sendauth: no password supplied`** — even though `pg_hba.conf` explicitly contains `host all all 0.0.0.0/0 trust` and `pg_reload_conf()` returned success.

**Same network path with redis works perfectly** (PING / SET / GET / INCR via `192.168.1.110:6379` — round-trip 13-50 ms). So it's not a network reachability problem — it's specific to postgres + gvproxy + auth interaction.

---

## Reproduction Steps

Prereqs:
- Phase 1 boxes running (`python apps/infra-local/poc/multi_service.py`)
- Mac LAN IP detected (e.g. `192.168.1.110`)

```bash
# 1. Confirm pg_hba.conf has trust auth
python -u -c "
import asyncio
from boxlite.boxlite import Boxlite
async def main():
    pg = await Boxlite.default().get('boxlite-local-pg-poc')
    e = await pg.exec('cat', ['/var/lib/postgresql/data/pgdata/pg_hba.conf'])
    out = []
    async for c in e.stdout(): out.append(c if isinstance(c, str) else c.decode())
    await e.wait()
    print([l for l in ''.join(out).split(chr(10)) if l.strip() and not l.strip().startswith('#')])
asyncio.run(main())
"
# Output includes: 'host all all 0.0.0.0/0 trust'

# 2. Try psql from another box via Mac LAN IP
python -u -c "
import asyncio
from boxlite.boxlite import Boxlite
async def main():
    client = await Boxlite.default().get('boxlite-local-client-poc')
    e = await client.exec('psql', ['-w', '-h', '192.168.1.110', '-p', '5432', '-U', 'postgres', '-d', 'postgres', '-c', 'SELECT 1;'])
    out, err = [], []
    async for c in e.stdout(): out.append(c if isinstance(c, str) else c.decode())
    async for c in e.stderr(): err.append(c if isinstance(c, str) else c.decode())
    r = await e.wait()
    print(f'exit={r.exit_code}, out={\"\".join(out)!r}, err={\"\".join(err)[-200:]!r}')
asyncio.run(main())
"
# Output: exit=2, err contains 'fe_sendauth: no password supplied'
```

---

## Expected vs Actual

### Expected

With `pg_hba.conf` containing `host all all 0.0.0.0/0 trust` (verified loaded via `pg_hba_file_rules()`), an external TCP connection should be accepted by the server without password authentication.

### Actual

Server requests password authentication, psql aborts with `fe_sendauth: no password supplied`.

### Cross-checks confirming this is NOT a generic config problem

| Variation | Result |
|---|---|
| `psql -h 127.0.0.1 -U postgres -c "SELECT 1"` (from inside pg-box) | ✅ exit=0, returns `1` |
| `psql -h 192.168.1.110 -U postgres ...` (from inside pg-box) | ❌ "Host is unreachable" (gvproxy hairpin issue, separate matter) |
| `psql -h 192.168.1.110 -U postgres ...` (from **client-box**) | ❌ **"no password supplied"** (this bug) |
| `redis-cli -h 192.168.1.110 -p 6379 PING` (from client-box) | ✅ "PONG" — same network path, no auth issue |
| `pg_hba.conf` rule explicitly `0.0.0.0/0` (not `all`) + `pg_reload_conf()` | ❌ same "no password supplied" |
| Non-superuser (`CREATE USER dogfooder NOPASSWORD`) via client-box | ❌ same "no password supplied" |

So:
- Network path proven working (redis works, TCP probe works)
- pg_hba.conf parsed correctly (`pg_hba_file_rules()` shows trust)
- Local 127.0.0.1 trust works (rules in same file)
- External + trust fails ←  **the anomaly**

---

## Root Cause Analysis (hypotheses)

### Hypothesis A: postgres docker-entrypoint adds a hidden override

The official `postgres:16-alpine` entrypoint script generates `pg_hba.conf` based on `POSTGRES_HOST_AUTH_METHOD`. Maybe when `POSTGRES_PASSWORD` is also set, it ALSO appends a higher-priority password rule that overrides trust. But `pg_hba_file_rules()` showed only 7 rules with the final `host all all all trust` — no md5 rule. So this seems unlikely.

### Hypothesis B: gvproxy's NAT changes source IP / port in a way that triggers some pg behavior

When client-box → 192.168.1.110:5432 → pg-box, the postgres server sees some source IP. If gvproxy injects unusual headers / does double-NAT, maybe pg sees a source that doesn't match `0.0.0.0/0` (impossible per CIDR semantics, but worth verifying).

To test: enable `log_connections = on` in postgresql.conf and inspect the server logs to see what source IP/auth-method is chosen per connection.

### Hypothesis C: pg server is using OLD config in memory despite `pg_reload_conf()` returning true

Although `pg_reload_conf()` returned `t`, maybe specific code paths require full restart. Testing: hard restart pg-box (`stop && start`) and retry. **Not yet tried** in this PoC.

### Hypothesis D: postgres alpine image has a custom `pg_hba.conf` template that overrides trust

Unlikely — `pg_hba_file_rules()` shows exactly what we see in `cat pg_hba.conf`.

### Hypothesis E: the connection is somehow going through a different postgres instance

E.g., system pg installed at a different port, gvproxy forwards to that instead. Unlikely but cheap to verify with `boxlite-cli logs boxlite-local-pg-poc | head` (would show ports).

---

## Proposed Fix / Next Investigation

1. **Enable connection logging**: add `log_connections=on, log_hostname=on, log_line_prefix='%t %h %u'` to `postgresql.conf`, reload, retry → inspect log to see what auth method pg actually selects per connection.

2. **Full restart test**: `boxlite-cli stop boxlite-local-pg-poc && boxlite-cli start boxlite-local-pg-poc` (or equivalent SDK call), then re-test. If trust works after restart, **`pg_reload_conf()` is insufficient for new rules** — that's pg behavior, not BoxLite, but worth documenting.

3. **`tcpdump` on Mac and inside pg-box**: see what packets actually traverse the gvproxy NAT path. This nails down whether the source IP is what we think it is.

4. **Bypass gvproxy NAT**: instead of going through Mac LAN IP, try having client-box connect directly to pg-box's `192.168.127.X` IP if there is a way (probably not in current SDK).

---

## Impact

- **Blocks**: pg-as-a-service in dogfood orchestrator. Caddy / pgadmin / api boxes all need to talk to postgres.
- **Doesn't block**: dogfood architecture in general — redis path works fine, host-as-hub network model is proven.
- **Workaround**: use `POSTGRES_HOST_AUTH_METHOD=trust` env (doesn't help here) + handle password explicitly in clients (URI with embedded password — but that also fails for unknown reason in this same setup).

---

## Workaround

**For PoC continuation only** — connect to pg from inside pg-box itself (via 127.0.0.1, trust works there) and use it as an intermediary, OR run pg orchestration via `boxlite-cli exec boxlite-local-pg-poc -- psql ...` (in-box execution).

**For production dogfood orchestrator**:
- Investigate further before relying on pg-as-a-box.
- Fallback: run pg via docker (not dogfood) until this is resolved.

---

## References

- PoC reproducer: `apps/infra-local/poc/multi_service.py` (Phase I) + `diagnose_network.py`
- Related: SDK Feedback #01 (`host.boxlite.internal` unwired — forces use of Mac LAN IP)
- pg_hba_file_rules() output (2026-05-20 PoC):
  ```
   line | type  | database      | user_name | address   | auth_method
  ------+-------+---------------+-----------+-----------+-------------
   117  | local | {all}         | {all}     |           | trust
   119  | host  | {all}         | {all}     | 127.0.0.1 | trust
   121  | host  | {all}         | {all}     | ::1       | trust
   124  | local | {replication} | {all}     |           | trust
   125  | host  | {replication} | {all}     | 127.0.0.1 | trust
   126  | host  | {replication} | {all}     | ::1       | trust
   130  | host  | {all}         | {all}     | 0.0.0.0/0 | trust
  ```

---

## Acceptance Criteria

- [ ] Connection logs from pg server captured showing the actual auth_method chosen for an external connection
- [ ] Hypothesis identified (A/B/C/D/E or new)
- [ ] Either fix shipped (SDK or postgres image config) OR documented workaround that's not "use docker"
- [ ] `python apps/infra-local/poc/multi_service.py` Phase I (psql via host-as-hub) passes
