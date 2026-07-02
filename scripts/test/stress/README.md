# API Stress Tests

This directory contains opt-in stress checks for deployed BoxLite REST APIs.
They are intentionally separate from functional E2E tests because load tests can
consume shared dev capacity and should be run with explicit operator intent.

## Read-only API stress

`api-read.k6.js` exercises the API, auth, database, Redis, ALB, and ECS API task
without creating, starting, stopping, or deleting boxes.

It calls:

- `GET /api/health`
- `GET /api/v1/config`
- `GET /api/v1/me`
- `GET /api/v1/<prefix>/boxes`
- optionally `GET` and `HEAD /api/v1/<prefix>/boxes/<boxId>`

Install k6 first:

```bash
brew install k6
```

Run:

```bash
export BOXLITE_API_URL=https://api.dev.boxlite.ai/api
export BOXLITE_TOKEN=<api-key-or-oidc-access-token>
export BOXLITE_PREFIX=<path-prefix-from-boxlite-auth-whoami>

make test:stress:api-read
```

For local user-experience checks where laptop/network/DNS/TLS latency is part of
the signal, use the lower-rate profile:

```bash
make test:stress:api-read-local
```

That profile defaults to 1, 3, then 5 iterations per second with p95 < 2.5s and
p99 < 4s. Each iteration issues four HTTP requests unless `BOXLITE_BOX_ID` is
set.

Optionally include one existing box:

```bash
export BOXLITE_BOX_ID=<existing-box-id-or-name>
make test:stress:api-read
```

The default profile ramps arrival rate from 10 to 50, 100, then 200 requests per
second. Override these knobs when needed:

```bash
BOXLITE_STRESS_RATE_1=25 \
BOXLITE_STRESS_RATE_2=50 \
BOXLITE_STRESS_RATE_3=100 \
BOXLITE_STRESS_STAGE_1=1m \
BOXLITE_STRESS_STAGE_2=2m \
BOXLITE_STRESS_STAGE_3=2m \
make test:stress:api-read
```

Watch at least these production-side signals during a run:

- ALB `RequestCount`, `TargetResponseTime`, `HTTPCode_Target_5XX_Count`
- ECS API task CPU, memory, restarts
- database connections, CPU, slow queries
- Redis CPU, latency, evictions
- API logs for 401/403/404/429/5xx spikes

## Box creation stress

`api-create-box.k6.js` exercises `POST /api/v1/<prefix>/boxes` and then deletes
each created box. This is not read-only: it consumes runner capacity and can
pull/start images. Use the local profile first:

```bash
export BOXLITE_API_URL=https://api.dev.boxlite.ai/api
export BOXLITE_TOKEN=<api-key-or-oidc-access-token>
export BOXLITE_PREFIX=<path-prefix-from-boxlite-auth-whoami>

make test:stress:api-create-box-local
```

Defaults:

- image: `ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3`
- resources: `1` CPU, `256` MiB memory, `1` GiB disk
- cleanup: enabled (`DELETE /boxes/<boxId>` after each successful create)
- rate: ramps to `0.1` creates/sec, about one create every 10 seconds

Useful overrides:

```bash
BOXLITE_STRESS_IMAGE=ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3 \
BOXLITE_STRESS_RATE_3=0.2 \
BOXLITE_STRESS_CLEANUP=1 \
make test:stress:api-create-box-local
```

If a run is interrupted, clean up any remaining boxes whose names start with
`stress-api-create-`.

For a one-shot canary:

```bash
BOXLITE_STRESS_ITERATIONS=1 make test:stress:api-create-box
```

## VM lifecycle stress

`api-vm-lifecycle.k6.js` is the real VM lifecycle test. It creates boxes, waits
for the REST API to report them as `running`, holds them for a configured
duration, and then deletes them.

Important runner safety rule:

```text
max simultaneous VMs must be <= runner CPU count * 8
```

The script uses a closed `constant-vus` model so each VU can hold at most one VM
at a time. Set `BOXLITE_STRESS_RUNNER_CPUS` and `BOXLITE_STRESS_VM_LIMIT`; the
script fails at startup if `VM_LIMIT > RUNNER_CPUS * 8` or `VUS > VM_LIMIT`.

For the current dev default runner (`c8i.2xlarge`, 8 vCPU), the hard ceiling is
`64` simultaneous VMs. The local canary defaults to only `2`.

```bash
export BOXLITE_API_URL=https://api.dev.boxlite.ai/api
export BOXLITE_TOKEN=<api-key-or-oidc-access-token>
export BOXLITE_PREFIX=<path-prefix-from-boxlite-auth-whoami>

make test:stress:api-vm-lifecycle-local
```

Useful overrides:

```bash
BOXLITE_STRESS_RUNNER_CPUS=8 \
BOXLITE_STRESS_VM_LIMIT=8 \
BOXLITE_STRESS_VUS=8 \
BOXLITE_STRESS_DURATION=5m \
BOXLITE_STRESS_HOLD_SECONDS=60 \
make test:stress:api-vm-lifecycle
```

Do not set `BOXLITE_STRESS_VM_LIMIT` above `RUNNER_CPUS * 8`; exceeding that
runner limit can require a runner restart.
