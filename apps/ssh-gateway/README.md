# SSH Gateway

**Disabled.** This gateway proxied SSH connections authenticated by the Legacy
SSH Token API. That contract (`POST`/`DELETE /box/{boxIdOrName}/ssh-access` and
`GET /box/ssh-access/validate`) has been deleted, so the gateway can no longer
map a username to a box and refuses every connection.

SSH now runs over the existing direct tunnel to the box's port `22`, and
`boxlite-guest` authenticates BoxLite-issued short-lived SSH certificates
locally. The gateway service and its infrastructure stay in the tree only as
rollback protection for that rollout and are removed in the cleanup phase.

## Current Behaviour

Every authentication method (password, public key, keyboard-interactive) is
refused. The client receives a pre-auth banner explaining the removal and then
`Permission denied`. No connection is proxied to a runner.

## Configuration

### Environment Variables

The gateway makes no API calls, so it needs no API URL or key. The only
requirement left is a host key, so the listener can present a stable identity
while refusing every connection.

| Variable           | Description                                       | Default | Required |
| ------------------ | ------------------------------------------------- | ------- | -------- |
| `SSH_GATEWAY_PORT` | Port for the SSH gateway to listen on             | `2222`  | No       |
| `SSH_HOST_KEY`     | Base64-encoded host private key                   | -       | **Yes**  |

### Example Environment

```bash
export SSH_GATEWAY_PORT=2222
export SSH_HOST_KEY=$(base64 -i /tmp/boxlite-host)
```

## Building

### Local Build

```bash
go mod tidy
go build -o ssh-gateway .
```

### Docker Build

```bash
docker build -t ssh-gateway .
```

## Running

### Local Execution

```bash
./ssh-gateway
```

### Docker Execution

```bash
docker run -p 2222:2222 \
  -e SSH_HOST_KEY=$(base64 -i /tmp/boxlite-host) \
  ssh-gateway
```

## Security

- **Fails closed**: no authentication method succeeds, so no session can be
  established through this gateway.
- **No token validation**: the API endpoint it depended on no longer exists.
- **Stable host identity**: the host key is supplied via `SSH_HOST_KEY` and the
  service refuses to start without one, so the fingerprint a client sees does
  not change across restarts.
- **No signing key**: the gateway holds no credential of its own. The key that
  signed the old runner-proxy connection is neither required nor read.

## API Endpoints Used

None, and no API client is built. The runner-proxying code paths have been
removed; only the listener that refuses connections remains, until the service
itself is deleted in the cleanup phase.

## Logging

The application logs all connection attempts and errors for debugging and monitoring purposes.
