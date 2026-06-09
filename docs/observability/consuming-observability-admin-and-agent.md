# Consuming BoxLite Observability — Best Practices (Admin & Agent)

> Audience: human Admins using the dashboard, and AI agents (yours and teammates') consuming the Admin API.
> Grounded in live dev verification (2026-06-08) + code audit. Where reality differs from intuition, the doc says so.

## 0. The one rule

**Everything goes through the BoxLite Admin API.** Nobody — human or agent — queries ClickHouse, ClickStack/HyperDX, CloudWatch, S3, or Postgres directly. The Admin API is the single facade that fans out to all of them, merges, and returns structured JSON with per-source provenance.

```
   Admin (UI)  ┐
   AI Agent    ┼──► Admin Observability API ──► { ClickHouse, CloudWatch, Postgres, S3, audit }
   Teammate's  ┘        (single auth, single                 (never reached directly)
    agent                contract, X-BoxLite-Source tag)
```

## 1. Access contract (give this to any agent — yours or a teammate's)

```
Base URL:   https://api.dev.boxlite.ai/api
Auth:       Authorization: Bearer <ADMIN_API_KEY>      # admin/system-admin scope
Tag:        X-BoxLite-Source: agent                    # records who is calling (see caveat)
```

- The key is an **admin-role API key**. Treat it as full-tenant admin: store it in the agent's **secret/env** (e.g. `BOXLITE_ADMIN_API_KEY`), never paste it into prompts, logs, screenshots, or commits.
- `X-BoxLite-Source` is an **audit/telemetry tag, not a trust boundary**. It is not authenticated and any admin-credentialed caller can set any value. Access control is the admin key + role, not this header. Always send `agent` so calls are attributable in the audit log, but never rely on it for authorization.
- Agents must **not** attempt direct ClickHouse/ClickStack/CloudWatch/S3/DB connections. If the Admin API can't answer, surface that — don't side-channel.

## 2. The six endpoints

| Endpoint | Use it for |
|---|---|
| `GET /admin/observability/status` | Pipeline health per layer (api/runner/ec2_host/box) × signal (logs/traces/metrics), with `lastSeen`. First stop to know if a layer can even be queried. |
| `GET /admin/observability/investigate` | **The workhorse.** Give it any id(s) + time window → resolves the resource, fans out across all sources, returns correlation graph + timeline + per-source status + ClickStack deep links + ready-made commands. |
| `GET /admin/observability/logs` | Granular logs, filterable by `sandboxId` / `serviceName` / `layer` + time window. Surfaces self-emitted box/runner logs that aggregate views may not. |
| `GET /admin/observability/traces` | Trace list, filterable by id / `layer` / `serviceName` + window. |
| `GET /admin/observability/traces/:traceId` | Full span tree for one trace (drill-down / waterfall). Each span now carries `serviceName` + resolved `layer`. |
| `GET /admin/observability/metrics` | Metric series by id + window (e.g. `boxlite.sandbox.cpu.utilization`, host/runtime metrics). |

## 3. Diagnose workflow (no traceId required)

E2E/SDK/CLI/REST failures usually do **not** hand you a traceId. You don't need one.

```
Step 0  From the failure, extract any of:
        sandboxId | boxId | runnerId | machineId | orgId | userId
        requestId | jobId | executionId | traceId   + a UTC time window
        Anchor priority: sandboxId/boxId  >  runnerId  >  orgId+window

Step 1  GET /investigate?<anchor>&from=<UTC>&to=<UTC>
        Read in this order:
          timeline + auditLogs  → authoritative "what happened / why" (status + errorMessage)
          sources[]             → which backend has evidence + WHY a source is empty
          correlation           → the resolved id graph (org/box/runner/user…)

Step 2  Only if correlation.traceIds is non-empty:
        GET /traces/:traceId  → span tree.
        ★ Trace truth-check (mandatory): confirm the span is the ORIGINAL failure, not your
          own diagnostic call. Reject a trace whose spanName/http.route is
          /admin/observability/*, whose user-agent is your client, or whose timestamp is the
          diagnosis time rather than the failure time.

Step 3  Report: root cause, associated box/runner/machine/user/org, which source proved it,
        ClickStack deep link, and concrete next step. NEVER invent a traceId or claim a trace
        hit when the evidence was audit-only.
```

**Authoritative vs supporting:** the "why it failed" answer most often lives in **audit/Postgres** (`statusCode` + `errorMessage`). ClickHouse OTel (traces/logs/metrics) adds execution depth **when it exists**. Lead with audit; enrich with OTel.

## 4. Layer model & what is actually flowing (verified 2026-06-08)

`serviceName → layer`: `boxlite-api`→api, `boxlite-runner`→runner, `boxlite-runner-host`→ec2_host, `sandbox-<id>`→box (or explicit `boxlite.layer` resource attr).

```
            LOGS        METRICS      TRACES        notes
 api        ✅          ✅           ✅ ~120k       full depth, drills to the failing SQL
 runner     ✅          ✅           ✅ ~5.4k       traces exist; per-runner log correlation is weak (see gaps)
 ec2_host   ✅          ✅           ✅ ~0.5k       host heartbeat + hostmetrics
 box        ✅ (svc=    ✅ boxlite.   ❌ 0          box daemon emits logs+metrics but produces no spans
            sandbox-*)  sandbox.*                  except per-request server spans after /init
```

Do not assume "box has no telemetry." It has logs + metrics (incl. `boxlite.sandbox.cpu/filesystem.*`). It just has **no traces** today.

## 5. For agents specifically

- **Span layer attribution:** `/traces/:traceId` now returns `serviceName` + `layer` per span, so you can attribute each span to api/runner/ec2_host/box without re-querying.
- **Box/runner self-logs in investigate:** resource-targeted `investigate?sandboxId=…` no longer drops box self-logs (it stopped AND-filtering by a correlated org id). For the fullest box logs you can still go granular: `GET /logs?sandboxId=<id>` (matches `ServiceName=sandbox-<id>`).
- **Read `sources[].state` + `message`:** every source self-reports `available|missing|not_configured` and *why* it's empty. Use it instead of guessing — e.g. `clickhouse: missing` for a 4xx that was rejected before a span was tagged is expected, not a bug.
- **Prefer `correlation.traceIds`** (the aggregator's vetted set) over the raw `/traces` list when deciding what to drill into — it avoids picking up your own diagnostic call.

## 6. Known gaps & residual risk (state honestly in any report)

- **Box traces = 0 (structural):** the in-box daemon configures a tracer but produces no spans except per-request server spans after `/init`. A "create sandbox" user request does not yet show box-boot spans under one trace (no traceparent injected into the box at create/start).
- **xLog = 0 (structural):** no producer writes `boxlite.execution_id/job_id` onto a log record; exec/attach output is proxied, not persisted. Expect empty until that changes.
- **Runner self-logs are not per-runner-correlatable:** `boxlite-runner` logs carry no `boxlite.runner_id`, so they can't be narrowed to one runner from the API yet.
- **Underscore vs dot attribute split:** box/daemon emit `boxlite_organization_id` (underscore); API queries use `boxlite.org_id` (dot). The durable fix is normalizing at emission/collector; until then, org-level correlation of self-emitted box telemetry is limited.
- **UI Diagnose drawer default window is 1h:** incidents triaged >1h later can return empty CloudWatch evidence from the drawer. Widen the window via the API (`from`/`to`) when needed.

## 7. For human Admins (dashboard)

- Use **Overview → Platform Telemetry** for fleet-wide metrics/logs/traces/investigate; use the **Diagnose drawer** (row-level button on People & Boxes / Fleet) for a single object.
- The drawer surfaces object state, evidence-source status, timeline, ClickStack human deep links, and ready-made Admin-API + agent-prompt commands. For raw log/trace/metric rows beyond the aggregate, follow the ClickStack deep link or query the API directly.
- ClickStack (HyperDX) links are for **human** exploration only; agents stay on the Admin API.
