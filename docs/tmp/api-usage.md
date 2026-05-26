# BoxLite API Usage

This note is based on the contract in [openapi/box.openapi.yaml](/Users/lilongen/github/boxlite/openapi/box.openapi.yaml:1).

## Correct base URL

The OpenAPI server base URL is:

```text
https://<host>/v1
```

For the dev environment, that means requests should be shaped like:

```text
https://api.dev.boxlite.ai/v1/...
```

Not:

```text
https://api.dev.boxlite.ai/api/v1/oauth/tokens
```

The OpenAPI contract does not define `/oauth/tokens`. It defines business endpoints under `/v1`, and clients are expected to already have a Bearer token before calling them.

References:
- [openapi/box.openapi.yaml](/Users/lilongen/github/boxlite/openapi/box.openapi.yaml:71)
- [openapi/box.openapi.yaml](/Users/lilongen/github/boxlite/openapi/box.openapi.yaml:106)

## Authentication

All endpoints except `GET /v1/config` require:

```http
Authorization: Bearer <token>
```

The API is bearer-format agnostic. Token acquisition is explicitly out of scope for this OpenAPI contract. The client should obtain a token or API key from the appropriate upstream system, then call BoxLite APIs directly with that Bearer token.

References:
- [openapi/box.openapi.yaml](/Users/lilongen/github/boxlite/openapi/box.openapi.yaml:38)
- [openapi/box.openapi.yaml](/Users/lilongen/github/boxlite/openapi/box.openapi.yaml:45)
- [openapi/box.openapi.yaml](/Users/lilongen/github/boxlite/openapi/box.openapi.yaml:931)

## Recommended call flow

1. Call `GET /v1/config` to discover server capabilities.
2. Call `GET /v1/me` with the Bearer token to validate the credential.
3. Read `prefix` from the `/me` response.
4. Use that `prefix` in subsequent resource paths such as `/{prefix}/boxes`.

References:
- [openapi/box.openapi.yaml](/Users/lilongen/github/boxlite/openapi/box.openapi.yaml:111)
- [openapi/box.openapi.yaml](/Users/lilongen/github/boxlite/openapi/box.openapi.yaml:122)
- [openapi/box.openapi.yaml](/Users/lilongen/github/boxlite/openapi/box.openapi.yaml:1245)

## Minimal examples

Set variables:

```bash
BASE_URL="https://api.dev.boxlite.ai/api/v1"
TOKEN="<your-bearer-token>"
```

Get server config:

```bash
curl -s "${BASE_URL}/config"
```

Validate the credential and inspect the current principal:

```bash
curl -s "${BASE_URL}/me" \
  -H "Authorization: Bearer ${TOKEN}"
```

Expected usage:
- Read `prefix` from the `/me` response.
- Use that value in the rest of the API paths.

## Create and list boxes

Assume `/me` returned:

```json
{
  "prefix": "acme-corp"
}
```

Create a box:

```bash
curl -s "${BASE_URL}/acme-corp/boxes" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "dev-box",
    "image": "python:3.11-slim",
    "cpus": 2,
    "memory_mib": 512
  }'
```

List boxes:

```bash
curl -s "${BASE_URL}/acme-corp/boxes" \
  -H "Authorization: Bearer ${TOKEN}"
```

References:
- [openapi/box.openapi.yaml](/Users/lilongen/github/boxlite/openapi/box.openapi.yaml:155)
- [openapi/box.openapi.yaml](/Users/lilongen/github/boxlite/openapi/box.openapi.yaml:1415)
- [openapi/box.openapi.yaml](/Users/lilongen/github/boxlite/openapi/box.openapi.yaml:1671)

## Start an execution

Command execution is a two-step flow:

1. `POST /{prefix}/boxes/{box_id}/exec`
2. Then either:
   - `GET /{prefix}/boxes/{box_id}/executions/{exec_id}` for status, or
   - `GET /{prefix}/boxes/{box_id}/executions/{exec_id}/attach` for WebSocket streaming

Start an execution:

```bash
curl -s "${BASE_URL}/acme-corp/boxes/<box_id>/exec" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "command": "python3",
    "args": ["-c", "print(\"hello\")"],
    "tty": false
  }'
```

Check execution status:

```bash
curl -s "${BASE_URL}/acme-corp/boxes/<box_id>/executions/<exec_id>" \
  -H "Authorization: Bearer ${TOKEN}"
```

References:
- [openapi/box.openapi.yaml](/Users/lilongen/github/boxlite/openapi/box.openapi.yaml:43)
- [openapi/box.openapi.yaml](/Users/lilongen/github/boxlite/openapi/box.openapi.yaml:516)
- [openapi/box.openapi.yaml](/Users/lilongen/github/boxlite/openapi/box.openapi.yaml:561)
- [openapi/box.openapi.yaml](/Users/lilongen/github/boxlite/openapi/box.openapi.yaml:1688)
- [openapi/box.openapi.yaml](/Users/lilongen/github/boxlite/openapi/box.openapi.yaml:1720)

## Pull and list images

Pull an image:

```bash
curl -s "${BASE_URL}/acme-corp/images/pull" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "image": "python:3.11-slim"
  }'
```

List cached images:

```bash
curl -s "${BASE_URL}/acme-corp/images" \
  -H "Authorization: Bearer ${TOKEN}"
```

References:
- [openapi/box.openapi.yaml](/Users/lilongen/github/boxlite/openapi/box.openapi.yaml:840)
- [openapi/box.openapi.yaml](/Users/lilongen/github/boxlite/openapi/box.openapi.yaml:868)
- [openapi/box.openapi.yaml](/Users/lilongen/github/boxlite/openapi/box.openapi.yaml:1897)
- [openapi/box.openapi.yaml](/Users/lilongen/github/boxlite/openapi/box.openapi.yaml:1927)

## Customer-facing summary

Use BoxLite like this:

- Base URL: `https://api.dev.boxlite.ai/v1`
- Auth: `Authorization: Bearer <token>`
- Validate token: `GET /v1/me`
- Discover workspace prefix: read `prefix` from `/v1/me`
- Call resources under `/{prefix}/...`

Do not call:

```text
https://api.dev.boxlite.ai/api/v1/oauth/tokens
```

That path is not part of `openapi/box.openapi.yaml`.
