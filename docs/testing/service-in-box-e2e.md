# Service-in-Box Testing

This document describes the current tests for exposing a service running inside
a Box through `box.network.tunnel(port)`. It covers local file-descriptor
tunnels, cloud HTTPS CONNECT tunnels, HTTP and WebSocket traffic, arbitrary TCP
traffic, and the known lifecycle gaps.

## Data Paths Under Test

Cloud SDK connections use this path:

```text
Python or Node SDK
  -> REST API: prepare tunnel
  -> TLS connection to the public Proxy
  -> HTTP CONNECT
  -> Proxy
  -> Runner CONNECT endpoint
  -> guest port transport
  -> service in the Box
```

The SSH E2E uses the same cloud path without relying on the SDK for the data
stream:

```text
OpenSSH client
  -> standard-library HTTPS CONNECT helper
  -> public Proxy
  -> Runner
  -> sshd:2222 in the Box
```

Local SDK connections return a file descriptor and connect directly through
the local Box runtime.

## Test Inventory

### Remote REST E2E

The main cloud coverage lives in:

- `scripts/test/e2e/cases/test_sdk_tunnel.py`
- `scripts/test/e2e/cases/test_node_tunnel.py`
- `scripts/test/e2e/sdks/node/e2e_tunnel.ts`
- `scripts/test/e2e/fixtures/service_in_box_server.py`
- `scripts/test/e2e/fixtures/https_connect_proxy.py`

| Test                                                    | Coverage                                                                                                                                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test_python_sdk_tunnel_proxies_http_from_rest_box`     | REST tunnel endpoint, HTTP GET and POST, two guest ports, prepared handles, concurrent clients, WebSocket upgrade and frames, responses larger than 2 MiB, slow readers, client cancellation, service restart |
| `test_python_sdk_tunnel_keeps_boxes_isolated`           | Two Boxes using the same guest port cannot receive each other's traffic                                                                                                                                       |
| `test_python_sdk_tunnel_proxies_ssh_over_https_connect` | Real `sshd:2222`, ephemeral key authentication, TLS to the public Proxy, HTTP CONNECT, arbitrary SSH bytes, command execution in the guest                                                                    |
| `test_node_sdk_tunnel_proxies_http_from_rest_box`       | Node equivalent of the HTTP, WebSocket, multi-port, concurrency, large-response, restart, cancellation, and Box-isolation coverage                                                                            |
| `test_python_sdk_tunnel_rejects_stopped_box`            | Non-strict `xfail`: records the race in which a stopped Box can still produce an accepted CONNECT before the stream fails                                                                                     |
| `test_node_sdk_tunnel_rejects_stopped_box`              | Non-strict `xfail`: Node coverage for the same stopped-Box race                                                                                                                                               |
| `test_python_sdk_tunnel_preserves_tcp_half_close`       | Strict `xfail`: records that `shutdown_write()` can drop the guest response                                                                                                                                   |
| `test_node_sdk_tunnel_preserves_tcp_half_close`         | Strict `xfail`: Node coverage for the same TCP half-close behavior                                                                                                                                            |

The Python and Node test Boxes use `auto_remove=True`; they are removed during
cleanup even when an assertion fails.

### Local and Pre-existing Dev Box Integration

`sdks/python/tests/test_dev_tunnel_e2e.py` covers both local and cloud handles:

| Test                                                   | Coverage                                                                                                          |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `test_local_box_tunnel_endpoint_and_one_shot_connects` | Local endpoint is a file descriptor; independent tunnel handles each connect once                                 |
| `test_local_box_tunnel_binary_integrity`               | Four concurrent 4 MiB binary round trips with byte-for-byte and SHA-256 validation                                |
| `test_dev_cloud_tunnel_endpoint_and_one_shot_connects` | A pre-existing dev Box returns an HTTP(S) endpoint containing the guest port and supports independent connections |
| `test_dev_cloud_tunnel_binary_integrity`               | Cloud binary integrity through a pre-existing dev Box                                                             |

These cloud tests are useful when a Box must remain available for manual
inspection. Unlike the main REST E2E suite, they require
`BOXLITE_E2E_BOX_ID`.

### Unit and Component Coverage

The narrower tests isolate API contracts and stream mechanics:

- `apps/proxy/pkg/proxy/tunnel_test.go`: CONNECT routing, target parsing,
  private-Box rejection, shutdown tracking, and `CloseWrite` forwarding.
- `apps/proxy/pkg/proxy/get_box_target_test.go`: encoded Box IDs, guest port
  parsing, HTTP transport over Runner CONNECT, and activity polling.
- `src/boxlite/src/rest/client.rs`: CONNECT handshake, status mapping,
  endpoint preparation, and bidirectional stream behavior.
- `sdks/python/tests/test_tunnel.py`: endpoint values, one-shot connect
  semantics, started-Box requirements, and invalid ports.
- `sdks/node/tests/tunnel.test.ts`: endpoint values and one-shot connect
  semantics.
- `sdks/go/tunnel_test.go`: closed handles and idempotent close behavior.

These tests do not replace the remote E2E because they use fakes, loopback
servers, or mocked handles.

## Dev Prerequisites

The recommended environment is the Linux debug machine with the latest Python
and Node SDK artifacts installed.

Configure a profile in `~/.boxlite/credentials.toml`:

```toml
[profiles.p1]
url = "https://dev.boxlite.ai/api"
api_key = "<dev-api-key>"
auth_method = "api_key"
path_prefix = ""
```

Activate the repository virtual environment:

```bash
cd ~/boxlite
. .venv/bin/activate
```

The remote suite expects:

- `BOXLITE_E2E_PROFILE=p1`
- `BOXLITE_E2E_AUTH=api-key`
- a dev-compatible image, defaulting to
  `ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3`
- `npx` and a built Node N-API binding for Node coverage
- `ssh` and `ssh-keygen` for SSH coverage
- outbound package access from the guest for the SSH test to install
  `openssh-server`

`BOXLITE_E2E_SKIP_PATH_VERIFY=1` is required when the test process cannot read
the remote Runner journal.

## Running Against Dev

Run the normal Python and Node service tests:

```bash
BOXLITE_E2E_PROFILE=p1 \
BOXLITE_E2E_AUTH=api-key \
BOXLITE_E2E_SKIP_PATH_VERIFY=1 \
python -m pytest \
  scripts/test/e2e/cases/test_sdk_tunnel.py::test_python_sdk_tunnel_proxies_http_from_rest_box \
  scripts/test/e2e/cases/test_sdk_tunnel.py::test_python_sdk_tunnel_keeps_boxes_isolated \
  scripts/test/e2e/cases/test_node_tunnel.py::test_node_sdk_tunnel_proxies_http_from_rest_box \
  -vv -ra
