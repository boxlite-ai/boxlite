# FastMCP Box prototype

This prototype uses TypeScript `fastmcp@4.24.3` inside the existing Nest API.
It exposes six tools: `list_boxes`, `get_box`, `create_box`, `start_box`,
`stop_box`, and `delete_box`. It does not expose executions, file transfer,
images, volumes, or plugin submission assets.

## Request path

```text
MCP client -> /api/mcp OAuth guards -> FastMCP generated tool
  -> bounded loopback REST adapter -> existing REST controller -> service
```

`mcp-server.ts` selects OpenAPI operation IDs and uses `fromOpenAPI` to generate
schemas and request serialization. Its single registration wrapper supplies
annotations, invocation context and errors. Adding a similar operation means
selecting its operation ID, without copying its controller logic.

`mcp-rest.ts` forwards the caller's bearer to this API's bound loopback port.
It resolves the user's default organization; clients cannot select a host or
organization through tool arguments. REST rechecks authentication and resource
permissions, DTO validation, commerce limits and audit. AsyncLocalStorage keeps
concurrent calls' credentials and organizations separate.

The source OpenAPI contract is unchanged. An in-memory projection removes the
routing-only `prefix` path parameter. FastMCP preserves referenced request bodies
under `body`; inline body schemas may be flattened by the framework.

```json
{ "name": "create_box", "arguments": { "body": { "image": "python:3.12-slim" } } }
```

List/get are read-only and nondestructive. Mutations are conservatively marked
destructive. Creation advertises open-world behavior because it can fetch an image.
There is no general Box update operation in the REST contract.

## OAuth server configuration

Set `MCP_RESOURCE_URL=https://<api-host>/api/mcp` and the normal
`OIDC_ISSUER_BASE_URL` / `OIDC_AUDIENCE` settings. HTTP is accepted for loopback
resource URLs only. The issuer is the authorization server; the MCP resource is
the intended token audience, and these identifiers need not be equal.

`GET /.well-known/oauth-protected-resource/api/mcp` publishes the resource and
issuer. Missing credentials receive a 401 challenge pointing to that metadata.
Without `MCP_RESOURCE_URL`, discovery returns 404 and MCP user authentication is
disabled. Challenges use configured URLs, never the request Host header.

Auth0 or the configured OAuth provider owns login, consent, registration and token
issuance. An MCP JWT must identify an existing BoxLite user; an Auth0 database
account must already have verified email in BoxLite. MCP authentication does not
create users or rewrite their profiles. API keys, machine credentials and
REST-only audiences cannot call this endpoint. An Origin header is rejected.

MCP bearer tokens also work at REST because the internal hop forwards them.
They retain the user's existing REST authority; this six-tool catalog does not
restrict direct REST access or add new resource permissions.

## Client registration

Configure the client's redirect URI and registration method at the OAuth provider,
then connect a legacy MCP client to `https://<api-host>/api/mcp`. Clients still
perform `initialize`; this prototype supports handshake-based revisions through
2025-11-25. Newer protocol support is outside this experiment.

DCR/CIMD availability and third-party consent depend on the provider configuration;
this module does not implement a registration endpoint. Client secrets belong to
the client/provider configuration and are never embedded in tool headers or source.

## Results and bounds

Successful JSON is validated against the generated OpenAPI response schema and
returned as structured content plus JSON text. Empty deletion success is
`{"status":204}`. The advertised output schema also permits a common error:

```json
{
  "error": {
    "source": "rest",
    "code": "http_error",
    "message": "Quota unavailable",
    "status": 403,
    "details": { "message": "Quota unavailable", "statusCode": 403 }
  }
}
```

Errors set `isError: true`. REST fields are preserved under `details`; adapter
failures use stable codes such as `invalid_response`, `response_too_large`,
`request_failed`, and `request_cancelled`. The explicit output union is necessary
because this FastMCP version validates error structured content too.

REST responses are capped at 128 KiB while reading, with a 35-second request
deadline, no redirects and no retries. Disconnects abort in-flight HTTP work.
Each POST has a fresh transport/session; GET, HEAD and DELETE return 405.
A separate `notifications/cancelled` POST cannot cancel another POST's session.
Timeout or disconnect does not prove a mutation was rolled back: query state
before retrying creation or deletion.

The hosted REST implementation currently ignores list pagination/status,
stop `timeout_seconds` and delete `force`. Generated input schemas expose these
parameters but do not implement missing controller behavior.

## Verification

From the repository root:

```sh
make _ensure-apps-deps INSTALL_APPS_DEPS=1
make build:apps PROJECTS=api
make test:apps:api TEST_FILES='src/mcp/|auth/jwt.mcp.spec.ts|auth/auth.module.spec.ts'
```

HTTP tests use actual Nest controllers, Passport JWT verification, a temporary
JWKS server and FastMCP's real transport. Domain services are test doubles;
these tests do not boot a Box or complete an Auth0 browser login. They cover the
six tools, structured REST failures, concurrent identities, permission checks,
input validation and session cleanup. Adapter tests cover response size,
redirect refusal, disconnect cancellation and the real timeout.

The unused standalone `mcp-proxy` listener is mapped to a shared stub in the API's
CommonJS Jest configuration, covering both MCP and `AppModule` importers; Nest owns
the HTTP socket. The stub throws if invoked. `xsschema` and the reference parser
are transformed for Jest.
The production server loads the actual published packages.

Real runtime acceptance additionally requires `make -C apps/infra-local up`,
a fresh MCP-audience user token, and create/list/get/stop/start/delete against
that stack. An expired token or failed infrastructure startup does not count as
completed acceptance.
