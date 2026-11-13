## TL;DR

Expansion grows capacity only; provisioned IOPS/throughput never follow, diluting IOPS-per-GiB per expansion. This design grows them in the same `disks.update`: proportional, ceiling-clipped, changed-fields-only, capacity never waiting for performance.

## Status

**Status:** Accepted (2026-11-13). Fixes [boxlite#2614](https://github.com/boxlite-ai/boxlite/issues/2614). This file is the in-repo copy; the design's registered home is [issue #2614](https://github.com/boxlite-ai/boxlite/issues/2614).

## Problem

- Infra provisions each data disk with explicit values (200 GiB / 3,600 IOPS / 240–290 MiB/s, `DATA_DISK` in `apps/infra/mdeploy/stack/providers/gcp/runners.ts`) and sets `ignoreChanges` on the three fields. Pulumi never touches them, so the API is the only performance writer.
- The API expansion path (`runner-disk-expansion.service.ts` → `gcp-disk-client.ts`) sends `paths: ['sizeGb']` only. The field-mask invariant protects the current performance values from being reset, but never raises them.
- After each expansion the same provisioned IOPS serve a larger volume. IOPS-per-GiB drops one step per expansion, and the data disk drifts toward becoming the bottleneck for image-cache and `/var/lib/boxlite` workloads — the opposite of what an expansion is for.

## GCP facts (verified against official docs, 2026-11-13)

| Fact | Value / rule |
| --- | --- |
| One update for size + IOPS + throughput | Supported, and GCP recommends it |
| Capacity budget (Hyperdisk Balanced) | At most 2 per 4-hour window |
| IOPS budget | Once per 4 hours |
| Throughput budget | Once per 4 hours, **independent cooldown from IOPS** (Balanced/HA only) |
| Effect | Asynchronous zone operation; up to ~15 minutes to take effect |
| Per-disk IOPS ceiling | `MIN(500 × GiB, 160,000)` (scales at 500/GiB below 320 GiB) |
| Per-disk throughput ceiling | `MIN(2,400, P/4)`, `P` = the new provisioned IOPS (throughput couples to IOPS) |
| Throughput floor | `MAX(140, P/256)` MiB/s |
| IOPS floor | 3,000 |
| Default formula | `IOPS = 6×GiB + 3,000`, `throughput = min(2,400, 1.5×GiB + 140)` — **computed once at creation** |
| Billing | First 3,000 IOPS and 140 MiB/s free; beyond that, billed by provisioning |
| SDK | @google-cloud/compute@7.9.0 exposes `IDisk.provisionedIops`/`provisionedThroughput` (int64-as-string, same as `sizeGb`); the update request takes a `paths` field mask |

## Scope

- Constraints: no runner changes; no API/SDK contract changes; capacity sizing math (`nextSizeGiB`) unchanged; the existing gray-release switch and budget framework stay; the `paths` field-mask invariant holds (never a full PATCH).
- Non-goals: VM-machine-level caps (an n4-standard-16 draws at most 80k IOPS / 1.2k MiB/s shared) do not participate in ceiling math — that is a cost/SLO gap, not a correctness boundary (rejected alternative, see Related work). No performance read-back verification. No configurable ratio.
- Acceptance: one call carries capacity + performance; capacity is never blocked by a performance cooldown; ceiling binding is visible through a metric; a rejected performance field converges to capacity-only within one round without a retry loop.

## Related work

| Method | Basis | Trade-off | Stance |
| --- | --- | --- | --- |
| GCP-recommended combined update | modify-hyperdisks: "We recommend that you modify size and performance at the same time" | Saves calls and operation polling; the cost is misaligned field budgets (see How it works) | **Adopt**, with the performance-rides gate |
| AWS Elastic Volumes / ModifyVolume | size + iops + throughput in one async call, per-volume modification budget (up to 4 per 24h) | Same shape as GCP; validates "bundle + budgets + async confirm" as the industry-standard form | Adopt (corroboration) |
| Terraform provider field-mask pitfall | hashicorp/terraform-provider-google issue: updating both iops+throughput mis-builds the payload/mask | Confirms the `paths` invariant tests must pin all four shapes (size-only / both perf fields / single perf field / never a full PATCH) | Adopt (lesson) |
| Recompute from GCP's default formula | official default performance formula | Infra deliberately sits below it (3,600 < 4,200; throughput held to what the machine draws: "more is billed and never reached"); recomputing from the formula silently over-bills | **Rejected** |
| Record creation-time baselines, never read the disk | Saves one `disks.get` | Manual gcloud or future infra changes would drift silently; reading the disk before each PATCH (≤20 per round) costs nothing | **Rejected** |
| Ceiling includes VM machine caps | n4-standard-16 = 80k IOPS / 1.2k MiB/s shared | Mirroring a machine-type table in the API is disproportionate; the disk-level ceiling already bounds correctness; the beyond-VM part is "billed but never drawn" | **Rejected** |
| Skip performance entirely when the target crosses the ceiling | Ultra-conservative: capacity-only when target > ceiling | A ceiling "true change" is a documented-valid value; skipping loses one performance generation at the crossing round; rejection protection comes from the fallback path, not from skipping | **Rejected** |
| Scale performance from observed workload utilization | Adaptive provisioning: measure actual IOPS/throughput draw, provision to demand | Hosts report no IOPS/throughput telemetry today — reading it means a new runner reporting contract this change must not add; disk-space samples are the only utilization signal | **Rejected** for this iteration; revisit once real utilization data exists |
| No change | — | Leaves the issue's core complaint unsolved; per-GiB performance keeps diluting | Rejected |

## How it works

One line: each expansion request reads the disk for the real baseline, computes proportional targets, clips them to the ceiling; if the performance cooldown has elapsed the fields ride the same PATCH, otherwise capacity goes alone — capacity never waits for performance.

### Expansion formula (complete definition)

Applies to Hyperdisk Balanced at ≥ 6 GiB (4/5 GiB disks have fixed IOPS ranges of 2,000/2,500 and the formula does not apply; our disks start at 200 GiB, always inside the range).

```
Inputs (each initiate):
  curGiB   ← disks.get().sizeGb               // device scale, not the runner-reported fs scale
  newGiB   ← toGiB                             // the requested device size (nextSizeGiB output)
  curIops  ← disks.get().provisionedIops
  curTput  ← disks.get().provisionedThroughput  // MiB/s

Guard:
  curGiB missing or ≤ 0, or curIops/curTput missing
    → undefined: skip performance entirely (size-only + WARN), never guess a baseline.

Ceiling/floor functions (at capacity = newGiB, from GCP docs):
  IOPS_MAX(newGiB)  = min(500 × newGiB, 160000)      // saturates at 160000 from 320 GiB up
  IOPS_MIN          = 3000
  TPUT_MAX(iops)    = min(2400, iops / 4)             // MiB/s; uses the clipped target IOPS
  TPUT_MIN(iops)    = max(140, iops / 256)            // MiB/s

Targets (proportional = the creation slope stays constant; slope from live disk values):
  iopsSlope    = curIops / curGiB    // infra baseline: 3600/200 = 18 IOPS/GiB
  tputSlope    = curTput / curGiB    // infra baseline: 240..290/200 = 1.2 ~ 1.45 MiB/s/GiB
  iopsTarget   = min(max(round(iopsSlope × newGiB), curIops), IOPS_MAX(newGiB))
  tputTarget   = min(max(round(tputSlope × newGiB), curTput), TPUT_MAX(iopsTarget))
  ceilingHit   = (max(round(iopsSlope × newGiB), curIops) > IOPS_MAX(newGiB))
              or (max(round(tputSlope × newGiB), curTput) > TPUT_MAX(iopsTarget))

Sending (per-field: only changed values):
  send IOPS        iff iopsTarget ≠ curIops, value = iopsTarget
  send throughput  iff tputTarget ≠ curTput, value = tputTarget
  neither changes → size-only; ceilingHit is reported either way
```

Scale feel (target line vs ceiling line, concrete numbers):

| newGiB | Target IOPS (18/GiB) | Ceiling IOPS_MAX | Ceiling binds? |
| --- | --- | --- | --- |
| 250 | 4,500 | 125,000 | no |
| 400 (default cap = 2× baseline) | 7,200 | 160,000 | no |
| 500 | 9,000 | 160,000 | no |
| ~8,889 (≈8.7 TB) | 160,000 | 160,000 | yes (theoretical crossing, beyond every realistic config) |

Throughput likewise: the target line at 1.2–1.45 MiB/s/GiB reaches the 2,400 ceiling only at ~2 TB. The target line deliberately does not chase the ceiling: chasing it would bill 157,000 IOPS at 500 GiB while an n4-standard-16 draws at most 80,000 — half the money buys performance the VM cannot reach; the proportional rule keeps performance cost linear with capacity, and the existing cap bounds the total.

Rule notes:

1. **Rounding**: round to integer. GCP documents no increment step for IOPS/throughput; SDK fields are int64; no artificial step.
2. **max before min, order fixed**: under any baseline GCP could legally hold, the ceiling is monotone in size (curGiB ≤ newGiB implies IOPS_MAX(curGiB) ≤ IOPS_MAX(newGiB)), so a legal current value never exceeds the new ceiling and the two orders are equivalent. The fixed order is defensive: if the documented ceiling constants ever shrink (doc drift), a once-legal baseline can end up above the new ceiling, and max-before-min pulls it back to the legal ceiling in one request instead of preserving an unsendable value (same-value and over-ceiling both 400) — the performance fields would otherwise deadlock at size-only forever. Sending that lowered value is intentional repair: lowering provisioned values is a GCP-permitted operation (only size cannot decrease).
3. **Only-up**: under a valid baseline the max step guarantees target ≥ current; with ratio ≤ 1 (degenerate config) raw ≤ current, the target equals current, the field drops out, size-only — covered naturally.
4. **Floor compliance (why the formula has no floor branch)**: IOPS — a valid baseline (curIops ≥ 3,000) keeps the target ≥ 3,000 (max step ≥ current; min step at worst pulls to IOPS_MAX ≥ 3,000). A broken baseline below 3,000 → GCP rejects → fallback path, no proactive lifting. Throughput — proportional scaling preserves the curTput/curIops ratio; a baseline ratio ≥ 1/256 satisfies the floor automatically (infra ratios 240/3600 = 1/15 and 290/3600 ≈ 1/12.4 both qualify). A broken ratio → GCP rejects → fallback. No non-proportional "lift to the floor" rule.
5. **ceilingHit**: true when the proportional target (after the max step) exceeds the ceiling. Metric-only; does not affect sending.

### Worked example (applying the formula)

200 GiB / 3,600 IOPS / 240 MiB/s disk, water level triggers growth to 300 GiB:
1. initiate reads the real values: sizeGb=200, iops=3,600, throughput=240 (device scale, unaffected by the ext4 ~2% gap).
2. ratio = 300/200 = 1.5 → target IOPS = round(3,600×1.5) = 5,400; throughput = round(240×1.5) = 360.
3. Ceiling: max IOPS = MIN(500×300, 160000) = 150,000 (not reached); max throughput = MIN(2,400, 5,400/4) = 1,350 (not reached). All in range, send as computed.
4. If the performance cooldown (any performance-carrying attempt within 4h + 10 min margin) is active → send `paths: ['sizeGb']` only; performance rides the next round.
5. Confirmation unchanged: zone operation DONE + the runner-reported fs size passes the tolerance → CONFIRMED. Performance fields ride the same operation, no separate confirmation; the "~15 min to take effect" gap is implicitly re-checked by the next initiate's `disks.get`, which also logs the values for observability.

### Key mechanisms

**Capacity first, performance rides (concern 1: misaligned budgets).** GCP budgets: capacity 2 per 4h; IOPS once per 4h; throughput once per 4h with a cooldown independent from IOPS. Bundling blindly lets a performance cooldown reject a capacity expansion — capacity is the urgent, water-level-driven need (a full disk breaks workloads), performance is a quality need. The gate: bundle only when the performance cooldown has elapsed; otherwise send size-only; performance lags at most one 4h cycle. The ledger writes `performanceUpdated=true` on every performance-carrying attempt regardless of outcome — one rule, no branches: a rejection (400 or rate limit) also starts the cooldown, so the next round converges to capacity-only and no every-minute 400/429 retry loop can form.

**Ceiling + per-field changed-values-only (concern 2: hitting the ceiling).** Clip before sending against the new capacity (MIN(500×GiB, 160k) / MIN(2,400, P/4)); clipping is a normal path, not an error — GCP should not reject an in-ceiling value. Ceiling binding means performance has hit the disk's ceiling while capacity keeps growing and per-GiB performance dilutes again — emit `runner_disk_perf_ceiling_total{field}` counter + WARN log (structured attributes) for metric-based alerting; a field dropped as unchanged still counts, visibility does not depend on sending. What is sent: a ceiling "true change" (current < ceiling ≤ proportional target) is a documented-valid value ("You can specify up to 160,000 IOPS") and is sent to pull performance to the top. A field whose clipped target equals its current value is **not sent**: same-value sends are unreliable — the sibling size field has proof GCP 400s on "must be larger", performance fields are likely the same, and at minimum one 4h performance cooldown burns for nothing while a rejection would drag the bundled capacity change down with it. Neither perf field changing → size-only. Only-up needs no separate branch: a target below current (ratio < 1, degenerate config) equals "field not sent", naturally.

**Ceiling visibility.** Default config never binds the ceiling (the target line crosses the ceiling line at ~8.7 TB, see the scale-feel table); it is a defensive boundary against manually boosted baselines or very large explicit caps.

**Fallback paths.** If GCP still rejects a performance field (baseline below the floor, doc drift, a manually broken baseline), the existing `not_accepted` path applies — FAILED + ERROR log (hits the existing severity≥ERROR alarm), `performanceUpdated=true` makes the next round size-only; capacity loses at most one round and no loop forms. A missing `disks.get` baseline (undefined) likewise degrades to size-only + WARN; we never guess a baseline.

**Proportional rule, measured baseline (concern 3: how much to grow).** Capacity +20% → IOPS/throughput +20% (before clipping), per-GiB performance constant — that is the point of expanding. The baseline comes from `disks.get`, not GCP's default formula (infra deliberately sits below it; the formula would silently over-bill) and not local bookkeeping (manual changes would drift). Billing: provisioned performance is billed beyond the free allowance; proportional scaling keeps performance cost linear with capacity, and the existing relative cap (default 2× baseline) bounds the total.

### Secondary changes

- `GcpDiskClientLike` gains `getDisk(ref)` → `{ sizeGb, provisionedIops?, provisionedThroughput? }`; `resizeDisk(ref, sizeGb, performance?)` takes performance per-field optional; `paths` assembles from the actually-changed fields across 4 shapes: `['sizeGb']`, `['sizeGb','provisionedIops','provisionedThroughput']`, `['sizeGb','provisionedIops']`, `['sizeGb','provisionedThroughput']`; values int64-as-string. Invariant tests pin all 4 shapes: paths is always an explicit non-empty subset, never a full PATCH.
- Pure function `performanceTarget(curIops, curTput, curGiB, newGiB)` → `{ iops?, throughput?, ceilingHit } | undefined`: field-level optional — a field whose clipped target equals its current value returns missing (not sent); undefined means missing baseline (skip performance entirely); ceilingHit feeds the ceiling metric.
- Config: **zero new knobs**. Performance scaling rides the existing `RUNNER_DISK_EXPANSION_ENABLED` master switch — no separate switch, no ratio knob (ratio fixed at 1.0; no knob without a user). The cooldown constant 4h + 10 min margin is a code constant, in the style of `RATE_LIMIT_COOLDOWN_MS`, not config.
- Migration: pre-deploy migration adds `performanceUpdated boolean NOT NULL DEFAULT false` to `runner_disk_expansion`; one row in the schema.md table.
- Observability: ceiling counter + initiate log attributes carry the baseline and targets read that round (iops/throughput from/to) — the only immediate visibility until the next read-back.

## Validation

| Claim / risk | Check | Expected |
| --- | --- | --- |
| One call carries capacity + performance | Unit tests pin request shapes (4 paths shapes, int64-as-string) | Constant shapes, never a full PATCH |
| Capacity never blocked by the performance cooldown | Service integration test: second expansion within 4h sends sizeGb only | Second PATCH paths = sizeGb only |
| Proportional + ceiling math | Pure-function unit tests: ratio, MIN clipping, throughput P/4 clip, unchanged-field drop, undefined on missing baseline | All boundaries pass |
| Same-value never sent | Pure-function test: IOPS target clipped to current → field missing, paths without provisionedIops | No unchanged fields sent |
| Baseline boosted past the new ceiling | Pure-function test: curIops > IOPS_MAX → target = IOPS_MAX (a lowered repair value), field still sent | Baseline pulled back legally, no deadlock |
| Single perf field change | Pure + client tests: only IOPS changes → paths has provisionedIops, not provisionedThroughput | All 4 paths shapes pinned |
| Rejected performance converges | Service test: bundled 400 → next round size-only, ERROR log, no loop | One-round convergence |
| disks.get failure never blocks capacity | Service test: read throws → size-only PATCH still sent + WARN | Capacity proceeds |
| Rate-limit path does not regress | Existing rate_limited tests pass unchanged | Zero behavior drift |
| Pre-existing disk compatibility | Missing baseline (undefined) path | size-only + WARN, no crash |

## Left for later (not in this issue)

- Measured re-verification of the 2-per-4h capacity budget and 1-per-4h performance budget (doc wording confirmed 2026-11-13; real-disk back-to-back verification stays a pre-gray-release item inherited from #2530).
- Ceiling boundary real-disk check: on the test-bed disk (eric-kvm-data-200) use gcloud to set IOPS/throughput to value-range boundaries (current → ceiling true change, same-value resend) once each, confirming GCP accepts boundary values and what it does with same-value sends.
- Stage gray release: enabling `RUNNER_DISK_EXPANSION_ENABLED` now includes performance scaling (no separate switch); after the first real expansion, read provisioned values back once with gcloud for manual cross-check.
