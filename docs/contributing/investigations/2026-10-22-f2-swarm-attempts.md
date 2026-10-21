## TL;DR

F2 passes at round 9 after the user removed the original six-round limit.

## Details

Base `dcc15340`; macOS arm64; two local runner processes. Private logs and patches:
`.apps-local/feature-acceptance/2026-10-22-f2-f6/`. Each round below records the
symptom, hypothesis, change and command result. No feature is qualified by a build.

### F2 round 1 — firmware configuration rejected

- Hypothesis: enabling built-in IPVS and VXLAN plus conntrack netlink supplies
  the missing Swarm kernel primitives.
- Change: extend `scripts/build/dind-kernel.config`; reuse F1's actual firmware
  builder and packaging path.
- `PATH=/opt/homebrew/bin:$PATH make kernel:dind` exits 2. Log:
  `f2-r1-kernel-build.log`; builder `TiKAvoaBsS1Z` retained in runtime home `qk`.
- Failure: `Kconfig refused NF_CONNTRACK_NETLINK`. All other requested symbols
  survived dependency resolution. The symbol is actually `NF_CT_NETLINK` in
  [Linux 6.12 Kconfig](https://github.com/torvalds/linux/blob/v6.12/net/netfilter/Kconfig#L352).
- No guest Swarm test ran; existing F1 firmware was not replaced.

### F2 round 2 — correct conntrack symbol and qualify the booted kernel

- Replace only the invalid symbol with `NF_CT_NETLINK`, which selects
  `NETFILTER_NETLINK`. Reuse the retained builder's pinned source tree.
- Planned: rebuild, package through `make dev:runner-ci`, restart the isolated
  runners, then execute real single-node and multi-node Swarm assertions.
- Firmware build and packaging exit 0. Image SHA256:
  `f4edee8b4803f4d3800583d7ec3e5b713200874dc78776955a30f838d1e10bf7`.
  Restarted both isolated runners. `make test:runner-ci:swarm TOPOLOGY=single`
  exits 2 (`f2-r2-single.log`): ingress recreation raced asynchronous deletion,
  returning `network with name ingress already exists`.
- Guest `WlOtqSmoGwT1` retained; scene `swarm-single-499bb9a1`. The actual guest
  successfully creates a VXLAN link and IPVS service, and reports Ready/Active
  Swarm node `ji9t48w8h1ummd9zyyggt46si`. Service traffic was not reached.

### F2 round 3 — await ingress removal

- Hypothesis: Docker acknowledges deletion before network state disappears.
  Add bounded polling of actual network absence before recreating ingress;
  retain the configured 1200-byte overlay MTU and all traffic assertions.
- Command: `make test:runner-ci:swarm TOPOLOGY=single`, log `f2-r3-single.log`.
- Exit 2, guest `BFZgO9XVp844`, scene `swarm-single-af7052bf`. D3/D10 pass;
  service tasks run, but BusyBox nslookup appends `.localdomain` and receives an
  external address. Absolute-name diagnosis resolves the real VIP, then HTTP
  to that VIP fails with connection refused. IPVS tables are empty.
- `f2-r3-{diagnosis,iptables-diagnosis}.log` distinguish the DNS observation from
  the actual dataplane failure. Dockerd cannot install `MARK --set-mark`; the
  guest lacks uppercase `libxt_MARK.so` although iptables is installed. The
  lowercase extension survives. Host case-insensitive image extraction is a
  suspected cause, not an established runtime fix. Direct dockerd also bypassed
  the official DinD mount initialization; some netns handles were invalid.

### F2 round 4 — restore guest prerequisites and official DinD initialization

- Reinstall both iptables packages inside guest ext4, restoring their complete
  extension sets; assert both case-distinct MARK files. Reuse the pinned image's
  official dockerd entrypoint (as F1 does), retaining Unix-only daemon access.
  Set DNS search to `.` so the service-name diagnostic cannot leak into an
  external search suffix. No firewall, VIP, overlay or ingress feature is disabled.
- Command: `make test:runner-ci:swarm TOPOLOGY=single`, log `f2-r4-single.log`.
- Exit 2, guest `CZzmtgkzU2GT`, scene `swarm-single-77f377fa`. VIP DNS and real
  HTTP 200/marker now pass. Evidence collection fails because it enters every
  netns filename, including a stale placeholder from deleted ingress.
  `f2-r4-diagnosis.log` shows the current overlay's VXLAN and IPVS FWM 256 with
  nonzero connection/packet counters. No service or firewall assertion was bypassed.

### F2 round 5 — inspect the active network identity

- Hypothesis: stale deleted-network placeholders are not live netns handles.
  Derive the current overlay namespace from its actual network ID and inspect it
  in dockerd's mount namespace. Assert actual VXLAN and nonzero VIP connection
  counters; also check DNSRR resolves the target task's real overlay address.
- Commands: separate `make test:runner-ci:swarm TOPOLOGY=...` runs for single,
  same-runner and different-runners, stopping to diagnose any failure.
- Single exits 2 (`f2-r5-single.log`): guest `SQ3b6FcxjYjd`, scene
  `swarm-single-f244c39b`, returns correct VIP HTTP 200/marker and has live VXLAN,
  but immediately sampled IPVS counters are zero. Later diagnosis shows FWM 257
  with one connection and six packets. The stricter evidence assertion exposed
  a timing assumption; neither HTTP nor VIP configuration was changed.

### F2 round 6 — await observable IPVS counters

- Hypothesis: IPVS counters need time to become observable after the HTTP request.
  Poll actual counters with a 30-second deadline; keep the nonzero assertion and
  current-network VXLAN inspection. Continue the same full topology matrix.
- Commands: independent `make test:runner-ci:swarm TOPOLOGY=single`,
  `TOPOLOGY=same-runner`, `TOPOLOGY=different-runners` invocations, logs
  `f2-r6-{single,same-runner,different-runners}.log`.
  This is the final allowed F2 round; any failure ends implementation attempts.
- Single exits 2 (`f2-r6-single.log`). D3/D4/D5/D6/D10 pass, including actual
  VIP HTTP 200, DNSRR task-IP resolution and HTTP, VXLAN and nonzero IPVS counters.
  D7 stops at the API's existing inbound guard: Box creation omitted explicit
  inbound enablement, so `box.network.tunnel(18080)` is refused. This is a fixture
  omission, not a demonstrated ingress dataplane failure.
- Guest `xbg1qrdeWV8P`, node `9prbn2gw597owufnre15g55ht`, scene
  `swarm-single-e199610b`, retained. `f2-r6-scene/` contains source/config copies,
  the record, guest log and firmware checksums. D8/D9 and both multi-node
  topologies are NOT_RUN. **6/6 used; stop F2 without enabling inbound or retrying.**

### F2 round 7 — explicitly enable the existing inbound contract

- User removed the round limit; numbering continues. Revision `d42037b3` plus
  the fixture change. Runtime, API and firmware are unchanged.
- Failure: round 6 reached the API inbound guard before outside HTTP.
  Hypothesis: explicit `NetworkSpec(inbound=InboundNetworkSpec(mode="enabled"))`
  permits the existing authenticated SDK tunnels to reach guest published ports.
- Change: set that option during Box creation; retain every traffic assertion.
- Commands: separate `make test:runner-ci:swarm TOPOLOGY=single`, then
  `TOPOLOGY=same-runner` and `TOPOLOGY=different-runners`, with per-topology logs
  `f2-r7-*.log`. Record failures before proceeding with a new hypothesis.
- Single exits 2: `ConnectionResetError` on D7. Scene
  `swarm-single-537be025`, Box `Yvb1r3VarAnn`, preserved in `f2-r7-scene/`.
  `make test:runner-ci:swarm-transport` diagnoses guest ingress HTTP 200 with
  the expected marker on both loopback and guest IP. Corrected diagnosis exits
  0 in `f2-r7-transport-corrected.log` (initial diagnostic used `uri` as a
  property instead of the SDK method). The published URI points at port 28080,
  the other local stack's proxy; CONNECT receives an inbound-disabled refusal
  from that stack. This excludes a demonstrated guest ingress dataplane failure.

### F2 round 8 — isolate the real port proxy

- Hypothesis: the qualification stack inherited the ordinary local stack's
  proxy domain but never started its own proxy. Its API/runner and proxy
  therefore disagree about Box ownership and inbound authorization.
- Change: build/start the existing `apps/proxy` on 14000 against API 13001,
  override the API proxy domain/key, include the owned proxy in restart/health
  checks. No new service proxy or guest traffic bypass is introduced.
- Commands: `make dev:runner-ci:proxy`, `make test:runner-ci:infra ACTION=restart`,
  followed by separate Swarm topology runs, logs `f2-r8-*.log`.
- Build/restart exit 0; single exits 2, same CONNECT refusal. Transport diagnosis
  confirms the corrected 14000 URI and guest HTTP 200. Direct authenticated
  preview API reports `enabled`. The Go proxy's `godotenv.Overload` reads
  `apps/.env`, replacing the isolated proxy key with the ordinary stack's key;
  its 401 lookup becomes a closed inbound verdict. Scene `swarm-single-978a6902`,
  Box `O5NEuuCKsUTW`, preserved in `f2-r8-scene/`.

### F2 round 9 — prevent ordinary-stack dotenv overrides

- Hypothesis: the proxy's working directory, rather than guest networking,
  overrides its correct process environment. Start it in the isolated state
  directory, which contains no `.env`; keep API/runner cwd unchanged.
- Change: optional process cwd, used only by the isolated proxy. Add bounded
  tunnel setup and record actual URI in Swarm evidence.
- Commands: `make test:runner-ci:infra ACTION=restart`, then each Swarm topology
  separately, logs `f2-r9-*.log`. Existing ingress/VIP assertions remain intact.
- Single exits 0, `swarm-single-7d7e0f67{.json,-guest.log}`: all D3–D10 pass,
  including outside ingress/host publication and guest host-network HTTP 200.
  Successful Box removed. Same-runner and different-runner checks follow.
- Same-runner exits 0, `swarm-same-runner-2dfed9e3{.json,-guest.log}`. Both
  guests join Ready/Active with distinct tunnel/node IDs; every directed VIP
  and DNSRR pair returns its target's unique marker. Ingress through the node
  without the backend task succeeds. M1–M4/M6 pass; successful guests removed.
- Different-runners exits 0, `swarm-different-runners-d2c55971{.json,-guest.log}`.
  The same strict M1–M4/M6 assertions pass with each guest on its independently
  identified runner. M5 passes across both recorded topologies. Successful
  guests removed. Both runner processes are on the same physical Mac.
