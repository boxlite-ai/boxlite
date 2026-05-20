#!/usr/bin/env python
"""
Quick network diagnostic for the BoxLite host-as-hub problem.

Usage:
    # Assumes Phase 1 boxes are still running (detach=True survived).
    # If not, start them first:
    #   python apps/infra-local/poc/multi_service.py
    python apps/infra-local/poc/diagnose_network.py

What it does:
    Runs a battery of probes from inside the client box to figure out
    what addresses are actually reachable. Prints the truth, no guessing.

Probes (all from inside boxlite-local-client-poc):
    1. ip addr / ip route        — what does the box think its network is?
    2. cat /etc/hosts            — what's resolvable by name?
    3. cat /etc/resolv.conf      — what's the DNS config?
    4. getent / nslookup         — does host.boxlite.internal resolve?
    5. nc -zv probes:
        - host.boxlite.internal:5432 / 6379
        - 192.168.127.254:5432 / 6379  (HOST_IP)
        - 192.168.127.1:5432   / 6379  (GATEWAY_IP — should fail)
        - <Mac LAN IP>:5432 / 6379      (Mac's actual en0/en1 IP)
    6. curl http://1.1.1.1   — Internet via gvproxy works?
"""

from __future__ import annotations

import asyncio
import subprocess
import sys

try:
    from boxlite import Boxlite  # type: ignore[attr-defined]
except ImportError:
    from boxlite.boxlite import Boxlite  # type: ignore[attr-defined]


CLIENT_NAME = "boxlite-local-client-poc"


async def exec_collect(box, command, args=None):
    execution = await box.exec(command, args or [])
    out, err = [], []

    async def drain(stream, sink):
        async for chunk in stream:
            sink.append(chunk if isinstance(chunk, str) else chunk.decode("utf-8", "replace"))

    await asyncio.gather(
        drain(execution.stdout(), out),
        drain(execution.stderr(), err),
    )
    result = await execution.wait()
    return result.exit_code, "".join(out), "".join(err)


def get_mac_ip() -> str | None:
    """Best-effort: get Mac's en0/en1 IP for testing."""
    for iface in ["en0", "en1", "en2"]:
        try:
            r = subprocess.run(
                ["ipconfig", "getifaddr", iface],
                capture_output=True, text=True, timeout=2,
            )
            ip = r.stdout.strip()
            if ip and ip.count(".") == 3:
                return ip
        except Exception:
            pass
    return None


def header(text: str):
    print()
    print("=" * 70)
    print(f"  {text}")
    print("=" * 70)


def section(text: str):
    print()
    print(f"── {text} ".ljust(70, "─"))


async def main():
    runtime = Boxlite.default()

    try:
        box = await runtime.get(CLIENT_NAME)
    except Exception as e:
        print(f"❌ client box '{CLIENT_NAME}' not found: {e}")
        print("   Start Phase 1 first: python apps/infra-local/poc/multi_service.py")
        return 1

    mac_ip = get_mac_ip()
    header(f"Network diagnostic — from inside {CLIENT_NAME}")
    print(f"Mac LAN IP (en0/en1): {mac_ip or '(no IP found)'}")

    # ─── 1. ip addr ────────────────────────────────────────────────────
    section("1. ip addr show (interfaces inside the box)")
    _, out, _ = await exec_collect(box, "ip", ["addr", "show"])
    print(out.strip() or "(no output — `ip` may not be installed)")

    # ─── 2. ip route ───────────────────────────────────────────────────
    section("2. ip route (routing table)")
    _, out, _ = await exec_collect(box, "ip", ["route"])
    print(out.strip() or "(no output)")

    # ─── 3. /etc/hosts ─────────────────────────────────────────────────
    section("3. /etc/hosts")
    _, out, _ = await exec_collect(box, "cat", ["/etc/hosts"])
    print(out.strip() or "(empty)")

    # ─── 4. /etc/resolv.conf ───────────────────────────────────────────
    section("4. /etc/resolv.conf")
    _, out, _ = await exec_collect(box, "cat", ["/etc/resolv.conf"])
    print(out.strip() or "(empty)")

    # ─── 5. DNS lookups ────────────────────────────────────────────────
    section("5. DNS lookups via getent / nslookup")
    for host in ["host.boxlite.internal", "gateway.boxlite.internal", "google.com"]:
        _, out, err = await exec_collect(box, "getent", ["hosts", host])
        result = out.strip() or err.strip() or "(empty)"
        print(f"  getent hosts {host:35s} → {result}")

    # ─── 6. nc probes ──────────────────────────────────────────────────
    section("6. nc -zv -w 2 probes")
    targets = [
        ("host.boxlite.internal", 5432, "pg via hostname"),
        ("host.boxlite.internal", 6379, "redis via hostname"),
        ("192.168.127.254", 5432, "pg via HOST_IP"),
        ("192.168.127.254", 6379, "redis via HOST_IP"),
        ("192.168.127.1", 5432, "pg via GATEWAY_IP (should fail)"),
        ("192.168.127.1", 6379, "redis via GATEWAY_IP (should fail)"),
    ]
    if mac_ip:
        targets.append((mac_ip, 5432, f"pg via Mac LAN IP {mac_ip}"))
        targets.append((mac_ip, 6379, f"redis via Mac LAN IP {mac_ip}"))

    for host, port, label in targets:
        exit_code, out, err = await exec_collect(
            box, "nc", ["-zv", "-w", "2", host, str(port)],
        )
        line = (out + err).strip().replace("\n", " | ")
        status = "✓" if exit_code == 0 else "✗"
        print(f"  {status} {host:25s}:{port}  ({label})")
        print(f"       {line}")

    # ─── 7. outbound to Internet ──────────────────────────────────────
    section("7. outbound via gvproxy (Internet sanity)")
    exit_code, out, err = await exec_collect(
        box, "nc", ["-zv", "-w", "3", "1.1.1.1", "443"],
    )
    line = (out + err).strip().replace("\n", " | ")
    print(f"  {'✓' if exit_code == 0 else '✗'} 1.1.1.1:443  →  {line}")

    # ─── 8. Mac side: who's listening? ────────────────────────────────
    section("8. (Host side) Mac's listening ports")
    print("  Run on host (cmd+t):  lsof -nP -iTCP -sTCP:LISTEN | grep 5432")
    print("  ...or:                lsof -nP -iTCP:5432")
    print()

    header("Interpretation guide")
    print("""
  ✓ host.boxlite.internal AND 192.168.127.254 work
      → host-as-hub is feasible; use either in orchestrator.

  ✓ Mac LAN IP works, but 192.168.127.254 doesn't
      → HOST_IP is constant-only, NAT not implemented.
        Use Mac LAN IP via auto-detect (`ipconfig getifaddr en0`).
        Caveat: fragile (Mac IP changes / Wi-Fi off).

  ✗ Nothing works
      → Box-to-box via host is impossible with current BoxLite.
        Pivot: run all needing-to-talk services in ONE big box,
        or wait for BoxLite networking extension.
""")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
