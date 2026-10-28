# Preview and network E2E coverage

The [POL-1221 matrix](https://linear.app/polygala/issue/POL-1221/e2e-fix-preview-and-tunnel-tests-cover-private-access-revocation-and)
tracks acceptance for private previews, revocation and runtime network policy.
These cases use the real REST API, proxy, runner and guest. A direct WebSocket
upgrade and a raw CONNECT are distinct entrances; WebSocket inside an SDK
CONNECT does not stand in for the direct proxy path.

## Implemented cases

| Area | Cases | Assertions |
| --- | --- | --- |
| Inbound/public | `test_box_management.py`, `test_preview_access.py` | Default disabled; prepare rejected when disabled; declared public port reaches the guest; undeclared port 404; disabling declared access 403 |
| Private identity | `test_preview_access.py` | Token, platform authorization and bearer access over HTTP/WS/CONNECT; absent/incorrect credentials rejected; masked repeat prepare; conflicting mode rejected; tokens and cookies isolated across ports and boxes |
| Session protocol | `test_private_tunnel.py` | Explicit bad proof cannot fall back to a cookie; ambiguous proofs 400; exact-origin cookie checks; platform credentials and token Referer stripped; application credentials retained; reserved guest cookies removed |
| Revoke | `test_tunnel_revoke.py` | Public/private new access denied; other port unaffected; idempotence; token rotation invalidates old cookie/token; existing WS/TCP remains usable; revoke works while stopped or inbound-disabled |
| Lifecycle | `test_preview_lifecycle.py` | Authorization before wake; explicit no-auto-resume rejection; declaration/session survive restart; keep-alive requests reauthorize; SDK forward cannot silently re-prepare; deletion invalidates URI; denied declarations do not wake |
| Chromium | `test_preview_browser.py` | Real HTTPS cookie storage and attributes; HttpOnly; page/subresource/fetch/same-origin WS; reload without token; no platform credentials in guest echo |
| Outbound | `test_network_egress.py`, `test_network_updates.py` | Healthy controls; runtime disable/re-enable; full allowlist replacement; process identity preserved; API get/list and SDK handle readback; restart persistence; no-NIC/stopped rejection; invalid create/update input; HTTP Host, wildcard TLS, IPv4 and CIDR |
| SDK and CLI | `test_sdk_tunnel.py`, `test_node_tunnel.py`, `test_cli_network.py` | Framed HTTP, exact WS echo, concurrent/large transfers and lifecycle; private access/revoke; Node and CLI live policy update/readback; CLI private descriptors consumed through all three proxy entrances; CLI forwarding cannot undo revoke |
| Harness only | `test_network_harness.py` | Missing/failed probes fail; HTTP does not wait for TLS EOF; complete wrong responses cannot match half-close xfail; Node rejects missing/wrong WS echo; redirects do not change the probe destination; rule probes reject mismatched IPv4/TLS targets |

Each guest gets a unique marker and cleanup is registered before preparing
tunnels. Reachability polls after revocation use the existing URI. They never
call prepare, which would undo the operation under test. The three-second
authorization-cache window has a one-second request-scheduling allowance;
a late successful rejection still fails the timing check.

Egress probes return a complete JSON record and a successful exit status.
Timeout/refusal/transport EOF can count as blocked only with an unrestricted
positive control; certificate errors, invalid output and exec failures cannot.
The guest probe bounds DNS in a subprocess because a socket timeout does not
bound DNS when runtime-disabled suspends the NIC. It does not follow redirects:
for example, an IP endpoint redirecting to a hostname proves the IP was reached,
not that the second hostname is permitted.

## Run against current source

Start [infra-local](../infra-local/README.md), including its object-storage
dependency. Use the same API-key/profile discovery as the other cloud cases:

```bash
export BOXLITE_E2E_API_URL=http://localhost:3001/api
export BOXLITE_E2E_API_KEY=local-dev-admin-key
export BOXLITE_E2E_RUNNER_LOG="$PWD/.apps-local/logs/runner.log"
make test:rest:e2e AUTH=api-key FILTER='preview or private_tunnel or tunnel_revoke or network_updates or network_egress or sdk_tunnel or node_tunnel or cli_network or inbound_mode'
make test:rest:e2e FILTER=network_harness
```

Set the actual runner log path when reusing infrastructure from another
worktree. Build the Node SDK with `make dev:node` and the CLI with `make cli`;
set `BOXLITE_E2E_CLI` to the built CLI path. Missing SDK/CLI builds are reported
as skipped coverage. Cloud CI continues to use its stage-specific secrets
from `.github/workflows/e2e-cloud.yml`; an unrelated ambient `BOXLITE_API_KEY`
is not a substitute for those E2E credentials.

Use a resolvable preview domain. Some host DNS proxies rewrite wildcard-IP
domains; a local `*.e2e.localhost` endpoint avoids that on supported systems.
The API's `PROXY_DOMAIN`/`PROXY_PROTOCOL` and proxy protocol must agree. Run
current API/Proxy/Runner/SDK code and record revisions. A deployed older server
failing a new contract is not proof that the case is incorrect.

Probe destinations can be overridden with `BOXLITE_E2E_EGRESS_ALLOWED_URL`,
`BOXLITE_E2E_EGRESS_UNLISTED_URL`, `BOXLITE_E2E_EGRESS_WILDCARD_URL` and
`BOXLITE_E2E_EGRESS_IP_URL`. The first two must name different hosts; the
wildcard target must use HTTPS and a subdomain, and the IP target must use an IPv4 literal.
Use controlled endpoints when available. An unavailable control fails the run.

## Optional prerequisites and outstanding acceptance

For the real browser lane, configure an HTTPS preview endpoint and Chromium:

```bash
export BOXLITE_E2E_BROWSER=1
export BOXLITE_E2E_BROWSER_EXECUTABLE=/path/to/chromium
make test:rest:e2e FILTER=preview_browser
```

This uses the Node SDK's existing `playwright-core` dependency and a fresh
browser context. For an isolated local certificate only,
`BOXLITE_E2E_BROWSER_LOCAL_CA=1` lets Chromium accept that certificate; Python
and SDK probes still require their normal CA configuration (for example
`SSL_CERT_FILE`). The lane rejects HTTP because it cannot validate Secure
cookie behavior. Browser OIDC login and expiry are separate outstanding work.

`BOXLITE_E2E_READONLY_PROFILE` and `BOXLITE_E2E_FOREIGN_PROFILE` name dedicated
profiles in the shared credentials file. The former must belong to the owner
organization and lack `write:boxes`; the latter must belong to another org.
Their absence produces explicit skips, not successful identity coverage.

The tracking issue remains open for these matrix entries:

- OIDC browser login, foreign-org JWT and membership-removal behavior.
- Denied requests leaving access-activity timestamps unchanged. Current
  lifecycle cases prove that the guest stays stopped, not this separate effect.
- Real-browser sibling-origin fetch/POST/WebSocket rejection. Current origin
  checks send explicit HTTP/WS headers; Chromium coverage is same-origin only.
- Real one-hour session expiry/renewal and 30-second OIDC handoff expiry/replay.
  The long lane needs a timeout beyond the existing cloud job's 35 minutes.
- Controlled TCP/UDP egress, existing-flow policy boundaries, redirect/DNS
  bypass checks and secret-host exceptions.
- Isolated runner/persistence fault injection, concurrent updates and audit
  verification; old-server capability rejection before POST; remaining SDKs.
- An OIDC-authenticated run of the full matrix.

Do not replace these entries with mocked successes or infer them from a green
HTTP/token run. `skip`, `xfail`, and unrun cases are not accepted coverage.
The known half-close failures stay isolated; TLS-shutdown xfails apply only
to the precise post-response EOF signal on a remote stage.

## Outbound combination regression

Before the shared validation fix, create with
`{"network":{"outbound":{"mode":"disabled","allow_net":["example.com"]}}}`
returned 201 while the corresponding update returned 400. Create and update
now share the combination check and reject this input before side effects.
The regression covers nested and deprecated flat creation, verifies that no
box remains after rejection, and accepts disabled with omitted or empty rules.
The API and Runner fix is the production change accompanying these cases.

The CLI forwarding case also fails before revoke: the private descriptor's
preview returns the guest marker, but the CLI's local `--listen` connection
closes without an HTTP response. This reproduces with HTTP and HTTPS preview
endpoints; Python forwarding passes. The CLI case remains a failing regression
pending diagnosis, rather than accepting an arbitrary connection error.
