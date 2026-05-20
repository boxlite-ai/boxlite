---
# Linear issue fields — directly consumable by mcp__linear__save_issue.
# Source: docs/apps/sdk-feedback/01-host-boxlite-internal-unwired.md
# Workspace context queried 2026-05-20: team=Polygala (only team), no "Triage" state (closest = Backlog).

title: "[SDK Bug] `host.boxlite.internal` / `HOST_IP` configured but not wired — box cannot reach the host machine"
team: Polygala
state: Backlog              # source says "needs triage"; Polygala team has no Triage state — Backlog is closest.
priority: 2                 # 0=None, 1=Urgent, 2=High, 3=Medium, 4=Low. Source labels P1 (blocks dogfood local infra, not prod) → High.
labels:
  - Bug
assignee: me                # MCP accepts literal "me"; source's "Discovered by: lile". Set to null to leave unassigned for triage.

# Fields left unset (fill during triage or before submitting):
# project:      <Linear projects could not be enumerated — list_projects failed under deprecated SSE transport. Re-query after migrating MCP to /mcp.>
# cycle:        <assign during triage>
# milestone:    <assign during triage>
# estimate:     <assign during triage; suggest 3–5 if 1-point Fibonacci is in use — touches gvproxy DNS + NAT + a new integration test>
# dueDate:      <unset>
# parentId:     <none>
# blockedBy:    <none>
# blocks:       <none — though dogfood work in apps/infra-local/ depends on this; add as blocks: relations after filing>
# relatedTo:    <none>

# Optional attachment links (the MCP `links` field is append-only).
# Repo URLs left as local paths because the GitHub org/visibility is not encoded in this repo.
# Fill in the org and uncomment before submission, or attach manually in the Linear UI.
# links:
#   - url: https://github.com/<org>/boxlite/blob/main/apps/infra-local/poc/multi_service.py
#     title: "PoC reproducer — apps/infra-local/poc/multi_service.py"
#   - url: https://github.com/<org>/boxlite/blob/main/apps/infra-local/poc/diagnose_network.py
#     title: "Diagnostic — apps/infra-local/poc/diagnose_network.py"
#   - url: https://github.com/<org>/boxlite/blob/main/src/boxlite/src/net/constants.rs
#     title: "Host network constants — src/boxlite/src/net/constants.rs"
#   - url: https://github.com/<org>/boxlite/blob/main/src/boxlite/src/net/gvproxy/config.rs
#     title: "gvproxy config — src/boxlite/src/net/gvproxy/config.rs"

