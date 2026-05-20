---
# Linear issue fields — directly consumable by mcp__linear__save_issue.
# Brief variant of 01-host-boxlite-internal-unwired.linear.md (reproduce / root cause / workaround only).
# Source: docs/apps/sdk-feedback/01-host-boxlite-internal-unwired.md

title: "[SDK Bug] `host.boxlite.internal` / `HOST_IP` configured but not wired — box cannot reach the host machine"
team: Polygala
state: Backlog              # no Triage state on Polygala team; Backlog is closest.
priority: 2                 # 0=None, 1=Urgent, 2=High, 3=Medium, 4=Low.
labels:
  - Bug
assignee: me                # set to null to leave unassigned for triage.

description: |
  > Source doc: `docs/apps/sdk-feedback/01-host-boxlite-internal-unwired.md` (full write-up with impact, proposed fix, acceptance criteria)
  > Discovered: 2026-05-20 via dogfood (`apps/infra-local/poc/`)
  > Reporter: lile (michael.li@polygala.ai)

  ## TL;DR

  BoxLite gvproxy defines `HOST_IP = 192.168.127.254` and a DNS zone `host.boxlite.internal → 192.168.127.254`, but **from inside a box, neither resolves nor connects to the Mac host**. The intended "box → host" shortcut (BoxLite's analog to Docker's `host.docker.internal`) is dead.

  ## How to reproduce

  Prereq: BoxLite Python SDK ≥ 0.8.2.

  `multi_service.py` (not yet in the repo — dogfood PoC at `apps/infra-local/poc/`) starts three boxes (postgres / redis / alpine client) and steps through phases verifying the **host-as-hub** network model. `diagnose_network.py` runs DNS and `nc -zv` probes from inside the client box.

  ```bash
  python apps/infra-local/poc/multi_service.py       # fails at Phase H (the first phase that uses host.boxlite.internal)
  python apps/infra-local/poc/diagnose_network.py    # DNS + nc probes from inside the client box
  ```

  From inside the client box:

  | Probe | Result |
  |---|---|
  | `getent hosts host.boxlite.internal` | ❌ not found (yet `google.com` resolves fine — DNS forwarding works) |
  | `nc -zv 192.168.127.254 5432` | ❌ "Host is unreachable" / timeout |
  | `nc -zv <Mac LAN IP> 5432` | ✅ succeeds — the only working path |

  ## Root cause

  Config metadata is plumbed end-to-end, but the gvproxy *runtime* never honors it:

  | Layer | Status |
  |---|---|
  | `src/boxlite/src/net/constants.rs` — `HOST_IP`, `HOST_HOSTNAME` defined | ✅ |
  | `src/boxlite/src/net/gvproxy/config.rs:142-175` — `host_ip` field + `boxlite_internal_dns_zone()` passed to gvproxy | ✅ |
  | gvproxy DNS resolver — serves `host.boxlite.internal` to guests | ❌ |
  | gvproxy NAT — packets to `192.168.127.254` → Mac loopback | ❌ |

  Likely one of:

  - (a) `libgvproxy-sys` doesn't honor extra DNS zones beyond the default,
  - (b) `host_ip` is sent but treated as informational — no NAT rule injected, or
  - (c) gvproxy expects a `host_alias` mechanism that BoxLite never invokes.

  ## Current workaround

  Detect the Mac's en0/en1 LAN IP at runtime and use it as the host-hub address. It works because BoxLite port-forwards bind to `0.0.0.0` on the Mac and macOS reroutes packets sent to its own external IP back to loopback.

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

  Fragile: Mac IP changes on Wi-Fi network switch, dies if Wi-Fi is off, differs per dev machine, sometimes two en* IPs exist. Acceptable until the SDK bug is fixed; not acceptable long-term.
---
