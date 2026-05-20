# [SDK Bug] `host.boxlite.internal` / `HOST_IP` configured but not wired — box cannot reach the host machine

> Issue source: dogfood discovery via `apps/infra-local/poc/multi_service.py` + `diagnose_network.py` (2026-05-20)
> Status: needs triage
> Priority: P1 (blocks dogfood-based local dev infra)
> Discovered by: lile (michael.li@polygala.ai)

---

## Summary

BoxLite gvproxy config defines `HOST_IP = "192.168.127.254"` and DNS zone `host.boxlite.internal → 192.168.127.254`, but **inside a running box, neither resolves nor connects to the Mac host**. This breaks the documented "from box, reach the host machine" pattern (the BoxLite equivalent of Docker's `host.docker.internal`).

Only by going through the Mac's real LAN IP (e.g. `192.168.1.110`) can a box reach a service that BoxLite has port-forwarded to the host — and this only works because the macOS network stack reroutes packets sent to its own external IP back to loopback. The intended `host.boxlite.internal` shortcut is dead.

---

## Reproduction Steps

**Prereq**: BoxLite Python SDK ≥ 0.8.2 installed.

```bash
cd /path/to/boxlite

# Start two boxes — one server (pg), one client.
python apps/infra-local/poc/multi_service.py
# This will FAIL at Phase H — that's the bug.

# In a separate shell, run diagnostic on the still-running client box:
python apps/infra-local/poc/diagnose_network.py > /tmp/diag.txt
cat /tmp/diag.txt
```

The diagnostic prints DNS lookups and `nc -zv` probes from inside `boxlite-local-client-poc`, targeting:

- `host.boxlite.internal:5432` (the documented hostname)
- `192.168.127.254:5432` (`HOST_IP` constant)
- `192.168.127.1:5432` (`GATEWAY_IP` — control)
- `<Mac LAN IP>:5432` (Mac's actual en0 IP — control)

Cleanup when done:
```bash
python apps/infra-local/poc/multi_service.py --cleanup
```

---

## Expected vs Actual

### Expected

From inside a box, any of these should reach a service that BoxLite has port-forwarded to the macOS host:

| Address | Expected |
|---|---|
| `host.boxlite.internal:5432` | ✅ connects |
| `192.168.127.254:5432` | ✅ connects |

### Actual

```
── 5. DNS lookups via getent / nslookup ──────────────────────────────
  getent hosts host.boxlite.internal               → ❌ (resolver does not know the name)
  getent hosts gateway.boxlite.internal            → ❌
  getent hosts google.com                          → ✅ 142.251.33.206  (so DNS forwarding works in general)

── 6. nc -zv -w 2 probes ─────────────────────────────────────────────
  ✗ host.boxlite.internal :5432  → "Name does not resolve"
  ✗ host.boxlite.internal :6379  → "Name does not resolve"
  ✗ 192.168.127.254       :5432  → "Operation in progress" (timeout)
  ✗ 192.168.127.254       :6379  → "Host is unreachable"
  ✗ 192.168.127.1         :5432  → timeout  (expected — gateway, not host)
  ✗ 192.168.127.1         :6379  → timeout
  ✓ 192.168.1.110         :5432  → "Connection ... succeeded!"   ← Mac LAN IP works
  ✓ 192.168.1.110         :6379  → "Connection ... succeeded!"
```

Full diagnostic log: see `apps/infra-local/poc/diagnose_network.py` output reproduction.

### Two Distinct Failure Modes

1. **DNS zone not served**: even though `gvproxy/config.rs:163-175` defines a DNS zone for `host.boxlite.internal`, the box's resolver (`192.168.127.1`) does not answer queries for it. Public names (e.g. `google.com`) resolve fine, so DNS forwarding is otherwise healthy.
2. **HOST_IP NAT not implemented**: connecting to the literal IP `192.168.127.254` times out / says "Host is unreachable". So even if DNS were fixed, the IP itself has no route.

---

## Root Cause Analysis

Configuration metadata is plumbed but the runtime path isn't:

| Layer | Status |
|---|---|
| `src/boxlite/src/net/constants.rs`<br>`HOST_IP = "192.168.127.254"`, `HOST_HOSTNAME = "host.boxlite.internal"` | ✅ defined |
| `src/boxlite/src/net/gvproxy/config.rs:142-160`<br>`host_ip: HOST_IP` field on `GvproxyConfig` | ✅ passed to gvproxy |
| `src/boxlite/src/net/gvproxy/config.rs:163-175`<br>`boxlite_internal_dns_zone()` builds DNS zone | ✅ built |
| gvproxy runtime — DNS server serves `host.boxlite.internal` to guests | ❌ does not happen (see #1) |
| gvproxy runtime — NAT rule: packets to `192.168.127.254` → Mac loopback / lo0 | ❌ does not happen (see #2) |

Likely either:

- (a) the DNS zone JSON is sent to gvproxy but gvproxy's libgvproxy-sys version doesn't honor extra zones beyond the default one, **or**
- (b) the `host_ip` field is sent but gvproxy treats it purely as informational — no NAT rule is injected, **or**
- (c) the gvproxy implementation expects a separate `gateway` vs `host_alias` mechanism that BoxLite never invokes.

Confirming which path is broken requires either:

- adding a unit/integration test that boots one box and asserts `getent hosts host.boxlite.internal` returns `HOST_IP` and `nc -z HOST_IP <forwarded_port>` succeeds, or
- inspecting the actual JSON sent to gvproxy at runtime and reproducing the same JSON against a vanilla `gvproxy` binary outside BoxLite.

---

## Proposed Fix

1. **Service-level test**: in `src/boxlite/src/net/gvproxy/` or the integration tests, add a test that starts two boxes (server with port forward + client) and asserts the client can reach the server via `host.boxlite.internal:<host_port>`. This guards against future regressions.

2. **DNS**: ensure `boxlite_internal_dns_zone()` is actually loaded into the gvproxy DNS resolver. If `libgvproxy-sys` is the limiting factor, vendor a fix or upstream a PR.

3. **NAT**: ensure `192.168.127.254` is registered as a NAT rule in gvproxy that translates back to the Mac's loopback (so the guest can connect to any port-forwarded service on the host).

4. **Doc**: once fixed, document `host.boxlite.internal` in the SDK README as the canonical "reach the host from inside a box" address (mirror Docker's `host.docker.internal` docs).

---

## Impact

This bug **blocks the natural dogfood architecture** of `apps/infra-local/` — running BoxLite control-plane services as BoxLite boxes (instead of docker containers):

- Caddy box → cannot reach api host process via `host.boxlite.internal:3000`
- Caddy box → cannot reach minio/dex/jaeger/pgadmin/registry-ui boxes via their host-forwarded ports
- PgAdmin box → cannot reach postgres box
- Registry-UI box → cannot reach registry box
- OtelCollector box → cannot reach api host process
- Any future service inside a box that needs to call another in-box service

Workaround exists (Mac LAN IP) but is fragile — see next section.

This is also the first BoxLite SDK gap surfaced by "eat your own dogfood" — exactly the kind of feedback the principle is designed to surface.

---

## Workaround

Use the Mac's actual LAN IP. The orchestrator can auto-detect it:

```python
import subprocess

def get_mac_lan_ip() -> str:
    for iface in ["en0", "en1", "en2"]:
        r = subprocess.run(
            ["ipconfig", "getifaddr", iface],
            capture_output=True, text=True, timeout=2,
        )
        if (ip := r.stdout.strip()) and ip.count(".") == 3:
            return ip
    raise RuntimeError("No Mac LAN IP — Wi-Fi off?")

mac_ip = get_mac_lan_ip()      # e.g. "192.168.1.110"
# Inject into each box's env: DB_HOST=mac_ip, REDIS_HOST=mac_ip, ...
```

### Caveats

| Caveat | Impact |
|---|---|
| Mac IP changes when joining new Wi-Fi network | Need to recreate all boxes (or re-inject env) |
| Wi-Fi off / no network → no IP | Local dev breaks entirely |
| Different Mac IPs across dev team | Service configs need per-machine override |
| Sometimes 2 IPs (en0 + en1) | Pick logic must be robust |

These are workable but ugly. The proper fix is wiring `host.boxlite.internal`.

---

## References

- **Constants**: `src/boxlite/src/net/constants.rs:23,31`
- **gvproxy config**: `src/boxlite/src/net/gvproxy/config.rs:142-175`
- **Test coverage gap**: `src/boxlite/src/net/gvproxy/config.rs:280+` (existing tests only verify the JSON shape, not runtime behavior)

### External Evidence

- PoC reproducer: `apps/infra-local/poc/multi_service.py` (Phase H fails)
- Diagnostic: `apps/infra-local/poc/diagnose_network.py`
- Design context: `docs/apps/own-dog-food-local-infra-solution.md` §3.1 (host-as-hub network model)
- Memory: `feedback_boxlite_python_sdk_gotchas.md` §7 (BoxLite network constants)

---

## Acceptance Criteria

- [ ] `python apps/infra-local/poc/diagnose_network.py` shows `host.boxlite.internal` resolving to `192.168.127.254`
- [ ] Same script shows `nc -zv 192.168.127.254 <forwarded_port>` succeeding
- [ ] Same script shows `nc -zv host.boxlite.internal <forwarded_port>` succeeding
- [ ] `python apps/infra-local/poc/multi_service.py` completes all 12 phases without changes (Phase H/I/J using HOST_GW = `host.boxlite.internal` directly)
- [ ] New integration test in `src/boxlite/src/net/` covers the host-from-guest happy path
