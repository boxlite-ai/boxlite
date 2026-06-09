# Task12B — Admin Diagnose UX: real online E2E observability loop — GOAL / CHARTER

> **Status:** GOAL draft (audit-grounded). NOT yet the bite-sized TDD task plan.
> After sign-off, each phase below is expanded into `superpowers:writing-plans` task steps.
> **For executors:** implement via `superpowers:executing-plans` / `subagent-driven-development`, TDD per step, commit frequently.

**Goal:** Make the Task12B observability loop *actually closed online* — `api / runner / ec2_host / box → OTel Collector → ClickHouse Cloud → ClickStack / Admin API → Admin UI / human API / AI Agent` — verified with live evidence, consumable by both a human Admin and an AI Agent, with no secret leakage and no schema-broken deploys.

**Worktree:** `/Users/brian/1-Home/1-Code/4-Learn/boxlite-task12b-admin-diagnose-ux`
**Branch:** `codex/task12b-admin-diagnose-ux`
**Never touch:** `/Users/brian/1-Home/1-Code/4-Learn/boxlite` (MVP worktree, different branch `codex/mvp-sandbox-template-journey`, contains NONE of this code).

---

## 0. Hard constraints

- No secrets in code/tests/logs/screenshots/reports. Admin key lives in env/keychain only.
- No direct DB DDL until a **read-only** schema audit + written plan + confirmation that the dev fix is acceptable.
- No blind deploy. Every deploy is gated by a schema/migration audit first.
- Agent path: Admin API only, header `X-BoxLite-Source: agent`; never hit ClickHouse/ClickStack/CloudWatch/S3 directly.
- Heavy build/test/deploy go through `boxlite-remote-worker` (boxlite-dev). Local AWS profile `boxlite` IS usable (preflight confirmed) — but keep heavy ops on remote per policy.
- Work ONLY in the task12b worktree. Confirm every edit lands there (`git -C <worktree> status`).

---

## 1. Audit-corrected facts (DO NOT "fix the wrong thing")

The pasted brief overstated several things. Verified against the worktree (file:line):

| # | Pasted claim | Verified reality | Evidence |
|---|---|---|---|
| C1 | Box has no OTel rows / daemon sends no traces | **Refuted.** Daemon (`apps/daemon`, Go) wires logs+metrics+**traces**; trace exporter is correct. Real gap = daemon produces **zero spans** except per-request `otelgin` server spans after `/init`. | `apps/daemon/pkg/toolbox/telemetry.go:66/113/122`; `apps/common-go/pkg/telemetry/tracing.go:42` `otlptracehttp.New`; grep `tracer.Start` across daemon = EMPTY; spans only at `server.go:134` |
| C2 | Box logs uncorrelatable | **Partial refute.** `/logs?sandboxId` matches box logs via `ServiceName='sandbox-<id>'`. They vanish in `investigate` only because it AND-injects a dot-namespaced `boxlite.org_id` clause box logs can't satisfy (box emits `boxlite_organization_id`, underscore). | `observability.service.ts:1801-1817` (ServiceName clause); `:1316-1325` (orgId injection); `:287/352/411` AND-join; daemon `telemetry.go:51` underscore attr |
| C3 | Release gate: image deployed needing new schema while `RUN_MIGRATIONS=false` | **Not reproducible from committed config.** SST sets `NODE_ENV=production` AND `RUN_MIGRATIONS='true'`; boot gate `runMigrations \|\| !production` = TRUE; boot glob `migrations/**` recursive → post-deploy migs DO run on boot. Failure must come from an **operational override** or post-deploy migration never applied to dev DB. | `app.module.ts:83-84`; `configuration.ts:15/18`; `sst.config.ts:327/330` |
| C4 | Repair script is safe to run | **Has a bug.** `task12b-dev-schema-repair.mjs` only renames `image→template`; if dev column is currently `snapshot` (the actual error state) it ADDS an empty `template` column instead of renaming. Untracked, never applied. Must NOT run as-is. | script lines 79-83, 205, 221-227 |
| C5 | xLog should be non-zero | **xLog=0 is expected.** No producer writes `boxlite.execution_id/job_id` onto a LOG record; interceptor sets them only on SPANS; exec routes use `:execId` not `executionId`; exec output is proxied passthrough, never persisted. | `observability.service.ts:1402` gate; `observability-context.interceptor.ts:30/47`; `boxlite-proxy.controller.ts:53` |
| C6 | UI has Diagnose + Platform Telemetry tabs | **Refuted.** Only 3 tabs: overview/people/fleet. "Platform Telemetry" is embedded in Overview; "Diagnose" is a Sheet drawer from row buttons. | `adminNavigation.ts:6`; `AdminOverviewView.tsx:186`; `AdminTelemetryDrawer.tsx` |
| C7 | Agent smoke covers reverse-lookup/drill-down/links | **Refuted.** `admin-observability-agent-smoke.mjs` has zero content assertions, never calls `/traces/:traceId`. Reachability smoke only. | smoke `:32/46/175`, no assertions |

