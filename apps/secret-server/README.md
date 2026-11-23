## TL;DR

The internal encryption package protects secret values and routing policy with per-write data keys and a replaceable key provider. The internal attest package tells the Secret Server which runner a request came from.

## Scope

This Go module contains encryption, runner attestation, server configuration,
write authentication, a fetch handler, database initialization, and a migration
command. The HTTP server entry point and deployment resources are not yet included.
The existing API encryption service and stored values remain unchanged.

Design: [envelope encryption and KeyProvider](https://github.com/boxlite-ai/boxlite/issues/2495).
Routing metadata follows the [headers map contract](https://github.com/boxlite-ai/boxlite/issues/2467).

## Server configuration and write authentication

The service configuration and write authentication middleware are available for
the server skeleton. Google mode validates token signature, audience, expiry,
issuer, verified email, and the caller allowlist. Dev mode uses an exact bearer
token and is permitted only in local and dev environments. The server entry
point and routes are delivered separately.

Google-mode bearer tokens with signatures shorter than 32 bytes are rejected
before validation; signatures and claims still require verification. `PORT` must
resolve to a nonzero TCP port so the service does not silently select one.

## Calling the package

The future application configuration layer reads `SECRET_MASTER_KEY_ID` and
`SECRET_MASTER_KEY_BASE64`, then passes both strings to `NewEnvKeyProvider`.
The package does not read process environment itself.

```go
provider, err := encryption.NewEnvKeyProvider(keyID, encodedKey)
if err != nil {
    return err
}
cipher, err := encryption.NewCipher(provider)
if err != nil {
    return err
}
identity := encryption.SecretContext{
    OrganizationID: organizationID,
    SecretID:       secretID,
    Version:        1,
    Hosts:          []string{"api.example.com"},
    Headers:       map[string]string{"Authorization": "Bearer {value}"},
}
envelope, err := cipher.Encrypt(ctx, identity, value)
```

The provider requires a canonical standard Base64 encoding of exactly 32 random
key bytes. IDs start with `env:`, followed by ASCII letters, digits, `.`, `_`, or
`-`, with a maximum total length of 128 bytes. There is no default key.
Construct the provider and cipher before serving requests; their zero values are
not configured instances. Configure one master key for development/staging only.

`Encrypt` creates a new 32-byte DEK on every call, even for identical inputs.
`Decrypt` unwraps the saved DEK and authenticates the value before returning it.
An authorized service caller supplies the context for both operations.

```text
value + identity + policy -- DEK --> value ciphertext
DEK + identity + key ID -- master key --> wrapped DEK
```

Map `Envelope.Ciphertext` to `ciphertext`, `WrappedDEK.Ciphertext` to
`encrypted_dek`, and `WrappedDEK.KeyID` to `key_id`. Ciphertext fields are binary;
the service owns database transactions and transport encoding.

## Authenticated context and format

IDs use standard dashed UUID text, accepting either letter case. Versions range
from 1 through 2147483647. UUIDs become 16-byte values; versions use uint32 big-endian.

Hosts must be nonempty with no empty entries. ASCII lowercasing, bytewise sorting,
and deduplication produce the canonical host set; wildcard syntax is preserved.
No DNS lookup, whitespace trimming, trailing-dot removal, or IDNA conversion occurs.

Headers must be an explicit nonempty map with valid HTTP token names. Names are
ASCII-lowercased and sorted bytewise. Duplicate canonical names fail even with
identical templates. Templates remain byte-exact, including whitespace and case.
The transport must reject exact duplicate object keys before converting to a map.

```text
identity = org_uuid[16] || secret_uuid[16] || version_u32be
string(s) = byte_length_u32be || bytes(s)
hosts = count_u32be || string(host_1) || ... || string(host_n)
headers = count_u32be || string(name_1) || string(template_1) || ...
value_aad = "boxlite.secret.value.v1\0" || identity || hosts || headers
dek_aad = "boxlite.secret.dek.v1\0" || identity
env_wrap_aad = dek_aad || string(key_id)
sealed = 0x01 || nonce[12] || encrypted_bytes || tag[16]
```

Value ciphertext is plaintext length plus 29 bytes. Environment-wrapped DEKs are
exactly 61 bytes. Unknown format versions and malformed records fail without fallback.
Changing an authenticated destination, header membership, or template causes
decryption to fail. Equivalent case/order changes and repeated hosts remain valid.

The service owns secret-value size limits, host policy, prohibited header names,
template syntax, and rendered-value validation. Resolve omitted headers to
`{"Authorization": "Bearer {value}"}` before calling this package. Never invent
defaults while reading encrypted records: reconstruct the original effective policy.
Return exactly the authenticated metadata to the runner, without rereading it.
AAD does not provide authorization or prevent rollback of an entire historical record.

## Errors and key lifecycle

Use `errors.Is` with `ErrInvalidInput`, `ErrUnknownKey`, `ErrAuthentication`,
`ErrProviderUnavailable`, `context.Canceled`, and `context.DeadlineExceeded`.
Unexpected provider errors are masked, so upstream messages cannot leak values or keys.
Failures return no partial plaintext. There is no plaintext compatibility fallback.

Providers must support concurrent calls and return independently owned buffers.
Callers must not concurrently mutate inputs. Temporary DEKs are cleared after use,
without a guarantee that every Go runtime copy is erased.

Each DEK encrypts one value. The environment master key wraps many DEKs; Go's
random-nonce GCM limit is 2^32 encryptions per key across all uses. There is no MVP
usage counter. DEK generation uses Go 1.25's
[`crypto/rand.Read`](https://pkg.go.dev/crypto/rand@go1.25.4#Read): it fills the buffer
or terminates the process on entropy failure; it cannot return a provider error.

Master-key rotation is not supported yet. Once encrypted data exists, do not change
`SECRET_MASTER_KEY_ID` or `SECRET_MASTER_KEY_BASE64`: changing the ID makes existing
versions fail with `ErrUnknownKey`; changing only the key material makes them fail
with `ErrAuthentication`. `EnvKeyProvider` holds only one key, and the package does
not expose a rewrap operation.

A future change will add a rewrap API or a keyring provider that routes by key ID.
The envelope format allows rewrapping a DEK without changing the value ciphertext,
but KMS, provider routing, and migration jobs are not implemented here.

## Database migrations

Set `DATABASE_URL` to the separate PostgreSQL database and run
`secret-server migrate`. The command applies embedded goose migrations under a
PostgreSQL session lock, with a two-minute deadline. Run it with an account that
can create schema objects. Migrations are forward-only; deployed application
versions must tolerate compatible schema changes. The database must use UTF-8
server encoding. SIGINT and SIGTERM cancel a running migration.

Before serving requests, the future service must call `database.Initialize`.
It applies migrations and verifies a durable encrypted canary under a separate
transaction advisory lock. If the canary is absent but secrets exist, it first
decrypts an existing secret using AAD version 1.

A wrong key or corrupt ciphertext fails readiness.
Each secret stores one immutable encrypted value; replace a value by deleting and
creating a secret with a new ID. Online rotation and version history are not supported.

Canary enrollment uses a read-committed transaction even when the database has a
different default isolation level.
## Runner attestation

Design: [runner attestation with gcp_iit](https://github.com/boxlite-ai/boxlite/issues/2623).

A runner VM requests an instance identity token from its metadata server with
`audience=<Secret Server URL>&format=full` and sends it in
`X-Boxlite-Runner-Identity`. The API cannot mint such a token, so the
`runner_id` the fetch route gets cannot be forged by a compromised API.

```go
selector, err := attest.New(attest.Config{
    Attestors:   []string{"gcp_iit"},
    Environment: "staging",
    GCPIIT: attest.GCPIITConfig{
        Audience:       secretServerURL,
        Project:        "boxlite-staging",
        ServiceAccount: runnerServiceAccount,
    },
    Registry: `{"gcp_iit": {"4257000000000000001": "rnr_a"}}`,
}, googleVerifier, logger)
runnerID, err := selector.Verify(ctx, r.Header)
```

`googleVerifier` comes from `attest.NewGoogleTokenVerifier(ctx, nil)`.
Every error from `New` must fail startup. The service skeleton reads these
values from `SECRET_SERVER_ATTESTORS`, `SECRET_SERVER_AUDIENCE`,
`SECRET_SERVER_GCP_PROJECT`, `SECRET_SERVER_RUNNER_SERVICE_ACCOUNT`, and
`SECRET_SERVER_RUNNER_REGISTRY` once it lands; this package does not read the
environment.

| `Verify` result | Meaning | Fetch route answer |
| --- | --- | --- |
| `runnerID, nil` | Proof valid; instance registered | Continue to introspection |
| `errors.Is(err, attest.ErrInvalidProof)` | Missing, ambiguous, or rejected proof | 401 `attestation_failed` |
| any other error | Google signing keys unreachable | 503; the runner retries |

- **Selection.** The selector calls the one enabled attestor whose header is
  present. No proof header, or headers for two attestors, is an invalid proof.
- **gcp_iit checks.** The `idtoken` library checks signature, `aud`, and
  `exp`. This package checks `iss`, `iat` at most 60 seconds ahead, `email`
  and `email_verified`, the Compute Engine `project_id`, and that
  `instance_id` is in the registry's `gcp_iit` section.
- **Registry.** JSON `{mode: {machine_id: runner_id}}`, written by hand for
  staging. Unknown modes and empty IDs fail startup. An empty `gcp_iit` map,
  or a map for a disabled attestor, logs a warning.
- **dev attestor.** Reads `X-Boxlite-Dev-Runner` and is refused unless
  `ENVIRONMENT` is `local` or `dev`. It rejects runner IDs registered under
  another mode.
- **Logging.** Rejection reasons name the failed check, never token content.
  Callers log the error and return only the problem code.

Known limitations: a captured token can be replayed until it expires, about
an hour; the zone is not checked; the registry is written by hand.

## Verification

Run from the repository root with Go 1.25.4 or newer:

```sh
make test:apps:secret-server
make test:apps:secret-server:integration
make coverage:apps:secret-server:integration
make lint:apps:secret-server
make fmt:apps:secret-server
make test:apps:secret-server GOTEST_FILTER='-fuzz=FuzzDecryptEnvelope -fuzztime=5s -parallel=2'
```

The unit test target runs with the race detector and `GOWORK=off`. The integration
target requires infra-local PostgreSQL and permission to create a temporary database.
It defaults to port 25432; override `SECRET_TEST_DATABASE_URL` when needed. It
creates a uniquely named database and drops it after the test.
The coverage target runs the same tests and writes `target/coverage/secret-server-integration.out`.
Database and command tests share the temporary database setup and cleanup helper.
It also checks that SIGTERM cancels the migration command while it waits for a lock.
CI runs the same integration target against a PostgreSQL 17 service on Ubuntu,
including on draft PRs when Go-related files change. This checks database behavior;
the infra-local BoxLite VM still needs separate local verification.
The Nx test target delegates to the same make target for workspace test discovery.
Nx caching is disabled for this target because the workspace default inputs exclude
Go test files. Every invocation reaches Go, whose own test cache tracks test changes.
The Go CI job selects Secret Server source and test changes and runs this package
through `make coverage:go` with the race detector and `GOWORK=off`. It uploads
`target/coverage/secret-server.out` to Codecov alongside the other Go reports.
Tests cover real environment-key encryption, tampering, policy canonicalization,
key selection, provider errors, cancellation, and concurrent use. An internal test
checks the envelope format's rewrap compatibility; it does not expose rotation to callers.
Boundary tests reject malformed UUID hex and non-AES-256 keys, and cancel at
explicit context checkpoints after cryptographic operations to verify that no
result is released. These checkpoints avoid timing-dependent sleeps.
Fuzzing covers malformed envelope decoding; it is not a cryptographic proof.

On Linux, CI preserves the full-suite report when it adds nested runtime coverage.
Database rollback and migration lock cleanup have bounded waits; a connection
with a failed migration unlock is discarded.

The test helper verifies the database name before tests run, even if the URL includes
database query parameters. Canary enrollment reads back the persisted ciphertext.
The test database URL also accepts pgxpool options such as `pool_max_conns`.

Go reports statement coverage; Codecov also distinguishes partially covered source
lines, so a passing statement percentage does not imply passing patch coverage.
The uint32 framing overflow guards remain in place; tests do not allocate multi-GiB
inputs merely to exercise those guards.

Attestation tests sign tokens with a locally generated RSA key and serve it as
a fake Google key set to the real `idtoken` adapter, so no network is needed.
Verifying real Google tokens is planned for staging.

This is a new contract with no equivalent on the base branch. Full-revert defect
proof is not applicable; positive, negative, and boundary tests exercise the new code.

## Fetching authorized secrets

The `internal/fetch` handler implements
[credential redemption](https://github.com/boxlite-ai/boxlite/issues/2724).
It depends on the single-value database foundation in #2612, including the
existing attestation and encryption packages. Migration 2 extends access-log
results while preserving version-1 data. There is no secret version in grants,
responses or audit rows; decryption always uses AAD version 1.

After `database.Initialize`, construct the handler with the configured cipher,
attestation selector and the **full internal introspection URL**:

```go
handler, err := fetch.New(pool, cipher, selector,
    "http://api-internal/internal/v1/credentials/introspect", logger)
if err != nil {
    return err
}
mux.Handle("/internal/v1/fetch", handler)
```

The service skeleton (#2570) must mount this route only for roles `fetch` and
`all`, outside write-caller authentication middleware. This module still has
only the migration command; the handler does not introduce a second service
startup implementation. The caller owns pool shutdown and the verifier settings.

A runner posts `{"credential":"bxsc_..."}` with its attestation proof header.
The handler verifies identity before contacting the API, then sends
`{"token":"bxsc_...","runner_id":"..."}`. The API owns atomic consumption
and runner binding (BUI-1385); the client makes one request with a three-second
limit and never follows redirects, retries or caches authorization.
The MVP API route has no caller authentication and must remain internal-only.

```text
proof -> consuming introspection -> check all organizations and box scopes
      -> decrypt all values -> audit -> complete response
```

An active reply must contain credential, organization, runner and box IDs,
an unexpired RFC3339 expiry and unique secret grants. The returned runner must
match the verified identity. Missing or disabled rows reject the entire request;
box-scoped secrets must match both organization and box. Decryption reconstructs
AAD from stored IDs, hosts and headers. A late failure returns no partial values.

Success is `{"box_id":"...","secrets":[{"name":"...","value":"...",
"hosts":["..."],"headers":{"Authorization":"Bearer {value}"},
"placeholder":"..."}]}`. Empty grants return `secrets: []`.
Every response carries `Cache-Control: no-store`; errors use RFC 9457 with `code`.

| Failure | HTTP / code | Audit result |
| --- | --- | --- |
| Invalid proof | 401 / `attestation_failed` | `attestation_failed` |
| Verifier outage | 503 / `attestation_unavailable` | `attestation_unavailable` |
| Inactive credential | 401 / `credential_invalid` | `credential_invalid` |
| Runner mismatch | 401 / `credential_invalid` | `runner_mismatch` |
| Organization or box mismatch | 401 / `credential_invalid` | `scope_mismatch` |
| Missing or disabled secret | 409 / `secret_unavailable` | `not_found` / `disabled` |
| API failure or malformed answer | 503 / `api_unavailable` | `api_unavailable` |
| Storage failure or resource limit | 503 / `store_unavailable` | `store_unavailable` |
| Decryption failure | 503 / `decrypt_failed` | `decrypt_failed` |

Disabled errors include the authorized name; a deleted secret has no name to
return. Inactive reasons are known only to the API. Attestation failures never
consume credentials; failures after successful introspection leave them consumed.

Resource bounds are 4 KiB request bodies, 64 KiB API replies, 64 grants,
64 KiB ciphertext, 128 KiB serialized stored rows, 8 MiB success JSON and
16 concurrent fetch operations. A single SQL statement suppresses oversized
stored payloads before transfer. No unbounded request queue is created.

Audit attempts use a separate 100 ms context for the complete outcome, with at
most 16 concurrent audit operations. Success records one row per secret; empty
success and failure record one row. Unknown identifiers remain null.
Audit failures preserve the response outcome, emit a fixed error log and increment
`Handler.AuditFailures()` for telemetry collection. Credentials, proofs, values,
templates, placeholders and raw upstream errors are never logged.

Tests use a consuming HTTP fake for the API and real envelope encryption.
They cover identity ordering, replay, concurrent consumption, ownership, late
failures, redirect refusal, timeout, limits and audit failures. The PostgreSQL
integration target includes real fetch queries, audit constraints and schema
upgrade preservation; staging integration with the real API remains pending.
It also combines the production local/dev attestation selector with HTTP and
PostgreSQL to check allowed organization/box access, rejected foreign ownership,
and missing-proof rejection before API contact. This does not exercise real GCP
tokens or replace staging identity verification.

### Credential API contract integration

`make test:apps:secret-server:credential-api` runs the actual service, controller
and migration from API PR #2769 at commit
`bd10e984f00758222bfe6724fa3994a17c8e1329`, with the Go fetch handler and real
PostgreSQL. The harness reads these files from Git into a temporary directory;
it does not change the API checkout or implement a second credential service.

Prerequisites: the pinned commit must be available locally (`git fetch origin
pull/2769/head`), Node.js, installed apps dependencies (`make _ensure-apps-deps`),
Go, and a disposable PostgreSQL instance allowing database creation.

```sh
SECRET_TEST_DATABASE_URL=postgresql://boxlite:boxlite@127.0.0.1:25432/boxlite \
  make test:apps:secret-server:credential-api
```

`NODE_PATH` may point to an existing apps dependency installation; otherwise the
target uses this worktree's `apps/node_modules`. The harness creates a temporary
API schema and a separate secret database, then removes both. Its loopback-only
issuance fixture invokes the real service; it is not a production API endpoint.

The test verifies wrong-runner rejection without consumption, successful
redemption and decryption, replay rejection, and persisted audit outcomes. A
missing or skipped Go test fails the harness. This validates the pinned API
contract in an isolated Nest application, not full API startup, ingress controls,
service deployment, or GCP attestation. Those checks remain pending.
