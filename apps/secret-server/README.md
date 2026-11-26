## TL;DR

The internal encryption package protects secret values and routing policy with per-write data keys and a replaceable key provider. The internal attest package tells the Secret Server which runner a request came from.

## Scope

This Go module contains `internal/encryption`, `internal/server`,
`internal/attest` ([runner attestation](#runner-attestation)), and a Secret
Server skeleton with database initialization and a migration command. Write and
fetch business endpoints and deployment resources are not yet implemented.
The existing API encryption service and stored values remain unchanged.

## Server skeleton

Set `SECRET_SERVER_ROLE` to `write`, `fetch`, or `all`; set `ENVIRONMENT`,
`DATABASE_URL`, `SECRET_MASTER_KEY_ID`, `SECRET_MASTER_KEY_BASE64`, and
`SECRET_SERVER_AUTH_MODE`. Google mode requires `SECRET_SERVER_AUDIENCE` and,
for write or all roles, `SECRET_SERVER_ALLOWED_CALLERS`. Dev mode requires
`SECRET_SERVER_DEV_TOKEN` and is limited to local and dev environments. The
environment key provider is rejected in production.

The write route group validates Google ID tokens and permits only verified emails
on the allowlist. The fetch route checks Runner proof in `fetch` and `all` roles.
The current business handlers are placeholders that return 404 after authentication.

`/health` is liveness and `/ready` checks database connectivity. Startup also
performs an encryption round trip.

Startup applies migrations and verifies the durable encrypted canary before the
server listens. A failed migration or key check prevents startup and readiness.
Startup and the standalone `migrate` command each allow up to two minutes,
including any wait for the migration lock.

If token validator initialization fails, startup closes the database pool and
returns an error before opening the listener.

The server caps the PostgreSQL pool at 10 connections and honors a lower
`pool_max_conns` in `DATABASE_URL`. Without that option, the pgx default
applies up to the cap.

`SHUTDOWN_TIMEOUT_SEC` bounds HTTP draining and database cleanup together.
On a shutdown signal or a permanent listener error, the server stops accepting
connections and drains active requests.

If the deadline expires, the server closes any remaining HTTP connections and
stops waiting for the database pool. Pool cleanup can continue until the process
exits. A permanent listener error remains part of the returned error even if
cleanup times out.

Request logging and OpenTelemetry integration remain open under [#2570](https://github.com/boxlite-ai/boxlite/issues/2570);
the current service emits only startup and recovery logs. Configuration uses explicit
environment parsing and validation to keep errors limited to variable names and avoid
exposing secret values; it does not use envconfig or validator.

For a local run, supply a persistent development key, database URL, and dev token
through the environment, then run `make run:apps:secret-server`. The role defaults
to `write`; set `SECRET_SERVER_ROLE=fetch` to select fetch. The local target defaults
to the `dev` attestor. Do not commit or print the key or token.

The local database must use the same key across restarts.

To exercise startup and readiness against a disposable PostgreSQL database, set
`SECRET_TEST_DATABASE_URL` and run `make test:apps:secret-server`. Integration
tests are skipped by the general test target when this variable is absent.

The dedicated `test:apps:secret-server:integration` and
`coverage:apps:secret-server:integration` targets fail without it. The
configured user must be able to create and drop temporary databases.

Design: [envelope encryption and KeyProvider](https://github.com/boxlite-ai/boxlite/issues/2495).
Routing metadata follows the [headers map contract](https://github.com/boxlite-ai/boxlite/issues/2467).

## Server configuration and write authentication

The service configuration and write authentication middleware are available for
the server skeleton. Google mode validates token signature, audience, expiry,
issuer, verified email, and the caller allowlist. Dev mode uses an exact bearer
token and is permitted only in local and dev environments.

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

Before serving requests, the service calls `database.Initialize`.
It applies migrations and verifies a durable encrypted canary under a separate
transaction advisory lock. If the canary is absent but secrets exist, it first
decrypts an existing secret using AAD version 1.

A wrong key or corrupt ciphertext prevents startup.

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

In `fetch` and `all` roles, startup requires `SECRET_SERVER_ATTESTORS`, a
comma-separated list of enabled attestors. The `gcp_iit` attestor uses
`SECRET_SERVER_AUDIENCE`, `SECRET_SERVER_GCP_PROJECT`,
`SECRET_SERVER_RUNNER_SERVICE_ACCOUNT`, and `SECRET_SERVER_RUNNER_REGISTRY`.
Invalid attestation configuration prevents startup before the listener opens.

| `Verify` result | Meaning | Fetch route answer |
| --- | --- | --- |
| `runnerID, nil` | Proof valid | Continue to the fetch handler (currently a 404 placeholder) |
| `errors.Is(err, attest.ErrInvalidProof)` | Missing, ambiguous, or rejected proof | 401 `attestation_failed` |
| any other error | Google signing keys unreachable | 503; the runner retries |

- **Selection.** The selector calls the one enabled attestor whose header is
  present. No proof header, or headers for two attestors, is an invalid proof.
- **gcp_iit checks.** The `idtoken` library checks signature, `aud`, and
  `exp`. This package checks `iss`, `iat` at most 60 seconds ahead, `email`
  and `email_verified`, the Compute Engine `project_id`, and that
  `instance_id` is in the registry's `gcp_iit` section.
- **Registry.** JSON `{mode: {machine_id: runner_id}}`, written by hand for
  staging. With `gcp_iit` enabled, an unset or blank registry fails startup.
  An explicit `{}` allows startup and logs a warning that no GCP runners can
  authenticate.

- **Registry entries.** Unknown modes and empty IDs fail startup. Entries
  for a disabled attestor log a warning.
- **dev attestor.** Reads `X-Boxlite-Dev-Runner` and is refused unless
  `ENVIRONMENT` is `local` or `dev`. It rejects runner IDs registered under
  another mode.
- **Errors.** The fetch route returns a fixed problem code without token or
  verifier error details.

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
target requires PostgreSQL and permission to create a temporary database. Set
`SECRET_TEST_DATABASE_URL` before running either dedicated integration target.
Tests create uniquely named databases and drop them afterward.
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