**Good news confirmed:** investigate DOES support no-traceId reverse lookup by id+time-window (`observability.service.ts:1271-1273`); api↔runner W3C traceparent IS stitched via job `traceContext` (`job.service.ts:362`, `executor.go:256`); strong reproducer exists for investigate/xlog (`observability.service.spec.ts`, 993 ln).

---

## 2. Live-only unknowns — resolve in Phase 0 BEFORE fixing

These could not be proven from code; they decide HOW to fix:

- **A.env:** actual `NODE_ENV`/`RUN_MIGRATIONS` on the deployed dev API container (code default is `true`).
- **A.col:** is `warm_pool` column currently `image`, `snapshot`, or `template`? (`SELECT column_name FROM information_schema.columns WHERE table_name='warm_pool'`)
- **A.migrow:** is `Migration1780200000000` already recorded in dev `migrations` table (→ idempotent guards will silently skip → permanent drift)?
- **A.runbook:** does the dev deploy run `migration:run:pre-deploy` + `post-deploy` separately, or rely on boot? No CI/Dockerfile orchestrates it in-tree.
- **B1.spans:** does the live collector actually receive any `ServiceName LIKE 'sandbox-%'` spans? Is the clickhouse exporter enabled (`CLICKHOUSE_ENDPOINT` set) or does box trace go to a per-org endpoint?
- **B1.eof:** is `:4318/v1/metrics: EOF` intermittent (LB idle-timeout) or persistent?
- **B3.attrs:** confirm box rows carry `boxlite_organization_id` (underscore) but not `boxlite.org_id` (dot); confirm an API span for the same sandbox carries `boxlite.org_id`.
- **D.retention:** do the CloudWatch log groups actually retain ~14d (makes the 1h drawer window materially lossy)?
- **X.tests:** which make/nx target runs the specs, and does `observability.service.spec.ts` PASS against the WIP service today?

---

## 3. Phases (A→B→C→D, gated by Phase 0)

### Phase 0 — Worktree + reproducer baseline (prerequisite)
- **Objective:** lock work to the task12b worktree, capture the §2 live states, establish green/red test baseline.
- **Verify:** test target runs & pass/fail recorded; written table of live states (env, warm_pool col, migrations row, sample otel_logs row dot-vs-underscore); edits confirmed in worktree.
- **Risk:** editing the wrong checkout silently no-ops; "reproducer exists" ≠ "passes".

