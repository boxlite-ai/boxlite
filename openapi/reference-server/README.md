# BoxLite Box API Reference Server

Reference implementation of the [BoxLite Box API](../box.openapi.yaml).
Use this to validate client implementations against the spec.

**Not production-ready** — no persistence, single-tenant.

## Setup

```bash
# 1. Build the BoxLite Python SDK (installs into project .venv)
make dev:python

# 2. (Optional) Copy server defaults for local development
cp openapi/reference-server/.env.example openapi/reference-server/.env

# 3. Start the server (uv installs server deps, --active uses the project .venv)
cd openapi/reference-server
uv run --active server.py
```

## Test Credentials

| Field | Value |
|-------|-------|
| client_id | `test-client` |
| client_secret | `test-secret` |

## Quick Test

```bash
# Get a token
TOKEN=$(curl -s -X POST http://localhost:8080/v1/oauth/tokens \
  -d 'grant_type=client_credentials&client_id=test-client&client_secret=test-secret' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# Server config
curl -s http://localhost:8080/v1/config | python3 -m json.tool

# Create a box
curl -s -X POST http://localhost:8080/v1/demo/boxes \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"image":"alpine:latest"}' | python3 -m json.tool

# List boxes
curl -s http://localhost:8080/v1/demo/boxes \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# Start a box (replace BOX_ID)
curl -s -X POST http://localhost:8080/v1/demo/boxes/$BOX_ID/start \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# Execute a command
curl -s -X POST http://localhost:8080/v1/demo/boxes/$BOX_ID/exec \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command":"echo","args":["hello world"]}' | python3 -m json.tool

# Stream output (WebSocket /attach — see SDK)

# Runtime metrics
curl -s http://localhost:8080/v1/demo/metrics \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# Remove box
curl -s -X DELETE http://localhost:8080/v1/demo/boxes/$BOX_ID \
  -H "Authorization: Bearer $TOKEN" -w "%{http_code}\n"
```

## Implemented Endpoints (20 of 22)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/config` | GET | Server configuration |
| `/v1/oauth/tokens` | POST | OAuth2 client credentials |
| `/{prefix}/boxes` | POST | Create box |
| `/{prefix}/boxes` | GET | List boxes |
| `/{prefix}/boxes/{id}` | GET | Get box |
| `/{prefix}/boxes/{id}` | HEAD | Check exists |
| `/{prefix}/boxes/{id}` | DELETE | Remove box |
| `/{prefix}/boxes/{id}/start` | POST | Start box |
| `/{prefix}/boxes/{id}/stop` | POST | Stop box |
| `/{prefix}/boxes/{id}/exec` | POST | Execute command |
| `/{prefix}/boxes/{id}/executions/{eid}` | GET | Execution status |
| `/{prefix}/boxes/{id}/executions/{eid}/signal` | POST | Send signal |
| `/{prefix}/boxes/{id}/executions/{eid}/resize` | POST | Resize TTY |
| `/{prefix}/boxes/{id}/files` | PUT | Upload files |
| `/{prefix}/boxes/{id}/files` | GET | Download files |
| `/{prefix}/boxes/{id}/metrics` | GET | Box metrics |
| `/{prefix}/metrics` | GET | Runtime metrics |
| `/{prefix}/images/pull` | POST | Pull image |
| `/{prefix}/images` | GET | List images |

**Not implemented:** `GET/HEAD /{prefix}/images/{id}` (SDK has no get-by-digest), WebSocket TTY.

## CLI Options

```
uv run --active server.py [--env-file /path/to/.env] [--host 0.0.0.0] [--port 8080] [--log-level info]
```

## Environment Configuration

The server supports `openapi/reference-server/.env` by default.
Use `--env-file` to load a different file.

### Server Settings (`BOXLITE_SERVER_*`)

| Variable | Default |
|----------|---------|
| `BOXLITE_SERVER_HOST` | `0.0.0.0` |
| `BOXLITE_SERVER_PORT` | `8080` |
| `BOXLITE_SERVER_LOG_LEVEL` | `info` |
| `BOXLITE_SERVER_JWT_SECRET` | `boxlite-reference-server-secret` |
| `BOXLITE_SERVER_JWT_EXPIRY_SECONDS` | `3600` |
| `BOXLITE_SERVER_CLIENT_ID` | `test-client` |
| `BOXLITE_SERVER_CLIENT_SECRET` | `test-secret` |

### Runtime Settings (`BOXLITE_RUNTIME_*`)

| Variable | Default |
|----------|---------|
| `BOXLITE_RUNTIME_HOME_DIR` | `~/.boxlite` |
| `BOXLITE_RUNTIME_IMAGE_REGISTRIES` | `mirror.gcr.io,docker.io` |

### Precedence

For `host`, `port`, and `log-level`:

1. CLI args (`--host`, `--port`, `--log-level`)
2. Environment (`BOXLITE_SERVER_*`)
3. Built-in defaults
