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

Build the SDK and start a server on port 8100 before running any example:

```bash
make dev:python

# Built-in server (recommended):
boxlite serve --port 8100

# — or — the Python reference server on the same port:
cp openapi/reference-server/.env.example openapi/reference-server/.env
cd openapi/reference-server && uv run --active server.py --port 8100
```

Both accept any non-empty bearer token, so the examples pass a
placeholder `ApiKeyCredential("local-dev-key")`.

Then run examples from this directory:

```bash
python connect_and_list.py
```

For env-based client configuration (`use_env_config.py`), set:

```bash
BOXLITE_REST_URL=http://localhost:8100
BOXLITE_API_KEY=your-api-key
# Optional (default in SDK is v1):
BOXLITE_REST_PREFIX=v1
```

`BoxliteRestOptions.from_env()` reads these and wraps `BOXLITE_API_KEY`
in an `ApiKeyCredential` automatically. In code, construct the
credential explicitly:

```python
from boxlite import Boxlite, BoxliteRestOptions, ApiKeyCredential

rt = Boxlite.rest(BoxliteRestOptions(
    url="http://localhost:8100",
    credential=ApiKeyCredential("your-api-key"),
))
```