### Phase A — Schema/migration release-gate (blocks safe deploys)
- **Objective:** API boots in dev with no `column WarmPool.template does not exist`; rolling deploy can't break old instances.
- **Key tasks:** fix dev drift for the ACTUAL column state from Phase 0 (likely `snapshot`→`template`; the repair script's `image→template` is wrong for that state — extend it or run `post-deploy/1780200000000`); address boot-glob running contract renames mid-rollout (`app.module.ts:83`); harden the single-migration concentration (verify/repair path for half-applied `1780200000000`); review pre-deploy `1780600000000` per-row boxId backfill for locks.
- **Verify:** API boots clean; entities match columns (`warm-pool.entity.ts:11/20`, `box-template.entity.ts:24-28`, `organization.entity.ts:61/68/176`); migration converges on a half-applied DB (not silent-skip); rolling-deploy sim/runbook shows old instances safe; config reproducers still pass.
- **Risk:** repair script empty-column divergence; half-applied permanent drift; premise C3 — confirm the operational override first.

### Phase B — Online observability loop (core of the task)
- **B1 box traces:** add minimal manual span instrumentation to the daemon (keep correct exporter at `tracing.go:42`).
- **B2 runner→box traceparent:** inject W3C `traceparent` into box daemon at create/start (`client.go:80` passes none; `config.go:18` reads only endpoint); handle background jobs where `captureTraceContext` returns null (`job.service.ts:365`).
- **B3 investigate correlation:** stop AND-injecting dot-namespaced `boxlite.org_id` for id-targeted log queries (`:1316-1325`); add `ServiceName='boxlite-runner'` clause; durable fix = normalize underscore↔dot attrs at emission/collector.
- **B4 xLog:** emit exec/command output as structured logs carrying `boxlite.execution_id/job_id` (passes gate `:1402`) OR persist to the S3 execution-id prefix the reader already searches; fix dead `executionId` interceptor branch.
- **Verify:** one live "create sandbox" = ONE trace api→runner→box (ClickHouse by traceId); `investigate?sandboxId` returns same box logs as `/logs?sandboxId` (incl. a sandbox with no API telemetry in window); `investigate?runnerId` surfaces `boxlite-runner` logs; xLog>0 after exec; NEW passing tests for `captureTraceContext` (real W3C) and `getTraceSpans`.
- **Risk:** B4 secret/cost leakage (scope+redact); B3 shared `getLogs` must not break `/logs`; convergence only provable live.

### Phase C — Agent consumability (AI Agent leg)
- **Key tasks:** add `serviceName` (± resourceAttributes) to `TraceSpanDto` and SELECT it in `getTraceSpans` (`:408` omits it; investigate path SELECTs but `toTraceSpan` discards) so agents can attribute each span to a layer; upgrade the agent smoke from reachability → behavioral contract (assert non-empty no-traceId reverse lookup, exercise `/traces/:traceId`, assert clickstack link shape); decide `X-BoxLite-Source=agent` contract — it is free-form, unauthenticated, never checked (`no source==='agent'`); document as telemetry tag only OR add real enforcement. **Do not treat the tag as a trust boundary (spoofable).**
- **Verify:** `/traces/:traceId` returns per-span serviceName (test asserts layer mapping); smoke exits 1 on empty reverse-lookup/broken drill-down; documented X-BoxLite-Source decision.
- **Risk:** reverse-lookup correctness depends on live attribute presence (Phase 0) — distinguish "no data" from "broken query".

### Phase D — Admin UI Diagnose acceptance (human leg)
- **Key tasks:** add date-range control to `AdminTelemetryDrawer` (hardcoded 1h at `:198`, no picker) reusing `AdminTelemetryPanel`'s `DateRangePicker` (extend quick ranges to real retention; currently 7d cap); decide whether the drawer renders the rich investigate payload it already fetches but ignores (logs/traceSpans/metrics/auditLogs/xlogs/s3Objects) vs aggregate+ClickStack; resolve dead `telemetry/{LogsTab,TracesTab,TraceDetailsSheet,MetricsTab}.tsx` (unwired); reconcile 3-tab+drawer taxonomy vs the pasted 5-section spec with the spec owner.
- **Verify:** drawer can query window >1h and CloudWatch/ClickHouse evidence reflects it; `AdminTelemetryDrawer.spec.tsx` extended; no exported-but-unconsumed tab components (or documented); spec-owner sign-off on taxonomy.
- **Risk:** 1h hardcoded window is the single highest-impact human-diagnose gap.

---

## 4. Success criteria (final report must include)

1. Current branch/worktree. 2. Deploy revision/image digest. 3. Schema/migration handling (what was found, what was applied, why). 4. Local + remote test results (actual run output). 5. Online API/UI/Agent verification. 6. ClickHouse/ClickStack evidence. 7. Four-layer logs/traces/metrics status (post-fix). 8. xLog status. 9. Residual risk (esp. live-only items that stayed open). 10. Proof the old 07:12 event was NOT fabricated as a trace hit (it has no trace; audit-only).
