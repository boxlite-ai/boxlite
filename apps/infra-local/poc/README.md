# PoC — `apps/infra-local/` dogfood feasibility tests

Quick experiments to validate whether BoxLite Python SDK can replace Docker
in `apps/infra-local/`. **All must pass before committing to the full
`own-dog-food-local-infra-solution.md` design.**

Source design: `docs/apps/own-dog-food-local-infra-solution.md`.

---

## Phase 0 — Single service (postgres)

**Goal**: verify BoxLite can host one daemon service (postgres) that's
reachable from the macOS host via gvproxy port forwarding.

### Prereqs

- macOS Apple Silicon
- BoxLite Python SDK installed and working **on the right interpreter**.
  In `(base)` conda env, that's `python`, not `python3`:
  ```bash
  which python python3        # show paths
  pip -V                       # show which python pip targets
  python -c "import boxlite; print(boxlite.__version__)"
  # → 0.8.x
  ```

  > ⚠️ `python3` on macOS with miniforge often falls through to
  > `/usr/bin/python3` (system Python, no boxlite). Use `python` to match
  > the conda env that `pip` writes to.

- If `from boxlite import Boxlite, BoxOptions` raises ImportError, rebuild
  the native extension (compiled `.so` is out of sync with source):
  ```bash
  cd sdks/python && unset CONDA_PREFIX && pip install -e .
  ```
  The PoC script falls back to `from boxlite.boxlite import ...` so this
  step is **optional** but recommended.

### Run

```bash
cd /Users/lilongen/github/boxlite
python apps/infra-local/poc/single_service.py
```

### What it does

1. **Phase A**: get or create a box named `boxlite-local-pg-poc`
   (`postgres:16-alpine`, host port 5432 → guest 5432, mem 512 MiB).
2. **Phase B**: start the box.
3. **Phase C**: poll `pg_isready` inside the box until it succeeds
   (≤ 60 s, 30 retries × 2 s).
4. **Phase D**: open a raw TCP connection from the host to
   `127.0.0.1:5432` — proves gvproxy port forwarding works.
5. **Phase E**: wait 30 s and re-probe both checks — proves stability.
6. **Phase F**: dump `box.info()` (state / pid / cpus / memory / image).
7. **Phase G**: run real SQL (`CREATE TABLE` + `INSERT` + `SELECT`) via
   in-box `psql`.

### Expected result

```
======================================================================
✅ ALL CHECKS PASSED — dogfood approach is FEASIBLE
======================================================================

Box is still running. Inspect it:
  boxlite-cli list
  boxlite-cli exec boxlite-local-pg-poc -- psql -U postgres -c 'SELECT * FROM dogfood;'
```

The box is left running (`auto_remove=False`). You can poke at it manually
with `boxlite-cli` or just leave it.

### Cleanup

```bash
python apps/infra-local/poc/single_service.py --cleanup
```

Stops the box, removes it, wipes `~/.boxlite-local-poc/pg-data/`.

### Pass criteria checklist

- [ ] Box starts within 30 s (Phase A + B)
- [ ] `pg_isready` returns 0 inside the box (Phase C)
- [ ] Host can TCP-connect to 127.0.0.1:5432 (Phase D)
- [ ] Both checks still pass 30 s later (Phase E)
- [ ] `CREATE TABLE` + `INSERT` + `SELECT` work via in-box `psql` (Phase G)
- [ ] Memory reported by `box.info()` is ~512 MiB

### Failure debugging

| Symptom | Likely cause | Fix |
|---|---|---|
| `Image not found: postgres:16-alpine` | BoxLite OCI puller can't reach Docker Hub | Verify network; try `boxlite-cli image pull postgres:16-alpine` directly |
| Box starts but exits immediately | Entrypoint / cmd handling issue | Inspect `boxlite-cli logs boxlite-local-pg-poc` |
| `pg_isready` never returns 0 | Daemon stability inside microVM | Check stdout/stderr of postgres; maybe `PGDATA` volume permission issue |
| Host TCP fails | gvproxy not forwarding | Confirm BoxLite's gvproxy is running; ports already in use? |
| `ImportError` even after fallback | SDK version too old | Reinstall: `cd sdks/python && pip install -e .` |
| `ModuleNotFoundError: No module named 'boxlite'` | `python` and `pip` are different interpreters (typical conda + macOS gotcha) | Run with `python` (not `python3`), or `python -m pip install boxlite` first |

