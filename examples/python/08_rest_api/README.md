# 08 REST API

Use BoxLite through a remote REST API server instead of the local runtime.
All examples use the Python SDK's `Boxlite.rest()` constructor with `BoxliteRestOptions`.

| File | Description |
|------|-------------|
| `connect_and_list.py` | Connect to a remote server, authenticate, list boxes |
| `manage_boxes.py` | Full CRUD: create, get, get_info, get_or_create, list, remove |
| `run_commands.py` | Execute commands and stream stdout/stderr |
| `copy_files.py` | Upload and download files (tar-based transfer) |
| `monitor_metrics.py` | Runtime-wide and per-box metrics |
| `configure_boxes.py` | Custom CPU, memory, env vars, working directory |
| `use_env_config.py` | Load connection config from environment variables |

**Recommended first example:** `connect_and_list.py`

## Prerequisites

Start the reference server before running any example:

```bash
make dev:python

# Optional: copy server defaults for local development
cp openapi/reference-server/.env.example openapi/reference-server/.env

cd openapi/reference-server
uv run --active server.py
```

Then run examples from this directory:

```bash
python connect_and_list.py
```

For env-based client configuration (`use_env_config.py`), set:

```bash
BOXLITE_REST_URL=http://localhost:8080
BOXLITE_REST_CLIENT_ID=test-client
BOXLITE_REST_CLIENT_SECRET=test-secret
# Optional (default in SDK is v1):
BOXLITE_REST_PREFIX=v1
```
