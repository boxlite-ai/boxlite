# BoxLite gradual-rollout (canary) architecture

> The recurring question — "how do we canary the runner? what about the DB?" —
> has no single answer because **"gradual rollout" is 4 different problems with 4
> different mechanisms.** This doc lays out each layer, what exists, what's missing,
> and the rollback story. A dashboard (SST Console / CloudWatch / Grafana) is the
> *eyes* for all of them — it is not itself a rollout engine.

## The 4 layers (do not conflate)

```
Layer            What changes            Gradual mechanism              Rollback
──────────────────────────────────────────────────────────────────────────────────────────
1 Feature        app behavior (UI/API    PostHog flag 5%→50%→100%       flip flag off (instant,
                 logic the user sees)     (deploy ≠ release)             no redeploy)
2 Cloud/API      ECS service (new image) rolling OR ECS CodeDeploy      CodeDeploy auto-rollback
                                          canary (traffic 10%→100%)      on alarm; or redeploy
                                                                         last-good image digest
3 DB schema      Postgres schema         expand-contract migrations     forward-only (never
                                          (additive → deploy → cleanup)  down-migrate prod)
4 Runner binary  boxlite-runner on EC2   canary across a runner FLEET   per-runner atomic swap
                 (stateful, runs boxes)   (roll 1 → observe → rest)      auto-rollback + drain
```

The two EASY layers (1, 3) are largely designed already; the two HARD layers
(2 traffic-canary, 4 runner-fleet-canary) are the real gaps.

---

## Layer 1 — Feature rollout (PostHog flags)  [easiest; partly planned]

**Mechanism:** decouple *deploy* (code on prod, flag OFF = dark) from *release*
(flip the flag to 5% → 50% → 100% of users). Out-of-band of the deploy pipeline.

**Why it's the workhorse:** most "gradual rollout" needs are actually *feature*
rollout, and this gives instant rollback (flip the flag — no redeploy, no infra).

**Status:** in the plan (`00a-最终态-发布流程` §6). To make real: wire PostHog flags
into Api + dashboard, gate new features behind `flags.X`. Mostly app work.

**Use this whenever you can** — pushing risk to the feature-flag layer means the
infra layers (2/4) can stay simple (deploy fully, reveal gradually).

---

## Layer 2 — Cloud/API canary (ECS)

**Today:** SST deploys ECS services with a *rolling* update (min/max tasks) + ALB
health checks. New tasks must pass health before old ones drain. That's a basic
safety net, NOT a traffic-percentage canary.

**To get true canary (traffic 10% → 50% → 100% with auto-rollback):**
- Add **AWS CodeDeploy blue/green for ECS**: it stands up the new task set, shifts
  a configurable % of ALB traffic, watches CloudWatch alarms, and auto-rolls-back
  if an alarm fires. This is the AWS-native canary engine.
- Cost/complexity: a CodeDeploy app + deployment group + alarms per service. Real
  but bounded. SST exposes the ECS service; wiring CodeDeploy is extra IaC.

**Pragmatic recommendation:** don't build CodeDeploy canary yet. For API changes,
**Layer 1 (flags) + rolling deploy + a post-deploy smoke gate** covers ~all risk:
deploy fully (dark), smoke-test, reveal via flags. Add CodeDeploy only for changes
that can't be flag-gated (e.g., a risky infra/runtime change) and where you want
traffic-% control + alarm auto-rollback.

**Eyes:** ALB target health + 5xx rate + p99 latency (CloudWatch/Grafana); the SST
Console "Updates" view for "what this deploy changed."

---

## Layer 3 — DB schema gradual (expand-contract)  [designed; partly built]

**The rule (Fowler expand-contract), never break-change prod:**
```
pre-deploy   EXPAND   add column/table/index, backward-compatible (old code still works)
   ↓
deploy       new code reads/writes the new shape (old shape still present)
   ↓ (healthy, observed)
post-deploy  CONTRACT remove the old column/table after nothing uses it
```
**Forward-only:** never run a `down` migration on prod (data loss). Roll *forward*
with a new migration if needed.