---

## Phase 1 — Multi-service + host-as-hub

**Goal**: prove that **multiple BoxLite boxes can coexist** and that one
box can reach another via the host-as-hub network model (boxes talk to
each other through `192.168.127.1:<host_port>`).

**Topology**:
```
Host
  ├─ pg-poc      (postgres:16-alpine, :5432, detach=True)
  ├─ redis-poc   (redis:7-alpine,    :6379, detach=True)
  └─ client-poc  (alpine:3.20, cmd=sleep infinity, no ports)
       └─ from inside, probe + query both services via 192.168.127.1
```

### Run

```bash
# Optional: clean Phase 0 state for a fresh start
python apps/infra-local/poc/single_service.py --cleanup

# Run Phase 1
python apps/infra-local/poc/multi_service.py
```

### What it does (12 phases)

- A/B/C: start postgres, redis, client (all `detach=True`)
- D/E: wait until pg + redis healthy
- F: host TCP probes (sanity, same as Phase 0)
- G: install `psql` + `redis-cli` + `nc` inside client box (apk add, ~15-25s)
- H: client-box `nc -zv 192.168.127.1:{5432,6379}` — TCP reachability
- I: client-box `psql` → postgres via host-as-hub (real query, with timing)
- J: client-box `redis-cli PING` → redis via host-as-hub (with timing)
- K: cross-service real write/read (redis SET/GET + postgres CREATE/INSERT/SELECT)
- L: all 3 boxes asserted in RUNNING state

### Verify detach (run in a NEW shell after Phase 1 finishes)

```bash
python apps/infra-local/poc/multi_service.py --verify-detach
```

If `detach=True` actually works, this prints:
```
✓ boxlite-local-pg-poc:     state=running, pid=...
✓ boxlite-local-redis-poc:  state=running, pid=...
✓ boxlite-local-client-poc: state=running, pid=...
✅ detach=True WORKS — all 3 boxes survived Python exit
```

### Cleanup

```bash
python apps/infra-local/poc/multi_service.py --cleanup
```

Stops + removes all 3 boxes + wipes `~/.boxlite-local-poc/`.

### Pass criteria checklist

- [ ] All 3 boxes start (cold ≤ 60s, reuse ≤ 5s)
- [ ] Phase H: `nc -zv 192.168.127.1:5432` and `:6379` both connected
- [ ] Phase I: `psql` from client box returns "dogfood works" row
- [ ] Phase J: `redis-cli PING` returns PONG
- [ ] Phase K: SET/GET and CREATE/INSERT/SELECT work via host-as-hub
- [ ] `--verify-detach` (run in fresh Python invocation) all 3 RUNNING

### What we learn from this phase

| Outcome | Implication for orchestrator design |
|---|---|
| ✅ host-as-hub works,延迟可接受 | Adopt host-as-hub; no need for box-to-box DNS extension |
| ❌ box → 192.168.127.1:port 不通 | Need to add box-to-box networking via BoxLite SDK extension, blocker |
| ✅ detach=True 经 fresh create 生效 | Orchestrator only needs to handle "reuse with config drift" edge case |
| ❌ detach=True 仍被忽略 | Major design hit — must always recreate boxes, lose state on every up |

---

## Next phases (not yet implemented)

| Phase | Scope | Status |
|---|---|---|
| 0 | Single service (postgres) | ✅ done |
| 1 | Two services + host-as-hub box-to-box | ✅ script ready, run pending |
| 2 | 5 services + topo order + healthcheck | not started |
| 3 | Full 10 boxes + Caddy + Jaeger UI | not started |
| 4 | Lima runner integration + e2e box create | not started |

Each phase only kicks off after the previous passes; if Phase 0/1 reveals
deal-breakers (e.g. BoxLite can't keep a daemon alive, or host-as-hub
doesn't work), we abandon the dogfood path and stick with docker-compose.

---

## Decision gate

After running Phase 0, record findings in
`docs/apps/own-dog-food-local-infra-solution.md` §9 ("Risks and open
questions") and update the decision in §0 / §11.