description: |
  > Source doc: `docs/apps/sdk-feedback/01-host-boxlite-internal-unwired.md`
  > Discovered: 2026-05-20 via dogfood (apps/infra-local/poc/multi_service.py + diagnose_network.py)
  > Reporter: lile (michael.li@polygala.ai)

  ## Summary

  BoxLite gvproxy config defines `HOST_IP = "192.168.127.254"` and a DNS zone `host.boxlite.internal → 192.168.127.254`, but **inside a running box, neither resolves nor connects to the Mac host**. This breaks the documented "from box, reach the host machine" pattern (the BoxLite equivalent of Docker's `host.docker.internal`).

  Only by going through the Mac's real LAN IP (e.g. `192.168.1.110`) can a box reach a service that BoxLite has port-forwarded to the host — and this only works because the macOS network stack reroutes packets sent to its own external IP back to loopback. The intended `host.boxlite.internal` shortcut is dead.

  ## Reproduction

  **About `multi_service.py`** (not yet in the repo — lives in the dogfood PoC at `apps/infra-local/poc/`): a smoke test that starts three BoxLite boxes — `boxlite-local-pg-poc` (postgres:16-alpine), `boxlite-local-redis-poc` (redis:7-alpine), and `boxlite-local-client-poc` (alpine:3.20) — and steps through ~12 phases verifying multi-box coexistence and the **host-as-hub** network model (one box reaches another box's service via a host-forwarded port). Phase H is the first phase that tries to use `host.boxlite.internal` as the host-hub address — that is where this bug surfaces. Sibling script `diagnose_network.py` runs the DNS / `nc -zv` probes from inside the still-running client box.

  **Prereq**: BoxLite Python SDK ≥ 0.8.2 installed.

  ```bash
  cd /path/to/boxlite

  # Start two boxes — one server (pg), one client. Fails at Phase H.
  python apps/infra-local/poc/multi_service.py

  # In a separate shell, run diagnostic on the still-running client box:
  python apps/infra-local/poc/diagnose_network.py > /tmp/diag.txt
  cat /tmp/diag.txt
  ```

  The diagnostic prints DNS lookups and `nc -zv` probes from inside `boxlite-local-client-poc`, targeting:

  - `host.boxlite.internal:5432` (documented hostname)
  - `192.168.127.254:5432` (`HOST_IP` constant)
  - `192.168.127.1:5432` (`GATEWAY_IP` — control)
  - `<Mac LAN IP>:5432` (Mac's actual en0 IP — control)

  Cleanup:
  ```bash
  python apps/infra-local/poc/multi_service.py --cleanup
  ```

  ## Expected vs Actual

  ### Expected

  From inside a box, both of these should reach a service that BoxLite has port-forwarded to the macOS host:

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

  ### Two distinct failure modes

  1. **DNS zone not served**: even though `gvproxy/config.rs:163-175` defines a DNS zone for `host.boxlite.internal`, the box's resolver (`192.168.127.1`) does not answer queries for it. Public names (e.g. `google.com`) resolve fine, so DNS forwarding is otherwise healthy.
  2. **HOST_IP NAT not implemented**: connecting to the literal IP `192.168.127.254` times out / says "Host is unreachable". So even if DNS were fixed, the IP itself has no route.

  ## Root cause analysis

  Configuration metadata is plumbed but the runtime path isn't:

  | Layer | Status |
  |---|---|
  | `src/boxlite/src/net/constants.rs` — `HOST_IP = "192.168.127.254"`, `HOST_HOSTNAME = "host.boxlite.internal"` | ✅ defined |
  | `src/boxlite/src/net/gvproxy/config.rs:142-160` — `host_ip: HOST_IP` field on `GvproxyConfig` | ✅ passed to gvproxy |
  | `src/boxlite/src/net/gvproxy/config.rs:163-175` — `boxlite_internal_dns_zone()` builds DNS zone | ✅ built |
  | gvproxy runtime — DNS server serves `host.boxlite.internal` to guests | ❌ does not happen (see #1) |
  | gvproxy runtime — NAT rule: packets to `192.168.127.254` → Mac loopback / lo0 | ❌ does not happen (see #2) |

  Likely either:

  - (a) the DNS zone JSON is sent to gvproxy but gvproxy's `libgvproxy-sys` version doesn't honor extra zones beyond the default one, **or**
  - (b) the `host_ip` field is sent but gvproxy treats it purely as informational — no NAT rule is injected, **or**
  - (c) the gvproxy implementation expects a separate `gateway` vs `host_alias` mechanism that BoxLite never invokes.

  Confirming which path is broken requires either:

  - adding a unit/integration test that boots one box and asserts `getent hosts host.boxlite.internal` returns `HOST_IP` and `nc -z HOST_IP <forwarded_port>` succeeds, or
  - inspecting the actual JSON sent to gvproxy at runtime and reproducing the same JSON against a vanilla `gvproxy` binary outside BoxLite.

  ## Proposed fix

  1. **Service-level test**: in `src/boxlite/src/net/gvproxy/` or the integration tests, add a test that starts two boxes (server with port forward + client) and asserts the client can reach the server via `host.boxlite.internal:<host_port>`. Guards against future regressions.
  2. **DNS**: ensure `boxlite_internal_dns_zone()` is actually loaded into the gvproxy DNS resolver. If `libgvproxy-sys` is the limiting factor, vendor a fix or upstream a PR.
  3. **NAT**: ensure `192.168.127.254` is registered as a NAT rule in gvproxy that translates back to the Mac's loopback (so the guest can connect to any port-forwarded service on the host).
  4. **Doc**: once fixed, document `host.boxlite.internal` in the SDK README as the canonical "reach the host from inside a box" address (mirror Docker's `host.docker.internal` docs).

  ## Impact

  Blocks the natural dogfood architecture of `apps/infra-local/` — running BoxLite control-plane services as BoxLite boxes (instead of docker containers):

  - Caddy box → cannot reach api host process via `host.boxlite.internal:3000`
  - Caddy box → cannot reach minio / dex / jaeger / pgadmin / registry-ui boxes via their host-forwarded ports
  - PgAdmin box → cannot reach postgres box
  - Registry-UI box → cannot reach registry box
  - OtelCollector box → cannot reach api host process
  - Any future service inside a box that needs to call another in-box service

  Workaround exists (Mac LAN IP) but is fragile — see below.

  This is also the first BoxLite SDK gap surfaced by "eat your own dogfood" — exactly the kind of feedback the principle is designed to surface.

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

  Caveats:

  | Caveat | Impact |
  |---|---|
  | Mac IP changes when joining new Wi-Fi network | Need to recreate all boxes (or re-inject env) |
  | Wi-Fi off / no network → no IP | Local dev breaks entirely |
  | Different Mac IPs across dev team | Service configs need per-machine override |
  | Sometimes 2 IPs (en0 + en1) | Pick logic must be robust |

  Workable but ugly. The proper fix is wiring `host.boxlite.internal`.

  ## References

  - Constants: `src/boxlite/src/net/constants.rs:23,31`
  - gvproxy config: `src/boxlite/src/net/gvproxy/config.rs:142-175`
  - Test coverage gap: `src/boxlite/src/net/gvproxy/config.rs:280+` (existing tests only verify JSON shape, not runtime behavior)
  - PoC reproducer: `apps/infra-local/poc/multi_service.py` (Phase H fails)
  - Diagnostic: `apps/infra-local/poc/diagnose_network.py`
  - Design context: `docs/apps/own-dog-food-local-infra-solution.md` §3.1 (host-as-hub network model)

  ## Acceptance criteria

  - [ ] `python apps/infra-local/poc/diagnose_network.py` shows `host.boxlite.internal` resolving to `192.168.127.254`.
  - [ ] Same script shows `nc -zv 192.168.127.254 <forwarded_port>` succeeding.
  - [ ] Same script shows `nc -zv host.boxlite.internal <forwarded_port>` succeeding.
  - [ ] `python apps/infra-local/poc/multi_service.py` completes all 12 phases without changes (Phase H/I/J using HOST_GW = `host.boxlite.internal` directly).
  - [ ] New integration test in `src/boxlite/src/net/` covers the host-from-guest happy path.
---