```

Run the real SSH-over-CONNECT test:

```bash
BOXLITE_E2E_PROFILE=p1 \
BOXLITE_E2E_AUTH=api-key \
BOXLITE_E2E_SKIP_PATH_VERIFY=1 \
python -m pytest \
  scripts/test/e2e/cases/test_sdk_tunnel.py::test_python_sdk_tunnel_proxies_ssh_over_https_connect \
  -vv -ra
```

Run the known lifecycle gaps:

```bash
BOXLITE_E2E_PROFILE=p1 \
BOXLITE_E2E_AUTH=api-key \
BOXLITE_E2E_SKIP_PATH_VERIFY=1 \
python -m pytest \
  scripts/test/e2e/cases/test_sdk_tunnel.py::test_python_sdk_tunnel_rejects_stopped_box \
  scripts/test/e2e/cases/test_sdk_tunnel.py::test_python_sdk_tunnel_preserves_tcp_half_close \
  scripts/test/e2e/cases/test_node_tunnel.py::test_node_sdk_tunnel_rejects_stopped_box \
  scripts/test/e2e/cases/test_node_tunnel.py::test_node_sdk_tunnel_preserves_tcp_half_close \
  -vv -ra
```

The two half-close cases should report `XFAIL` and are strict. The stopped-Box
cases can report either `XFAIL` or `XPASS` because the observed behavior is a
race; an occasional pass does not prove the issue is fixed. The command should
still exit successfully.

## Pre-existing Dev Box Tests

To run the binary-integrity tests against a Box that should remain available:

```bash
export BOXLITE_API_KEY="<dev-api-key>"
export BOXLITE_REST_URL="https://dev.boxlite.ai/api"
export BOXLITE_E2E_BOX_ID="<box-id>"

python -m pytest \
  sdks/python/tests/test_dev_tunnel_e2e.py::test_dev_cloud_tunnel_endpoint_and_one_shot_connects \
  sdks/python/tests/test_dev_tunnel_e2e.py::test_dev_cloud_tunnel_binary_integrity \
  -vv -ra
```

The Box must be public and started. These tests start and stop their guest
services but do not remove the Box.

## Expected Evidence

A healthy normal run should show:

```text
3 passed
```

The Node driver also emits:

```text
TUNNEL_HTTP=ok
TUNNEL_WS=ok
TUNNEL_MULTIPORT=ok
TUNNEL_CONCURRENT=ok
TUNNEL_LARGE=ok
TUNNEL_RESTART=ok
TUNNEL_BOX_ISOLATION=ok
```

The SSH test passes only after the OpenSSH client authenticates with its
ephemeral key and the guest command returns:

```text
BOXLITE_SSH_CONNECT_OK
```

## Troubleshooting

| Symptom                                            | Check                                                                                                           |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Node test is skipped                               | Confirm `npx` exists and `sdks/node/native`, `dist`, or `npm` contains a `.node` binding                        |
| SSH test is skipped                                | Install the OpenSSH client tools so `ssh` and `ssh-keygen` are available                                        |
| SSH guest setup fails                              | Inspect the captured `apt-get` or `/tmp/sshd-2222.log` output; confirm the guest can reach package repositories |
| CONNECT succeeds but the stream closes immediately | Check whether the Box auto-paused or stopped; this is the currently recorded stopped-Box gap                    |
| Response disappears after `shutdown_write()`       | This is the strict half-close `xfail`                                                                           |
| Endpoint is an integer in cloud mode               | The SDK used the local FFI runtime instead of `Boxlite.rest(...)`                                               |
| Endpoint is a URL in local mode                    | The local test was accidentally configured with a REST runtime                                                  |
| Node reports cross-port or cross-Box markers       | Inspect Proxy target parsing and Runner routing before changing the test                                        |

## Current Gaps

The current suite does not yet prove:

- direct browser navigation to a preview URL;
- private-Box browser authentication;
- native BoxLite SSH through the SSH gateway/session service;
- successful automatic resume of a stopped Box on CONNECT;
- correct end-to-end TCP half-close propagation;
- C or Go SDK data-plane integrity against dev.

Add new coverage to the narrowest existing layer, but keep at least one remote
E2E whenever behavior crosses API, Proxy, Runner, and guest boundaries.