**Status:** designed in N4 (`feat/migrations-off-boot`): `apps/api/src/migrate.ts`
is a compiled migration runner (off-boot, runs as an explicit ECS RunTask step),
with `pre-deploy` / `post-deploy` phases. Partly built (the runner compiles; the
pre/post ECS RunTask wiring is the remaining work). This is the right design.

**Danger to track:** "ran EXPAND, forgot CONTRACT" → permanent debt. Track open
contracts in the release manifest.

**Eyes:** migration applied/pending list (the migrate runner logs it); row counts /
error rates after expand.

---

## Layer 4 — Runner binary canary  [the real gap; not built]

This is the one the question keeps returning to. The runner is **stateful**
(`/var/lib/boxlite` + live krun VMs), so you can't just replace it.

**Why "canary" is impossible today:** there is ONE runner (`boxlite-runner-default`).
A fleet of one cannot be canaried — rolling its binary = rolling the whole fleet.

**What a real runner canary needs (3 pieces):**
```
A. A FLEET ≥2 runners
   sst.config.ts already supports RUNNERS>1 (extra runners, each its own token +
   protect+ignoreChanges). So: run e.g. 2-3 runners.

B. Canary-aware scheduling in the control plane (Api)
   Today the Api schedules a box to "a" runner. For canary you need it to:
     · mark one runner `canary` (running the new binary)
     · route a SLICE of new boxes to the canary (by % or by opt-in), the rest to stable
     · expose per-runner success/health so you can compare canary vs stable
   This is a CONTROL-PLANE feature to build (weighted/labelled scheduling). It is
   the largest missing piece.

C. The rollout orchestration (mostly exists)
   scripts/deploy/runner-update-binary.sh already does the atomic, per-instance
   swap: download+checksum → backup → swap → restart → health-check → AUTO-ROLLBACK.
   Canary = run it against the CANARY runner only (pin by instance id), observe,
   then run it against the rest. Plus DRAIN before swapping a runner that hosts boxes
   (mark unschedulable → let boxes finish/migrate → swap).

**Rollout flow (target state):**
```
1. drain canary runner (unschedulable; existing boxes finish)
2. swap binary on canary only (runner-update-binary.sh, instance-pinned)
3. control plane routes N% of NEW boxes to canary
4. observe canary vs stable (box create success, exec errors, crash rate)  ← needs the eyes
5. healthy → roll the rest (drain+swap each, concurrency=1 per host)
   unhealthy → script auto-rolls-back canary; stable fleet untouched
```

**Interim (before B is built):** a coarse "canary-by-runner" — put the new binary on
ONE runner, send *new* boxes there first (manual/weighted), watch it, then promote.
Even without true %-routing, a 2-runner setup lets you blast-radius-limit a bad binary
to one runner instead of all.

**Eyes:** per-runner box-create success rate, krun VM crash rate, runner systemd
health, `runner-rollout` logs. (SSM + CloudWatch today; SST Console shows the EC2
resources but not box-level health — box metrics are our own telemetry.)

---

## What to build, in order (cheapest risk-reduction first)

```
1. Feature flags (Layer 1) — biggest bang/effort; pushes most risk off infra. [app work]
2. Post-deploy smoke gate (Layer 2 lite) — deploy→smoke→reveal; no CodeDeploy yet.
3. Finish expand-contract DB (Layer 3) — the migrate.ts pre/post ECS RunTask wiring (N4).
4. Runner fleet ≥2 + coarse canary-by-runner (Layer 4 interim) — blast-radius limit.
5. (later) control-plane weighted scheduling (Layer 4 full) + CodeDeploy canary (Layer 2 full).
```

## The honest framing for the team

- "Gradual rollout" is mostly **feature flags** (Layer 1) — do that first, it's cheap
  and gives instant rollback.
- **DB** is a discipline (expand-contract), already designed — finish wiring it.
- **Runner canary** is a real feature (fleet + scheduling), not a tool you turn on —
  the interim "2 runners + canary-by-runner" gets 80% of the safety for little work.
- A **dashboard** (SST Console / CloudWatch / Grafana) is the **eyes** for all four;
  it does not *do* any of the rollouts. Don't expect adopting a console to "give us
  canary" — canary is the architecture above.
