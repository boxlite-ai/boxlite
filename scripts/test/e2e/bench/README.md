# REST API Benchmark Suite

Performance harness for the BoxLite REST API. Measures end-to-end latency
through the full production path (`client → API → runner → VM`) — no local
libkrun or Linux required.

## Quick start

```bash
# Set credentials (or use ~/.boxlite/credentials.toml profile p1)
export BOXLITE_E2E_API_URL=https://api.dev.boxlite.ai/api
export BOXLITE_E2E_API_KEY=blk_live_...
export BOXLITE_E2E_AUTH=api-key

# List scenarios
.venv/bin/python -m bench list

# Run one scenario
.venv/bin/python -m bench run latency-cold-start --runs 10 --warmup 1

# Run all scenarios, save reports
.venv/bin/python -m bench run all --runs 5 --out-dir bench/results/

# Compare two runs for regression
.venv/bin/python -m bench compare bench/results/baseline.json bench/results/current.json
```

Run from the repo root (`scripts/test/e2e/` must be in the Python path).

## Scenarios

### Latency

| Scenario | What it measures |
|----------|------------------|
| `latency-cold-start` | POST /boxes wall clock + runner create_duration_ms + first exec |
| `latency-exec` | Single exec on a warm box |
| `latency-lifecycle` | Full create → exec → delete cycle |
| `latency-restart` | Stop → start → exec on a running box |

### Throughput

| Scenario | What it measures |
|----------|------------------|
| `throughput-exec-serial` | 20 serial execs on one box; execs/sec |
| `throughput-exec-parallel` | 10 concurrent execs on one box; batch wall + per-exec |

### Density

| Scenario | What it measures |
|----------|------------------|
| `density-parallel-create` | 5 boxes created concurrently; per-box and batch wall |

### Stability

| Scenario | What it measures |
|----------|------------------|
| `stability-churn` | 10 create+exec+delete cycles; latency drift |
| `stability-exec-loop` | 50 execs on one box; degradation over time |

## Report schema

Same v1.0 JSON format as the original bench harness:

```json
{
  "schema_version": "1.0",
  "scenario": "latency-cold-start",
  "metadata": { "started_at": "...", "git_commit": "...", "host": {...} },
  "sample_count": 9,
  "warmup_count": 1,
  "samples": [{ "iteration": 1, "warmup": false, "wall_ms": 1948, "metrics": {...} }],
  "aggregates": [{ "name": "api_create_wall_ms", "p50": 1948, "p90": 2893, ... }]
}
```

## Compare semantics

`bench compare` joins aggregates by metric name, picks the percentile from
`--on` (default `p99`), and flags regressions exceeding `--threshold` (default 20%).
Direction-aware: lower-is-better for latency, higher-is-better for `*_per_sec`.
