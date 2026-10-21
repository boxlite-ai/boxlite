## TL;DR

Historical round-6 failure report; see the later
[qualification](2026-10-22-f2-swarm-qualification.md) and continuing attempt record.

## Details

Everything below describes the preserved round-6 state, before the user removed
the attempt limit. It is not the current acceptance verdict.

Base `dcc15340`, macOS arm64, two local runner processes on one physical Mac.
See the [design](2026-10-22-f2-f6-resumption.md) and
[six-round record](2026-10-22-f2-swarm-attempts.md).

The firmware build now enables builtin IPVS TCP/UDP, RR/WRR/SH, conntrack,
xtables IPVS/u32 and VXLAN. The actual packaged kernel, not an unused vendor
configuration, creates IPVS services and VXLAN links and carries single-node
Swarm HTTP traffic. No automatic multi-sandbox networking capability is advertised.
The guest OpenVPN setup remains an unexecuted acceptance fixture, not a qualified
network deployment. Existing TCP tunnel and privileged-guest APIs are reused.

### Environment and observed results

| Component | Actual value |
| --- | --- |
| Guest kernel | Linux 6.12.87-boxlite-dind, aarch64 |
| Firmware Image SHA256 | `f4edee8b4803f4d3800583d7ec3e5b713200874dc78776955a30f838d1e10bf7` |
| Firmware kernel.c SHA256 | `69d74bf9b791312a7fb896c0bb5974e6537c6c53ed5d4536b7d18509ee6cbf02` |
| Docker / Compose / Buildx | 27.5.1 / 2.33.0 / 0.20.1 |
| Storage | Classic overlay2, guest ext4, `/var/lib/docker` |
| Additional guest packages | iproute2 6.11.0-r0, ipvsadm 1.31-r3, OpenVPN 2.6.20-r0; installed but VPN not exercised |
| Image | docker:27.5.1-dind digest `ad9e28ccfdf76cf44248258090e07d8353b9628725d8a716bab176bd71200d7d` |
| Inner image | busybox:1.37.0 digest `bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e` |
| Runner A / B | ports 13003 / 13004; distinct runtime homes `qa` / `qb`, same host |

| ID | Result | Evidence / remaining issue |
| --- | --- | --- |
| D3 | PASS | Init; node Ready/Active |
| D4 | PASS | User overlay, constrained client/backend tasks, expected replicas and HTTP |
| D5 | PASS | Default VIP; service inspect, VIP DNS, HTTP 200/unique marker, nonzero IPVS counters |
| D6 | PASS | Separate DNSRR network/services; DNS equals backend task IP; HTTP 200/unique marker |
| D7 | FAIL | Ingress service config/task pass, but API refuses external tunnel because inbound is disabled |
| D8, D9 | NOT_RUN | Stopped after D7; host publish and guest host networking unqualified |
| D10 | PASS | Actual VXLAN creation, active overlay VXLAN and IPVS service/counters |
| M1–M4, same runner | NOT_RUN | Final round stopped before topology execution |
| M1–M4, different runners | NOT_RUN | Two runners exist; no cross-runner Swarm test ran |
| M5, M6 | NOT_RUN | Neither multi-node topology or cross-node evidence qualified |
| Combined E | BLOCKED | F2 and complete F6 remain incomplete |

Decisive log: `.apps-local/feature-acceptance/2026-10-22-f2-f6/f2-r6-single.log`.
Detailed commands: `.apps-local/runner-acceptance/swarm-single-e199610b-guest.log`.
The JSON beside it records Box `xbg1qrdeWV8P`, runner
`4b8c8467-2a7c-4044-8a19-53c20794443b`, Swarm node
`9prbn2gw597owufnre15g55ht`, and single-node address `192.168.127.2`.
That duplicate NAT address is not a proposed multi-node communication address.

### Reproduction, failure scene and next step

```bash
make kernel:dind
BOXLITE_LIBKRUNFW_SOURCE="$PWD/.apps-local/runner-acceptance/firmware" make dev:runner-ci
make test:runner-ci:infra ACTION=restart
make test:runner-ci:swarm TOPOLOGY=single
```

Each command runs separately. Build and restart exit 0; the final test exits 2.
Expected: outside HTTP via the SDK tunnel reaches the ingress service. Actual:
`InvalidStateError: Box ... has inbound access disabled; enable inbound access
before opening a tunnel`. The API enforces this in
`apps/api/src/boxlite-rest/boxlite-proxy.controller.ts`; the fixture omitted
the explicit inbound network option. No proxy, DNSRR or host publication bypass
was substituted. A newly authorized round must enable the existing inbound
contract, then run D7–D9 and both topologies with the same strict assertions.

`f2-r6-scene/` under the private log directory holds the exact test/config source,
JSON, guest log and firmware hashes. Generated firmware remains in
`.apps-local/runner-acceptance/firmware/`; guest disks stay in runner home `qa`.
No failure disk was deleted. Earlier scenes and diagnostics remain named by
round in the attempt record. Private logs may contain Swarm join credentials;
only this redacted summary is committed.

After preserving these scenes, all five failed Swarm guests were stopped through
the API; subsequent reads confirmed `stopped`. Their disks remain available.
F1's real Docker/Compose regression on this firmware exits 0 in
`regression-f1-dind.log`. Build, formatting and fixture lint also pass; those
checks do not change F2's incomplete acceptance result.

Confirmed causes include one invalid Kconfig symbol, asynchronous ingress removal,
missing uppercase xtables extensions, stale removed-network netns placeholders,
and immediately sampled zero IPVS counters. Reinstalling the iptables packages
inside ext4 restores both case-distinct extensions; case-insensitive host image
extraction remains a hypothesis requiring separate investigation. Do not describe
that preparation step as a general image-extraction fix. Production runtime
networking was not rewritten. Only the kernel additions exercised by the passing
single-node checks are retained; multi-node setup is explicitly experimental.
