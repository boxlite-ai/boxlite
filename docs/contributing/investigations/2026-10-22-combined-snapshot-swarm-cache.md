# Combined snapshot, Swarm and cache acceptance

> **Update 2026-10-23:** the F3–F5 snapshot prototype and the combined E scenario were
> removed in favor of organization-scoped snapshots
> ([#2087](https://github.com/boxlite-ai/boxlite/pull/2087)).
> Their code, guides and make targets no longer exist; this report is kept as a record.

## Design

F5 now supplies explicit immutable snapshot copying between runners. Reuse the
qualified F2 Swarm probe's real placement, bidirectional VIP/DNSRR, IPVS/VXLAN and
ingress assertions; change only its Box lifecycle through a test scenario helper.
The helper creates a Docker image Box, modifies its system disk, takes S, copies
S to the second runner using the Python SDK, and deletes the source. Both Swarm
nodes cold-start from their respective copies with distinct local cache IDs.

Reuse the F6 `docker-cache.sh` fixture and its ext4 loop-backed overlay2 profile.
Before Swarm, each node builds an image containing a different unique marker.
After cross-node ingress and bidirectional checks, each leaves Swarm, stops Docker
normally, unmounts and releases its cache through native Box deletion. A later
snapshot child on each owner exclusively mounts the same cache, inspects the
existing image before any pull/build, runs with `--pull=never`, then demonstrates
COPY/RUN build-cache hits with unchanged image ID. Both later engines must report
Swarm inactive; active cluster state is not claimed portable.

No production migration state machine or scheduler semantics change. Cache IDs
do not force placement: snapshot ownership does. Normal probe mode retains its
existing behavior. All failures retain guest/cache IDs and logs before cleanup;
forwarders close and test-only scheduling controls are restored. Readiness checks
have deadlines. The test uses two local runner processes on one physical Mac.

If combining the already qualified Docker cache entrypoint with Swarm exposes a
daemon configuration defect, retain the failing unmodified-fixture run first,
then fix the fixture and repeat. Such work belongs to F6, continuing its existing
seven rounds; F2 assertions must not be weakened to accommodate it. F5 failures
would continue the F5 ledger instead.

## Results and failure evidence

**E PASS**, `make test:runner-ci:combined`, exit 0 in F6 round 9. Evidence is
`.apps-local/feature-acceptance/2026-10-22-f5-copy/f6-round9-combined.log` and
`.apps-local/runner-acceptance/combined-swarm-different-runners-69065f61.json`
with its full `-guest.log`. This actual SDK/API/runner/guest path starts from one
filesystem point, copies it to the second runner and uses four distinct cold
guest boot IDs (two Swarm nodes and two later cache consumers).

| Assertion | Result | Evidence |
| --- | --- | --- |
| System disk point | PASS | Marker, mode 0640, modified motd and removed issue file in every child; source changed and removed after snapshot |
| Independent Docker caches | PASS | Separate runner/cache paths and leases, initially absent images, actual 2 GiB ext4 backing files, overlay2 and containerd roots |
| M1/M2/M3 | PASS | Ready/Active engines on different runners; four directed VIP/DNSRR pairs by service name and correct unique marker |
| M4/M6/D10 | PASS | External SDK tunnel to node A returns backend B; task constraints, overlay inspection and live VXLAN/IPVS counters |
| Sequential reuse | PASS | After leaving Swarm, orderly daemon shutdown, native deletion and lease release, each new Box retains its own image ID/content; pull-never succeeds and COPY/RUN are CACHED |
| Daemon state | PASS | Reused Engines report Swarm inactive; active cluster membership is not silently reused |
| Cleanup | PASS | All successful-run Boxes, snapshots and caches removed; failed round-8 resources retained stopped |

Node A: Box `2rW4yLqml3Gx`, runner `4b8c8467-2a7c-4044-8a19-53c20794443b`,
Swarm `plud0gcx3ht8ad0m3g4qixvei`, address `10.77.0.1`. Node B:
`YL6Q9mSTc2JH`, runner `17dcb9ae-cffc-4403-8eca-cbfe595a8248`, Swarm
`o63z3wkz3qz7ih3dn1axusgl3`, address `10.77.0.2`.
The VPN is guest IP transport over an SDK TCP tunnel, not a service HTTP proxy;
it requires the live forwarding client. Both runners are on one physical Mac.

### F6 round 8: the unmodified recipe fails combined DNS

Base `cd991b12` plus the new test; `docker-cache.sh` and all production code are
unchanged from the qualified seven-round state. Hypothesis: the existing cache
profile works with Swarm as-is. `make test:runner-ci:combined` exits 2; M1/D10
pass, then the default VIP assertion expects `10.0.0.6` but DNS returns
`backend-vip-1.localdomain → 198.18.0.34`. Guest and Docker DNS configuration
confirm an inherited search suffix. No mock or change to VIP mode is involved.

Scene: `f6-round8-scene/` under the feature log directory, including unchanged
recipe, unfinished patch, identifiers and complete guest/network/storage logs.
`make test:runner-ci:swarm-diagnose` exits 0 before cleanup; then
`make test:runner-ci:swarm-stop` exits 0, saves a second scene and stops the VMs.
Boxes `z7VvXOaTmU45` and `xspmsZwIFwq6`, snapshots and caches remain in the
recorded runner homes. Cache IDs are `combined-swarm-different-runners-3b1cae30-a`
and `...-b`. No Docker data directory or failure disk was discarded.

### F6 round 9: fixed DNS search profile

Set Docker `dns-search` to `["."]`, matching F2's already qualified service-name
configuration; record the setting in cache profile format 2. No network feature
is disabled, and original VIP/DNSRR/ingress assertions remain unchanged. Old
profiles are rejected before mounting; use a new cache ID. The same combined
target exits 0. `make test:runner-ci:docker-cache` also exits 0 with record
`docker-cache-8f37fe6822`, rechecking V4/V5, exact live/crashed lease conflicts,
ext4 recovery and profile-mismatch refusal with unchanged image bytes. Log:
`f6-round9-docker-regression.log`. Thus the earlier failure is corrected rather
than skipped; no F2 or F5 production fix was needed for E.

Run each make command separately. Native rebuilds still require the qualified
firmware override documented in the [F5 report](2026-10-22-f5-copy-qualification.md).
Use `make fmt:swarm` and `make lint:runner-ci` for the combined fixture.
The full task's F3 remains MOCK_PASS only; this path restores no RAM/process state.
